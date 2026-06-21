// Provider adapters. Two wire formats are supported -- Anthropic Messages and
// OpenAI-compatible Chat Completions -- both streamed (SSE) with vision and
// tool use. The app's neutral Message[] model (state/types.ts) mirrors
// Anthropic's content blocks; the OpenAI path down-converts.

import type { Block, ChatConfig, ImageBlock, Message, Settings, TextBlock } from "../state/types.ts";
import type { AssistantTurn, StreamEvent, StreamOptions, ToolDef, Usage } from "./types.ts";
import { withScheme } from "../util/misc.ts";

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

/** Wrap a target URL with the CORS proxy when enabled (prefix style). */
function endpoint(url: string, settings: Settings, useProxy: boolean): string {
	if (!useProxy) return url;
	const base = withScheme(settings.proxyUrl).replace(/\/+$/, "");
	return `${base}/${url}`;
}

async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
	const reader = res.body?.getReader();
	if (!reader) throw new ProviderError("response had no body");
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			// events are separated by a blank line
			while ((idx = buf.indexOf("\n\n")) !== -1 || (idx = buf.indexOf("\r\n\r\n")) !== -1) {
				const chunk = buf.slice(0, idx);
				buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
				let event = "message";
				const dataLines: string[] = [];
				for (const raw of chunk.split(/\r?\n/)) {
					if (raw.startsWith("event:")) event = raw.slice(6).trim();
					else if (raw.startsWith("data:")) dataLines.push(raw.slice(5).replace(/^ /, ""));
				}
				if (dataLines.length) yield { event, data: dataLines.join("\n") };
			}
			if (signal?.aborted) break;
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}

// ---- neutral -> Anthropic ---------------------------------------------------

type ACBlock = Record<string, unknown>;

function anthropicContent(blocks: Block[]): ACBlock[] {
	return blocks.map((b) => {
		switch (b.type) {
			case "text":
				return { type: "text", text: b.text };
			case "image":
				return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
			case "tool_use":
				return { type: "tool_use", id: b.id, name: b.name, input: b.input };
			case "thinking":
				return { type: "thinking", thinking: b.thinking, signature: b.signature };
			case "tool_result":
				return {
					type: "tool_result",
					tool_use_id: b.toolUseId,
					is_error: b.isError ?? false,
					content: b.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", media_type: c.mediaType, data: c.data } })),
				};
		}
	});
}

// Two prompt-cache breakpoints (the caller also marks `system`): a `cache_control`
// marker on the last block of the last real message caches the whole conversation
// prefix, and the volatile project `state` is appended AFTER it as an uncached,
// varying suffix so changing state can't invalidate that prefix (the "shared
// prefix, varying suffix" pattern). Max 4 breakpoints/request -- we use 2.
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

// Opus 4.8/4.7 and the Fable/Mythos family reject temperature/top_p/top_k with
// a 400; older 4.x models still accept temperature. Only send it where valid.
function anthropicAcceptsTemperature(model: string): boolean {
	return !/(opus-4-[78])|fable|mythos/i.test(model);
}

// Extended thinking, gated by model so we never send a config that 400s:
// 4.6+ Opus / Sonnet 4.6 / Fable / Mythos take adaptive thinking; 4.5-era models
// take a token budget (must stay under max_tokens); anything unrecognised gets no
// thinking. `display: "summarized"` makes the reasoning visible as it streams.
// (Thinking and temperature are mutually exclusive in our request — see below.)
function anthropicThinking(model: string, maxTokens: number): Record<string, unknown> | undefined {
	if (/(opus-4-[678])|sonnet-4-6|fable|mythos/i.test(model)) {
		return { type: "adaptive", display: "summarized" };
	}
	if (/(opus-4-[015])|sonnet-4-[05]|haiku-4-5/i.test(model)) {
		const budget = Math.max(1024, Math.min(8192, Math.floor(maxTokens / 2)));
		return budget < maxTokens ? { type: "enabled", budget_tokens: budget } : undefined;
	}
	return undefined;
}

