// Provider adapters. Wire formats are supported -- Anthropic Messages and
// OpenAI-compatible Chat Completions -- both streamed (SSE) with vision and
// tool use. The app's neutral Message[] model (state/types.ts) mirrors
// Anthropic's content blocks; the OpenAI path down-converts.

import type { Block, ChatConfig, ImageBlock, Message, ReasoningDetailType, Settings, TextBlock, ThinkingBlock } from "../state/types.ts";
import type { AssistantTurn, StreamEvent, StreamOptions, ToolDef, Usage } from "./types.ts";
import { PROVIDERS, providerBaseUrl } from "../state/defaults.ts";
import { proxied, withScheme } from "../util/misc.ts";
import { acceptsImages, acceptsParam, publishedModel, recordModelListing } from "./modelinfo.ts";

export class ProviderError extends Error {
	readonly status?: number;
	readonly hint?: string;
	constructor(message: string, status?: number, hint?: string) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
		this.hint = hint;
	}
}

/** Wrap a target URL with the CORS proxy when enabled. */
function endpoint(url: string, settings: Settings, useProxy: boolean): string {
	return useProxy ? proxied(url, settings.proxyUrl) : url;
}

/** Whether the chat request goes through the proxy: the user's toggle, OR the
 * provider needing it regardless. */
function chatUsesProxy(cfg: ChatConfig): boolean {
	return cfg.useProxy || PROVIDERS[cfg.provider].needsProxy;
}

/** The chat base URL: the user's override, else the provider's own default. */
function chatBase(cfg: ChatConfig): string {
	return withScheme(providerBaseUrl(cfg.provider, cfg.baseUrl)).replace(/\/+$/, "");
}

/** The URL a chat request actually goes to -- provider path, base URL and proxy
 * composed. Exported so a test can assert the composition without a request. */
export function chatEndpoint(settings: Settings): string {
	const cfg = settings.chat;
	const path = PROVIDERS[cfg.provider].wire === "anthropic" ? "/v1/messages" : "/chat/completions";
	return endpoint(`${chatBase(cfg)}${path}`, settings, chatUsesProxy(cfg));
}

/** The URL a model-list request goes to. */
export function modelsEndpoint(settings: Settings): string {
	const cfg = settings.chat;
	const anthropic = PROVIDERS[cfg.provider].wire === "anthropic";
	const path = anthropic ? "/v1/models?limit=1000" : "/models";
	return endpoint(`${chatBase(cfg)}${path}`, settings, chatUsesProxy(cfg));
}

/** The active provider's key. */
export function chatApiKey(cfg: ChatConfig): string {
	return (cfg.apiKeys[cfg.provider] ?? "").trim();
}

/** The Anthropic-wire credential headers. A base-URL override is a gateway, so
 * the key also goes in `x-bf-vk`. The hosted default keeps its own headers. */
export function anthropicHeaders(cfg: ChatConfig): Record<string, string> {
	const key = chatApiKey(cfg);
	const headers: Record<string, string> = {
		"x-api-key": key,
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
	};
	if (key && cfg.baseUrl.trim()) headers["x-bf-vk"] = key;
	return headers;
}

/** The credential headers for an OpenAI-wire request. A base-URL override is a
 * gateway, so the key also goes in `x-bf-vk` (Bifrost reads it verbatim). The
 * hosted default keeps the bearer token alone. */
export function openaiAuthHeaders(cfg: ChatConfig): Record<string, string> {
	const key = chatApiKey(cfg);
	if (!key) return {};
	const headers: Record<string, string> = { authorization: `Bearer ${key}` };
	if (cfg.baseUrl.trim()) headers["x-bf-vk"] = key;
	return headers;
}

async function* sseEvents(res: Response): AsyncGenerator<{ event: string; data: string }> {
	const reader = res.body?.getReader();
	if (!reader) throw new ProviderError("response had no body");
	const decoder = new TextDecoder();
	let buf = "";
	const parse = (chunk: string): { event: string; data: string } | null => {
		let event = "message";
		const dataLines: string[] = [];
		for (const raw of chunk.split(/\r?\n/)) {
			if (raw.startsWith("event:")) event = raw.slice(6).trim();
			else if (raw.startsWith("data:")) dataLines.push(raw.slice(5).replace(/^ /, ""));
		}
		return dataLines.length ? { event, data: dataLines.join("\n") } : null;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			// Events are separated by a blank line (LF or CRLF); take the earliest.
			while (true) {
				const lf = buf.indexOf("\n\n");
				const crlf = buf.indexOf("\r\n\r\n");
				const idx = lf === -1 ? crlf : crlf === -1 ? lf : Math.min(lf, crlf);
				if (idx === -1) break;
				const ev = parse(buf.slice(0, idx));
				buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
				if (ev) yield ev;
			}
		}
		// A final event with no trailing blank line (a stream cut short, or a closing `error` event) must still reach the caller.
		buf += decoder.decode();
		const tail = parse(buf);
		if (tail) yield tail;
	} finally {
		reader.cancel().catch(() => {});
	}
}

/** Translate a fetch/stream abort into the one error the UI recognises. */
function isAbort(e: unknown): boolean {
	return e instanceof DOMException && e.name === "AbortError";
}

// ---- neutral -> Anthropic ---------------------------------------------------

type ACBlock = Record<string, unknown>;

/** The Anthropic form of a thinking block. Encrypted reasoning or a raw entry from
 * another wire has no Anthropic form; it stays on the message for a switch back. */
function anthropicThinkingBlock(b: ThinkingBlock): ACBlock | null {
	if (b.raw) return b.rawWire === "anthropic" ? b.raw : null;
	if (b.encrypted === undefined) return { type: "thinking", thinking: b.thinking, signature: b.signature };
	if (b.detailFormat !== undefined && b.detailFormat !== "anthropic-claude-v1") return null;
	return { type: "redacted_thinking", data: b.encrypted };
}

function anthropicContent(blocks: Block[]): ACBlock[] {
	return blocks.flatMap((b): ACBlock[] => {
		if (b.type !== "thinking") return [anthropicBlock(b)];
		const block = anthropicThinkingBlock(b);
		return block ? [block] : [];
	});
}

function anthropicBlock(b: Exclude<Block, ThinkingBlock>): ACBlock {
	switch (b.type) {
		case "text":
			return { type: "text", text: b.text };
		case "image":
			return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
		case "tool_use":
			return { type: "tool_use", id: b.id, name: b.name, input: b.input };
		case "tool_result":
			return {
				type: "tool_result",
				tool_use_id: b.toolUseId,
				is_error: b.isError ?? false,
				content: b.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", media_type: c.mediaType, data: c.data } })),
			};
	}
}

function toAnthropicMessages(messages: Message[], state: string): ACBlock[] {
	const out: ACBlock[] = messages.map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user", // tool results ride in a user message
		content: anthropicContent(m.blocks),
	}));
	const last = out[out.length - 1]?.["content"] as ACBlock[] | undefined;
	const lastBlock = last?.[last.length - 1];
	if (lastBlock) lastBlock["cache_control"] = { type: "ephemeral" };
	if (state.trim()) out.push({ role: "user", content: [{ type: "text", text: state }] });
	return out;
}

// Model families that still take a thinking token budget (and accept sampling parameters).
const ANTHROPIC_BUDGET_MODELS = /(opus-4-[015])|sonnet-4-[05]|haiku-4-5/i;

function anthropicAcceptsTemperature(model: string): boolean {
	return ANTHROPIC_BUDGET_MODELS.test(model) || /(opus-4-6)|sonnet-4-6/i.test(model);
}

// Extended thinking. Thinking and temperature are mutually exclusive in our
// request — see the body assembly below.
function anthropicThinking(model: string, maxTokens?: number): Record<string, unknown> | undefined {
	if (ANTHROPIC_BUDGET_MODELS.test(model)) {
		if (maxTokens === undefined) return undefined; // a budget needs a limit
		const budget = Math.max(1024, Math.min(8192, Math.floor(maxTokens / 2)));
		return budget < maxTokens ? { type: "enabled", budget_tokens: budget } : undefined;
	}
	return { type: "adaptive", display: "summarized" };
}

function anthropicEffort(model: string): string | undefined {
	return /sonnet-4-[05]|haiku-4-5|opus-4-[01]/i.test(model) ? undefined : "medium";
}

/** The configured output limit, held to the most the model publishes it can write. */
function outputLimit(cfg: ChatConfig): number | undefined {
	const max = publishedModel(cfg.model)?.maxOutput;
	return cfg.maxTokens !== undefined && max !== undefined ? Math.min(cfg.maxTokens, max) : cfg.maxTokens;
}

/** The Anthropic Messages request body. Exported so the model gates (thinking vs
 * temperature, effort, tool_choice) can be asserted without a request. */
export function anthropicBody(cfg: ChatConfig, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions = {}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: cfg.model,
		// Cache the (stable) system prompt. Tools render before it, so this breakpoint covers tools + system.
		system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
		stream: true,
		messages: toAnthropicMessages(messages, state),
	};
	const maxTokens = outputLimit(cfg);
	if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
	if (tools.length) {
		body["tools"] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
		// A history that carries tool_use/tool_result blocks must define tools.
		if (opts.toolChoice === "none") body["tool_choice"] = { type: "none" };
	}
	const thinking = anthropicThinking(cfg.model, maxTokens);
	if (thinking) body["thinking"] = thinking;
	else if (cfg.temperature !== undefined && anthropicAcceptsTemperature(cfg.model)) body["temperature"] = cfg.temperature;
	const effort = anthropicEffort(cfg.model);
	if (effort) body["output_config"] = { effort };
	return body;
}