// `output_config.effort` (GA, no beta header) is supported on Opus 4.5+ and
// Sonnet 4.6 / Fable / Mythos; it 400s on Sonnet 4.5 / Haiku 4.5 and older, so
// gate it. We set "medium" (the server default is "high") to trade some depth
// for lower latency/cost.
function anthropicEffort(model: string): string | undefined {
	return /(opus-4-[5678])|sonnet-4-6|fable|mythos/i.test(model) ? "medium" : undefined;
}

async function streamAnthropic(settings: Settings, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions): Promise<AssistantTurn> {
	const cfg = settings.chat;
	const base = withScheme(cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
	const url = endpoint(`${base}/v1/messages`, settings, cfg.useProxy);
	const body: Record<string, unknown> = {
		model: cfg.model,
		max_tokens: cfg.maxTokens,
		// Cache the (stable) system prompt. Tools render before it, so this single
		// breakpoint covers tools + system. The volatile project state is NOT here
		// -- it rides at the end of `messages` so it can't invalidate this prefix.
		system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
		stream: true,
		messages: toAnthropicMessages(messages, state),
	};
	if (tools.length) body["tools"] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
	const thinking = anthropicThinking(cfg.model, cfg.maxTokens);
	if (thinking) body["thinking"] = thinking;
	else if (anthropicAcceptsTemperature(cfg.model)) body["temperature"] = cfg.temperature;
	const effort = anthropicEffort(cfg.model);
	if (effort) body["output_config"] = { effort };

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": cfg.apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			body: JSON.stringify(body),
			signal: opts.signal ?? null,
		});
	} catch (e) {
		throw corsHint(e, cfg);
	}
	if (!res.ok) throw await httpError(res);

	const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "end_turn", thinking: [], usage: emptyUsage(), durationMs: 0 };
	const blocks: Record<number, { type: string; id?: string; name?: string; json: string; thinking: string; signature: string }> = {};
	let firstTokenAt = 0;

	for await (const ev of sseEvents(res, opts.signal)) {
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
				turn.usage.cacheReadTokens = (u["cache_read_input_tokens"] as number) ?? 0;
				turn.usage.cacheWriteTokens = (u["cache_creation_input_tokens"] as number) ?? 0;
				turn.usage.outputTokens = (u["output_tokens"] as number) ?? 0;
			}
		} else if (type === "content_block_start") {
			if (!firstTokenAt) firstTokenAt = performance.now();
			const idx = msg["index"] as number;
			const cb = msg["content_block"] as Record<string, unknown>;
			blocks[idx] = { type: cb["type"] as string, id: cb["id"] as string, name: cb["name"] as string, json: "", thinking: (cb["thinking"] as string) ?? "", signature: (cb["signature"] as string) ?? "" };
			if (cb["type"] === "tool_use") emit(opts, { type: "tool_start", id: cb["id"] as string, name: cb["name"] as string });
		} else if (type === "content_block_delta") {
			const idx = msg["index"] as number;
			const delta = msg["delta"] as Record<string, unknown>;
			if (delta["type"] === "text_delta") {
				turn.text += delta["text"] as string;
				emit(opts, { type: "text", delta: delta["text"] as string });
			} else if (delta["type"] === "thinking_delta") {
				const b = blocks[idx];
				if (b) {
					b.thinking += delta["thinking"] as string;
					emit(opts, { type: "thinking", delta: delta["thinking"] as string });
				}
			} else if (delta["type"] === "signature_delta") {
				const b = blocks[idx];
				if (b) b.signature += (delta["signature"] as string) ?? "";
			} else if (delta["type"] === "input_json_delta") {
				const b = blocks[idx];
				if (b) {
					b.json += delta["partial_json"] as string;
					emit(opts, { type: "tool_args", id: b.id ?? "", delta: delta["partial_json"] as string });
				}
			}
		} else if (type === "content_block_stop") {
			const b = blocks[msg["index"] as number];
			if (b && b.type === "tool_use") {
				turn.toolCalls.push({ id: b.id ?? "", name: b.name ?? "", input: safeJson(b.json) });
			} else if (b && b.type === "thinking") {
				turn.thinking.push({ thinking: b.thinking, signature: b.signature });
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

function toOpenAIMessages(system: string, messages: Message[], state: string): unknown[] {
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
			out.push(msg);
		} else {
			// user or tool: tool_result blocks become role:"tool"; any plain
			// text/image content becomes a following user message.
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
			if (trailing.length) out.push({ role: "user", content: openaiUserContent(trailing) });
		}
	}
	// Volatile project state as an uncached, varying suffix -- keeps the system +
	// conversation prefix stable for OpenAI's automatic (server-side) caching.
	if (state.trim()) out.push({ role: "user", content: state });
	return out;
}