interface AnthropicStreamBlock {
	type: string;
	id?: string;
	name?: string;
	json: string;
	thinking: string;
	signature: string;
	data?: string;
	raw?: Record<string, unknown>;
	done?: boolean;
}

/** The block a thinking/signature delta extends, opened on the spot when the start event never came. */
function thinkingBlockAt(blocks: Record<number, AnthropicStreamBlock>, idx: number): AnthropicStreamBlock {
	blocks[idx] ??= { type: "thinking", json: "", thinking: "", signature: "" };
	return blocks[idx];
}

/** A finished reasoning block as a captured thinking entry, or null for a non-reasoning block. */
function anthropicThinkingEntry(b: AnthropicStreamBlock): Omit<ThinkingBlock, "type"> | null {
	if (b.raw) {
		const raw = { ...b.raw };
		if (b.thinking) raw["thinking"] = b.thinking;
		if (b.signature) raw["signature"] = b.signature;
		return { thinking: b.thinking, signature: "", raw, rawWire: "anthropic" };
	}
	if (b.data !== undefined) return { thinking: "", signature: "", encrypted: b.data };
	if (b.type === "thinking") return { thinking: b.thinking, signature: b.signature };
	return null;
}

async function streamAnthropic(settings: Settings, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions): Promise<AssistantTurn> {
	const cfg = settings.chat;
	const url = chatEndpoint(settings);
	const body = anthropicBody(cfg, system, state, messages, tools, opts);

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...anthropicHeaders(cfg) },
			body: JSON.stringify(body),
			signal: opts.signal ?? null,
		});
	} catch (e) {
		throw corsHint(e, cfg);
	}
	if (!res.ok) throw await httpError(res);

	const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "end_turn", thinking: [], usage: emptyUsage(), durationMs: 0 };
	const blocks: Record<number, AnthropicStreamBlock> = {};
	let firstTokenAt = 0;

	try {
		for await (const ev of sseEvents(res)) {
			if (ev.data === "[DONE]") break;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				continue;
			}
			const type = msg["type"] as string;
			if (type === "message_start") {
				const u = (msg["message"] as Record<string, unknown> | undefined)?.["usage"] as Record<string, unknown> | undefined;
				if (u) {
					turn.usage.inputTokens = (u["input_tokens"] as number) ?? 0;
					// Anthropic's `input_tokens` is the UNCACHED remainder only.
					const cacheRead = u["cache_read_input_tokens"];
					const cacheWrite = u["cache_creation_input_tokens"];
					turn.usage.cacheReadTokens = typeof cacheRead === "number" ? cacheRead : undefined;
					turn.usage.cacheWriteTokens = typeof cacheWrite === "number" ? cacheWrite : undefined;
					turn.usage.outputTokens = (u["output_tokens"] as number) ?? 0;
				}
			} else if (type === "content_block_start") {
				if (!firstTokenAt) firstTokenAt = performance.now();
				const idx = msg["index"] as number;
				const cb = msg["content_block"] as Record<string, unknown>;
				const cbType = String(cb["type"]);
				blocks[idx] = { type: cbType, id: cb["id"] as string, name: cb["name"] as string, json: "", thinking: typeof cb["thinking"] === "string" ? cb["thinking"] : "", signature: typeof cb["signature"] === "string" ? cb["signature"] : "" };
				if (cbType === "redacted_thinking" && typeof cb["data"] === "string") blocks[idx].data = cb["data"];
				else if (cbType !== "thinking" && /thinking|reasoning/.test(cbType)) blocks[idx].raw = cb;
				if (cb["type"] === "tool_use") emit(opts, { type: "tool_start", id: cb["id"] as string, name: cb["name"] as string });
			} else if (type === "content_block_delta") {
				const idx = msg["index"] as number;
				const delta = msg["delta"] as Record<string, unknown>;
				if (delta["type"] === "text_delta") {
					turn.text += delta["text"] as string;
					emit(opts, { type: "text", delta: delta["text"] as string });
				} else if (delta["type"] === "thinking_delta") {
					thinkingBlockAt(blocks, idx).thinking += delta["thinking"] as string;
					emit(opts, { type: "thinking", delta: delta["thinking"] as string });
				} else if (delta["type"] === "signature_delta") {
					thinkingBlockAt(blocks, idx).signature += (delta["signature"] as string) ?? "";
				} else if (delta["type"] === "input_json_delta") {
					const b = blocks[idx];
					if (b) {
						b.json += delta["partial_json"] as string;
						emit(opts, { type: "tool_args", id: b.id ?? "", delta: delta["partial_json"] as string });
					}
				}
			} else if (type === "content_block_stop") {
				const b = blocks[msg["index"] as number];
				if (b) b.done = true;
				if (b && b.type === "tool_use") {
					turn.toolCalls.push({ id: b.id ?? "", name: b.name ?? "", input: safeJson(b.json) });
				} else if (b) {
					const entry = anthropicThinkingEntry(b);
					if (entry) turn.thinking.push(entry);
				}
			} else if (type === "message_delta") {
				const delta = msg["delta"] as Record<string, unknown>;
				if (delta && delta["stop_reason"]) turn.stopReason = delta["stop_reason"] as string;
				const u = msg["usage"] as Record<string, unknown> | undefined;
				if (u && u["output_tokens"] != null) turn.usage.outputTokens = u["output_tokens"] as number;
			} else if (type === "error") {
				const err = msg["error"] as Record<string, unknown>;
				throw new ProviderError((err?.["message"] as string) ?? "stream error");
			}
		}
	} catch (e) {
		if (isAbort(e)) throw new ProviderError("Request cancelled.");
		throw e;
	}
	// A reasoning block the stream never closed is still the model's reasoning.
	for (const idx of Object.keys(blocks).map(Number).sort((a, b) => a - b)) {
		const entry = blocks[idx].done ? null : anthropicThinkingEntry(blocks[idx]);
		if (entry) turn.thinking.push(entry);
	}
	turn.durationMs = firstTokenAt ? performance.now() - firstTokenAt : 0;
	emit(opts, { type: "done", stopReason: turn.stopReason });
	return turn;
}

// ---- neutral -> OpenAI ------------------------------------------------------

function openaiUserContent(blocks: Array<TextBlock | ImageBlock>): unknown {
	// string when only text, else multimodal array
	const onlyText = blocks.every((b) => b.type === "text");
	if (onlyText) return blocks.map((b) => (b as TextBlock).text).join("\n");
	return blocks.map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } }));
}

/** Rebuild the `reasoning_details` entry a thinking block came from (or the
 * entry OpenRouter expects for an Anthropic block). */
function reasoningDetail(b: ThinkingBlock): Record<string, unknown> {
	if (b.raw) return b.raw;
	const type = b.detailType ?? (b.encrypted !== undefined ? "reasoning.encrypted" : "reasoning.text");
	const out: Record<string, unknown> = { type };
	if (type === "reasoning.encrypted") out["data"] = b.encrypted ?? "";
	else if (type === "reasoning.summary") out["summary"] = b.thinking;
	else out["text"] = b.thinking;
	if (b.signature) out["signature"] = b.signature;
	if (b.detailFormat !== undefined) out["format"] = b.detailFormat;
	if (b.detailId !== undefined) out["id"] = b.detailId;
	if (b.detailIndex !== undefined) out["index"] = b.detailIndex;
	return out;
}

/** `textOnlyModel` names a model that takes no image input; its requests carry a note in place of each image. */
export function toOpenAIMessages(system: string, messages: Message[], state: string, textOnlyModel?: string): unknown[] {
	const out: unknown[] = [{ role: "system", content: system }];
	for (const m of messages) {
		if (m.role === "assistant") {
			const text = m.blocks
				.filter((b): b is TextBlock => b.type === "text")
				.map((b) => b.text)
				.join("");
			const toolCalls = m.blocks
				.filter((b) => b.type === "tool_use")
				.map((b) => {
					const t = b as Extract<Block, { type: "tool_use" }>;
					return { id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } };
				});
			const msg: Record<string, unknown> = { role: "assistant" };
			if (text) msg["content"] = text;
			if (toolCalls.length) msg["tool_calls"] = toolCalls;
			if (!text && !toolCalls.length) msg["content"] = "";
			const thinking = m.blocks.filter((b): b is ThinkingBlock => b.type === "thinking");
			const reasoning = thinking
				.filter((b) => b.encrypted === undefined && !b.raw)
				.map((b) => b.thinking)
				.join("");
			if (reasoning) msg["reasoning_content"] = reasoning;
			// A raw Anthropic block has no Chat Completions form; it stays on the message for a switch back.
			const details = thinking.filter((b) => (b.raw ? b.rawWire === "openai" : b.signature || b.encrypted !== undefined || b.detailType)).map(reasoningDetail);
			if (details.length) msg["reasoning_details"] = details;
			out.push(msg);
		} else {
			// user or tool: tool_result blocks become role:"tool".
			const trailing: Array<TextBlock | ImageBlock> = [];
			for (const b of m.blocks) {
				if (b.type === "tool_result") {
					const textParts = b.content.filter((c): c is TextBlock => c.type === "text").map((c) => c.text);
					out.push({ role: "tool", tool_call_id: b.toolUseId, content: textParts.join("\n") || "(no output)" });
					for (const c of b.content) if (c.type === "image") trailing.push(c);
				} else if (b.type === "text" || b.type === "image") {
					trailing.push(b);
				}
			}
			// A model that takes no image input gets a note in each image's place; the message keeps the image.
			const sendable = textOnlyModel ? trailing.map((b): TextBlock | ImageBlock => (b.type === "image" ? { type: "text", text: `[image not sent: ${textOnlyModel} takes no image input]` } : b)) : trailing;
			if (sendable.length) out.push({ role: "user", content: openaiUserContent(sendable) });
		}
	}
	// Volatile project state as an uncached, varying suffix -- keeps the system + conversation prefix stable for OpenAI's automatic (server-side) caching.
	if (state.trim()) out.push({ role: "user", content: state });
	return out;
}