async function streamOpenAI(settings: Settings, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions): Promise<AssistantTurn> {
	const cfg = settings.chat;
	const base = withScheme(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
	const url = endpoint(`${base}/chat/completions`, settings, cfg.useProxy);
	const body: Record<string, unknown> = {
		model: cfg.model,
		max_tokens: cfg.maxTokens,
		temperature: cfg.temperature,
		stream: true,
		// ask for a final usage chunk so we can report cost + context use
		stream_options: { include_usage: true },
		messages: toOpenAIMessages(system, messages, state),
	};
	if (tools.length) body["tools"] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.apiKey.trim()) headers["authorization"] = `Bearer ${cfg.apiKey}`;
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
	const calls: Record<number, { id: string; name: string; args: string }> = {};
	let firstTokenAt = 0;

	for await (const ev of sseEvents(res, opts.signal)) {
		if (ev.data === "[DONE]") break;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(ev.data);
		} catch {
			continue;
		}
		const u = msg["usage"] as Record<string, unknown> | undefined;
		if (u) {
			const details = u["prompt_tokens_details"] as Record<string, unknown> | undefined;
			const cached = (details?.["cached_tokens"] as number) ?? 0;
			const prompt = (u["prompt_tokens"] as number) ?? 0;
			turn.usage.inputTokens = Math.max(0, prompt - cached);
			turn.usage.cacheReadTokens = cached;
			turn.usage.cacheWriteTokens = 0;
			turn.usage.outputTokens = (u["completion_tokens"] as number) ?? turn.usage.outputTokens;
		}
		const choice = (msg["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
		if (!choice) continue;
		const delta = choice["delta"] as Record<string, unknown> | undefined;
		if (delta?.["content"]) {
			if (!firstTokenAt) firstTokenAt = performance.now();
			turn.text += delta["content"] as string;
			emit(opts, { type: "text", delta: delta["content"] as string });
		}
		const tcs = delta?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
		if (tcs) {
			if (!firstTokenAt) firstTokenAt = performance.now();
			for (const tc of tcs) {
				const i = (tc["index"] as number) ?? 0;
				if (!calls[i]) calls[i] = { id: "", name: "", args: "" };
				if (tc["id"]) calls[i].id = tc["id"] as string;
				const fn = tc["function"] as Record<string, unknown> | undefined;
				if (fn?.["name"]) {
					calls[i].name = fn["name"] as string;
					emit(opts, { type: "tool_start", id: calls[i].id, name: calls[i].name });
				}
				if (fn?.["arguments"]) {
					calls[i].args += fn["arguments"] as string;
					emit(opts, { type: "tool_args", id: calls[i].id, delta: fn["arguments"] as string });
				}
			}
		}
		if (choice["finish_reason"]) turn.stopReason = choice["finish_reason"] as string;
	}
	for (const i of Object.keys(calls).map(Number).sort((a, b) => a - b)) {
		const c = calls[i];
		turn.toolCalls.push({ id: c.id || `call_${i}`, name: c.name, input: safeJson(c.args) });
	}
	turn.durationMs = firstTokenAt ? performance.now() - firstTokenAt : 0;
	emit(opts, { type: "done", stopReason: turn.stopReason });
	return turn;
}

// ---- dispatch + helpers -----------------------------------------------------

export function streamChat(settings: Settings, system: string, state: string, messages: Message[], tools: ToolDef[], opts: StreamOptions = {}): Promise<AssistantTurn> {
	if (settings.chat.provider === "anthropic") return streamAnthropic(settings, system, state, messages, tools, opts);
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
	const isAnthropic = cfg.provider === "anthropic";
	// A blank key is valid for keyless endpoints (e.g. Ollama); only flag it as a
	// likely cause when the request actually fails.
	const keyNote = cfg.apiKey.trim() ? "" : " (no API key set — required unless your endpoint is keyless, e.g. Ollama)";
	let url: string;
	let headers: Record<string, string>;
	if (isAnthropic) {
		const base = withScheme(cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
		url = endpoint(`${base}/v1/messages`, settings, cfg.useProxy);
		headers = { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
	} else {
		const base = withScheme(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
		url = endpoint(`${base}/chat/completions`, settings, cfg.useProxy);
		headers = { "content-type": "application/json" };
		if (cfg.apiKey.trim()) headers["authorization"] = `Bearer ${cfg.apiKey}`;
	}
	const body = JSON.stringify({ model: cfg.model, max_tokens: 64, messages: [{ role: "user", content: prompt }] });

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
		/* fall through to the generic success below */
	}
	const shown = reply.length > 60 ? `${reply.slice(0, 60)}…` : reply;
	return { ok: true, message: reply ? `${cfg.model} replied: "${shown}"` : `${cfg.model} responded (no text).` };
}

/** List available model ids from the provider (Anthropic /v1/models or an
 * OpenAI-compatible /models). Throws a ProviderError on failure. */
export async function listModels(settings: Settings): Promise<string[]> {
	const cfg = settings.chat;
	let url: string;
	const headers: Record<string, string> = {};
	if (cfg.provider === "anthropic") {
		const base = withScheme(cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
		url = endpoint(`${base}/v1/models?limit=1000`, settings, cfg.useProxy);
		headers["x-api-key"] = cfg.apiKey;
		headers["anthropic-version"] = "2023-06-01";
		headers["anthropic-dangerous-direct-browser-access"] = "true";
	} else {
		const base = withScheme(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
		url = endpoint(`${base}/models`, settings, cfg.useProxy);
		if (cfg.apiKey.trim()) headers["authorization"] = `Bearer ${cfg.apiKey}`;
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
	return [...new Set(ids)].sort();
}

function emit(opts: StreamOptions, ev: StreamEvent): void {
	opts.onEvent?.(ev);
}

function emptyUsage(): Usage {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
		/* ignore */
	}
	const hint = res.status === 401 ? "Check your API key in Settings." : undefined;
	return new ProviderError(`HTTP ${res.status}: ${detail || res.statusText}`, res.status, hint);
}

function corsHint(e: unknown, cfg: ChatConfig): ProviderError {
	const msg = e instanceof Error ? e.message : String(e);
	if (e instanceof DOMException && e.name === "AbortError") return new ProviderError("Request cancelled.");
	const ollama = ollamaCorsHint(cfg);
	const hint = ollama ?? (cfg.useProxy ? "The CORS proxy may be unreachable; check the proxy URL in Settings." : "This is likely a CORS/network error. Try enabling 'Route through CORS proxy' in Settings.");
	return new ProviderError(`Network error: ${msg}`, undefined, hint);
}

// Ollama (and similar local OpenAI-compatible servers) reject browser requests
// until the origin is allowlisted. Detect it by the default port / name.
function ollamaCorsHint(cfg: ChatConfig): string | undefined {
	if (cfg.provider !== "openai") return undefined;
	const url = (cfg.baseUrl || "").toLowerCase();
	if (!/:11434(\b|\/|$)/.test(url) && !url.includes("ollama")) return undefined;
	return "Ollama blocks browser requests unless you allow this origin. Restart Ollama with OLLAMA_ORIGINS set: run `OLLAMA_ORIGINS='*' ollama serve`; or (macOS app) `launchctl setenv OLLAMA_ORIGINS '*'` then restart Ollama; or (Linux systemd) `systemctl edit ollama`, add `Environment=\"OLLAMA_ORIGINS=*\"`, then `systemctl restart ollama`. Then try again.";
}