// OpenAI's reasoning models (o-series, gpt-5 family) reject `max_tokens`
// (they take `max_completion_tokens`) and any temperature other than the
// default.
function isOpenAIReasoningModel(cfg: ChatConfig): boolean {
	return isHostedOpenAI(cfg) && /^(o\d|gpt-5)/i.test(cfg.model.trim());
}

/** The Chat Completions request body. Exported so the per-model field gates can
 * be asserted without a request. */
export function openaiBody(cfg: ChatConfig, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions = {}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: cfg.model,
		stream: true,
		// ask for a final usage chunk so we can report cost + context use
		stream_options: { include_usage: true },
		messages: toOpenAIMessages(system, messages, state, acceptsImages(cfg.model) ? undefined : cfg.model),
	};
	const maxTokens = outputLimit(cfg);
	if (isOpenAIReasoningModel(cfg)) {
		if (maxTokens !== undefined) body["max_completion_tokens"] = maxTokens;
	} else {
		if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
		if (cfg.temperature !== undefined && acceptsParam(cfg.model, "temperature")) body["temperature"] = cfg.temperature;
	}
	if (tools.length) {
		body["tools"] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
		if (opts.toolChoice === "none") body["tool_choice"] = "none";
	}
	// Reasoning on, at the model's default effort, wherever the model takes it.
	if (cfg.provider === "openrouter" && acceptsParam(cfg.model, "reasoning")) body["reasoning"] = { enabled: true };
	// Hosted OpenAI caches automatically (>= 1024-token prefixes).
	if (opts.cacheKey) body["prompt_cache_key"] = opts.cacheKey;
	// Self-hosted OpenAI-compatible servers (llama.cpp, Ollama, LM Studio, ...) opt into KV-cache prefix reuse with `cache_prompt`: re-use the cache from a prior request.
	if (!isHostedOpenAI(cfg)) body["cache_prompt"] = true;
	return body;
}

/** One streamed fragment of a thinking block. */
export type ReasoningPiece = Omit<ThinkingBlock, "type" | "thinking"> & { text: string };

const DETAIL_PAYLOAD: Record<ReasoningDetailType, string> = { "reasoning.text": "text", "reasoning.summary": "summary", "reasoning.encrypted": "data" };

/** Reasoning text in a value of unknown shape: a string as-is, anything else as JSON. */
function asText(value: unknown): string {
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** A `reasoning_details` entry this app does not model: kept verbatim, with any readable text shown. */
function rawDetailPiece(entry: unknown): ReasoningPiece {
	const raw = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : { value: entry };
	return { text: asText(raw["text"] ?? raw["summary"]), signature: "", raw, rawWire: "openai" };
}

/** One `reasoning_details` entry as a piece. An untyped entry with string text (Bifrost's shape) is plain reasoning text. */
function detailPiece(entry: unknown): ReasoningPiece {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return rawDetailPiece(entry);
	const d = entry as Record<string, unknown>;
	const rawType = d["type"];
	const signature = d["signature"] ?? "";
	if (typeof signature !== "string") return rawDetailPiece(entry);
	if ((rawType === undefined || rawType === null) && typeof d["text"] === "string") return { text: d["text"], signature };
	if (typeof rawType !== "string" || !(rawType in DETAIL_PAYLOAD)) return rawDetailPiece(entry);
	const type = rawType as ReasoningDetailType;
	const payload = d[DETAIL_PAYLOAD[type]] ?? "";
	const format = d["format"];
	const id = d["id"];
	const index = d["index"];
	const wellFormed = typeof payload === "string" && (format == null || typeof format === "string") && (id == null || typeof id === "string") && (index == null || typeof index === "number");
	if (!wellFormed) return rawDetailPiece(entry);
	const piece: ReasoningPiece = { text: type === "reasoning.encrypted" ? "" : payload, signature, detailType: type };
	if (type === "reasoning.encrypted") piece.encrypted = payload;
	if (typeof format === "string") piece.detailFormat = format;
	if (typeof id === "string") piece.detailId = id;
	if (typeof index === "number") piece.detailIndex = index;
	return piece;
}

/** Read every reasoning fragment in one streamed OpenAI delta. `reasoning_details`
 * holds the full structure, and `reasoning`/`reasoning_content` normally repeat its
 * readable text; text they carry beyond it becomes its own piece. */
export function reasoningPieces(delta: Record<string, unknown> | undefined): ReasoningPiece[] {
	if (!delta) return [];
	const strings: string[] = [];
	for (const field of ["reasoning", "reasoning_content"]) {
		const value = asText(delta[field]);
		if (value && !strings.includes(value)) strings.push(value);
	}
	const plain = strings.join("");
	const details = delta["reasoning_details"];
	const entries = details === undefined || details === null ? [] : Array.isArray(details) ? details : [details];
	const pieces = entries.map(detailPiece);
	const readable = pieces
		.filter((p) => p.encrypted === undefined)
		.map((p) => p.text)
		.join("");
	if (plain && plain !== readable) pieces.push({ text: plain, signature: "" });
	return pieces;
}

/** Whether a piece continues the block it would be appended to: the same
 * detail entry, and not past a signature. */
function continuesBlock(block: Omit<ThinkingBlock, "type">, piece: ReasoningPiece): boolean {
	if (block.signature || block.raw) return false;
	if ((block.encrypted === undefined) !== (piece.encrypted === undefined)) return false;
	if (block.detailType !== piece.detailType) return false;
	if (piece.detailIndex !== undefined && block.detailIndex !== undefined && piece.detailIndex !== block.detailIndex) return false;
	return !(piece.detailId !== undefined && block.detailId !== undefined && piece.detailId !== block.detailId);
}

/** Append one reasoning piece to the turn's thinking blocks. A signed block is
 * closed, so later text starts a new block and every signature survives replay. */
export function appendThinking(turn: AssistantTurn, piece: ReasoningPiece): void {
	if (piece.raw) {
		turn.thinking.push({ thinking: piece.text, signature: "", raw: piece.raw, rawWire: piece.rawWire });
		return;
	}
	if (!piece.text && !piece.signature && !piece.encrypted && !piece.detailType) return;
	let block = turn.thinking[turn.thinking.length - 1];
	if (!block || !continuesBlock(block, piece)) {
		block = { thinking: "", signature: "" };
		if (piece.encrypted !== undefined) block.encrypted = "";
		if (piece.detailType !== undefined) block.detailType = piece.detailType;
		turn.thinking.push(block);
	}
	block.thinking += piece.text;
	if (piece.encrypted !== undefined) block.encrypted = (block.encrypted ?? "") + piece.encrypted;
	if (piece.signature) block.signature = piece.signature;
	if (piece.detailFormat !== undefined) block.detailFormat ??= piece.detailFormat;
	if (piece.detailId !== undefined) block.detailId ??= piece.detailId;
	if (piece.detailIndex !== undefined) block.detailIndex ??= piece.detailIndex;
}

async function streamOpenAI(settings: Settings, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions): Promise<AssistantTurn> {
	const cfg = settings.chat;
	const url = chatEndpoint(settings);
	const body = openaiBody(cfg, system, state, messages, tools, opts);
	const headers: Record<string, string> = { "content-type": "application/json", ...openaiExtraHeaders(cfg), ...openaiAuthHeaders(cfg) };
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: opts.signal ?? null,
		});
	} catch (e) {
		throw corsHint(e, cfg);
	}
	if (!res.ok) throw await httpError(res);

	const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "stop", thinking: [], usage: emptyUsage(), durationMs: 0 };
	const calls: Array<{ id: string; name: string; args: string; started: boolean }> = [];
	let firstTokenAt = 0;
	let reportedReasoningTokens = 0;

	try {
		for await (const ev of sseEvents(res)) {
			if (ev.data === "[DONE]") break;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				continue;
			}
			const u = msg["usage"] as Record<string, unknown> | undefined;
			if (u) {
				// Cached prompt tokens come ONLY from what the server reports — `prompt_tokens_details.cached_tokens` present => real count.
				const details = u["prompt_tokens_details"] as Record<string, unknown> | undefined;
				const reportedCached = details?.["cached_tokens"];
				const cached = typeof reportedCached === "number" ? reportedCached : undefined;
				const prompt = (u["prompt_tokens"] as number) ?? 0;
				turn.usage.inputTokens = Math.max(0, prompt - (cached ?? 0));
				turn.usage.cacheReadTokens = cached;
				turn.usage.cacheWriteTokens = 0;
				turn.usage.outputTokens = (u["completion_tokens"] as number) ?? turn.usage.outputTokens;
				const reasoningTokens = (u["completion_tokens_details"] as Record<string, unknown> | undefined)?.["reasoning_tokens"];
				if (typeof reasoningTokens === "number") reportedReasoningTokens = reasoningTokens;
				const reportedCost = u["cost"];
				if (typeof reportedCost === "number" && Number.isFinite(reportedCost)) turn.usage.cost = reportedCost;
			}
			const choice = (msg["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
			if (!choice) continue;
			const delta = choice["delta"] as Record<string, unknown> | undefined;
			for (const piece of reasoningPieces(delta)) {
				if (!firstTokenAt) firstTokenAt = performance.now();
				appendThinking(turn, piece);
				if (piece.text) emit(opts, { type: "thinking", delta: piece.text });
			}
			if (delta?.["content"]) {
				if (!firstTokenAt) firstTokenAt = performance.now();
				turn.text += delta["content"] as string;
				emit(opts, { type: "text", delta: delta["content"] as string });
			}
			const tcs = delta?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
			if (tcs) {
				if (!firstTokenAt) firstTokenAt = performance.now();
				for (const tc of tcs) {
					// Fragments are keyed by `index`.
					const id = typeof tc["id"] === "string" ? (tc["id"] as string) : "";
					let i = typeof tc["index"] === "number" ? (tc["index"] as number) : -1;
					if (i < 0) i = id && calls.length && calls[calls.length - 1].id !== id ? calls.length : Math.max(0, calls.length - 1);
					while (calls.length <= i) calls.push({ id: "", name: "", args: "", started: false });
					const c = calls[i];
					if (id) c.id = id;
					const fn = tc["function"] as Record<string, unknown> | undefined;
					if (fn?.["name"]) c.name = fn["name"] as string;
					if (c.name && !c.started) {
						c.started = true;
						emit(opts, { type: "tool_start", id: c.id, name: c.name });
					}
					if (fn?.["arguments"]) {
						c.args += fn["arguments"] as string;
						emit(opts, { type: "tool_args", id: c.id, delta: fn["arguments"] as string });
					}
				}
			}
			if (choice["finish_reason"]) turn.stopReason = choice["finish_reason"] as string;
		}
	} catch (e) {
		if (isAbort(e)) throw new ProviderError("Request cancelled.");
		throw e;
	}
	if (reportedReasoningTokens > 0 && !turn.thinking.length) turn.note = `The server billed ${reportedReasoningTokens} reasoning tokens but sent no reasoning, so the model cannot see it on later turns.`;
	calls.forEach((c, i) => {
		if (c.name) turn.toolCalls.push({ id: c.id || `call_${i}`, name: c.name, input: safeJson(c.args) });
	});
	turn.durationMs = firstTokenAt ? performance.now() - firstTokenAt : 0;
	emit(opts, { type: "done", stopReason: turn.stopReason });
	return turn;
}

// ---- dispatch + helpers -----------------------------------------------------

export function streamChat(settings: Settings, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions = {}): Promise<AssistantTurn> {
	if (PROVIDERS[settings.chat.provider].wire === "anthropic") return streamAnthropic(settings, system, state, messages, tools, opts);
	return streamOpenAI(settings, system, state, messages, tools, opts);
}

export interface TestResult {
	ok: boolean;
	message: string;
}

/** Run a tiny real inference to validate the API key, model, base URL, and
 * (CORS) connectivity, and surface the model's actual reply. */
export async function testConnection(settings: Settings): Promise<TestResult> {
	const cfg = settings.chat;
	if (!cfg.model.trim()) return { ok: false, message: "No model set." };

	const prompt = 'Respond with one word: "Hi"';
	const isAnthropic = PROVIDERS[cfg.provider].wire === "anthropic";
	// A blank key is valid for keyless endpoints (e.g. Ollama); only flag it as a likely cause when the request fails.
	const keyNote = chatApiKey(cfg) ? "" : " (no API key set — required unless your endpoint is keyless, e.g. Ollama)";
	let url: string;
	let headers: Record<string, string>;
	if (isAnthropic) {
		url = chatEndpoint(settings);
		headers = { "content-type": "application/json", ...anthropicHeaders(cfg) };
	} else {
		url = chatEndpoint(settings);
		headers = { "content-type": "application/json", ...openaiExtraHeaders(cfg), ...openaiAuthHeaders(cfg) };
	}
	const body = JSON.stringify({ model: cfg.model, [!isAnthropic && isOpenAIReasoningModel(cfg) ? "max_completion_tokens" : "max_tokens"]: 64, messages: [{ role: "user", content: prompt }] });

	let res: Response;
	try {
		res = await fetch(url, { method: "POST", headers, body });
	} catch (e) {
		const pe = corsHint(e, cfg);
		return { ok: false, message: `${pe.message}${pe.hint ? ` ${pe.hint}` : ""}${keyNote}` };
	}
	if (!res.ok) {
		const err = await httpError(res);
		return { ok: false, message: `${err.message}${err.hint ? ` ${err.hint}` : ""}${keyNote}` };
	}

	let reply = "";
	try {
		const json = (await res.json()) as Record<string, unknown>;
		if (isAnthropic) {
			const blocks = (json["content"] as Array<{ type: string; text?: string }> | undefined) ?? [];
			reply = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
		} else {
			const choices = json["choices"] as Array<{ message?: { content?: string } }> | undefined;
			reply = (choices?.[0]?.message?.content ?? "").trim();
		}
	} catch {
	}
	const shown = reply.length > 60 ? `${reply.slice(0, 60)}…` : reply;
	return { ok: true, message: reply ? `${cfg.model} replied: "${shown}"` : `${cfg.model} responded (no text).` };
}

/** List available model ids from the provider (Anthropic /v1/models or an
 * OpenAI-compatible /models), recording what each entry publishes about its
 * model (limits, prices, accepted parameters). Throws a ProviderError on failure. */
export async function listModels(settings: Settings): Promise<string[]> {
	const cfg = settings.chat;
	const url = modelsEndpoint(settings);
	const headers: Record<string, string> = {};
	if (PROVIDERS[cfg.provider].wire === "anthropic") {
		Object.assign(headers, anthropicHeaders(cfg));
	} else {
		Object.assign(headers, openaiExtraHeaders(cfg), openaiAuthHeaders(cfg));
	}

	let res: Response;
	try {
		res = await fetch(url, { headers });
	} catch (e) {
		throw corsHint(e, cfg);
	}
	if (!res.ok) throw await httpError(res);
	const json = (await res.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> };
	const items = json.data ?? json.models ?? [];
	const ids = items.map((m) => m.id ?? m.name ?? "").filter((s) => s.length > 0);
	recordModelListing(items);
	return [...new Set(ids)].sort();
}

function emit(opts: StreamOptions, ev: StreamEvent): void {
	opts.onEvent?.(ev);
}

function emptyUsage(): Usage {
	// cacheRead/cacheWrite default to undefined ("server didn't report"); the provider paths set real numbers (incl.
	return { inputTokens: 0, outputTokens: 0 };
}

function safeJson(s: string): unknown {
	if (!s || !s.trim()) return {};
	try {
		return JSON.parse(s);
	} catch {
		return { _raw: s };
	}
}

async function httpError(res: Response): Promise<ProviderError> {
	let detail = "";
	try {
		const text = await res.text();
		try {
			const j = JSON.parse(text) as Record<string, unknown>;
			const err = j["error"] as Record<string, unknown> | string | undefined;
			detail = typeof err === "string" ? err : ((err?.["message"] as string) ?? text);
		} catch {
			detail = text;
		}
	} catch {
	}
	const hint = res.status === 401 ? "Check your API key in Settings." : undefined;
	return new ProviderError(`HTTP ${res.status}: ${detail || res.statusText}`, res.status, hint);
}

function corsHint(e: unknown, cfg: ChatConfig): ProviderError {
	const msg = e instanceof Error ? e.message : String(e);
	if (e instanceof DOMException && e.name === "AbortError") return new ProviderError("Request cancelled.");
	const hint = ollamaCorsHint(cfg) ?? (chatUsesProxy(cfg) ? "The CORS proxy may be unreachable; check the proxy URL in Settings." : "This is likely a CORS/network error. Try enabling 'Route through CORS proxy' in Settings.");
	return new ProviderError(`Network error: ${msg}`, undefined, hint);
}

// Detect a LOCAL Ollama endpoint by its default port / name (for the CORS hint).
// Ollama Cloud is a hosted service with no OLLAMA_ORIGINS to set, and it rides
// the proxy instead. The hint must not fire for it.
function isOllamaEndpoint(cfg: ChatConfig): boolean {
	if (cfg.provider !== "openai") return false;
	const url = (cfg.baseUrl || "").toLowerCase();
	return /:11434(\b|\/|$)/.test(url) || url.includes("ollama");
}

function isHostedOpenAI(cfg: ChatConfig): boolean {
	if (cfg.provider !== "openai") return true;
	const url = (cfg.baseUrl || "").trim().toLowerCase();
	if (!url) return true; // default is api.openai.com
	return /(^|\/\/|\.)api\.openai\.com(\/|:|$)/.test(url) || url.includes(".openai.azure.com");
}

// OpenRouter attributes a request to the calling app through these headers and
// lists it among that model's apps. Both are on OpenRouter's CORS
// allow-headers list, so they cost no extra preflight failure.
function openaiExtraHeaders(cfg: ChatConfig): Record<string, string> {
	if (cfg.provider !== "openrouter") return {};
	const referer = typeof location === "undefined" ? "" : location.origin;
	return { "x-title": "AI Shadertoy", ...(referer ? { "http-referer": referer } : {}) };
}

// Ollama (and similar local OpenAI-compatible servers) reject browser requests
// until the origin is allowlisted.
function ollamaCorsHint(cfg: ChatConfig): string | undefined {
	if (!isOllamaEndpoint(cfg)) return undefined;
	return "Ollama blocks browser requests unless you allow this origin. Restart Ollama with OLLAMA_ORIGINS set: run `OLLAMA_ORIGINS='*' ollama serve`; or (macOS app) `launchctl setenv OLLAMA_ORIGINS '*'` then restart Ollama; or (Linux systemd) `systemctl edit ollama`, add `Environment=\"OLLAMA_ORIGINS=*\"`, then `systemctl restart ollama`. Then try again.";
}
