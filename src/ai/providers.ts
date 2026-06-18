// Provider adapters. Two wire formats are supported -- Anthropic Messages and
// OpenAI-compatible Chat Completions -- both streamed (SSE) with vision and
// tool use. The app's neutral Message[] model (state/types.ts) mirrors
// Anthropic's content blocks; the OpenAI path down-converts.

import type { Block, ImageBlock, Message, Settings, TextBlock } from "../state/types.ts";
import type { AssistantTurn, StreamEvent, StreamOptions, ToolDef } from "./types.ts";

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly hint?: string,
	) {
		super(message);
		this.name = "ProviderError";
	}
}

/** Wrap a target URL with the CORS proxy when enabled (prefix style). */
function endpoint(url: string, settings: Settings, useProxy: boolean): string {
	if (!useProxy) return url;
	const base = settings.proxyUrl.replace(/\/+$/, "");
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

function anthropicContent(blocks: Block[]): unknown[] {
	return blocks.map((b) => {
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
	});
}

function toAnthropicMessages(messages: Message[]): unknown[] {
	return messages.map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user", // tool results ride in a user message
		content: anthropicContent(m.blocks),
	}));
}

// Opus 4.8/4.7 and the Fable/Mythos family reject temperature/top_p/top_k with
// a 400; older 4.x models still accept temperature. Only send it where valid.
function anthropicAcceptsTemperature(model: string): boolean {
	return !/(opus-4-[78])|fable|mythos/i.test(model);
}

async function streamAnthropic(settings: Settings, system: string, messages: Message[], tools: ToolDef[], opts: StreamOptions): Promise<AssistantTurn> {
	const cfg = settings.chat;
	const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
	const url = endpoint(`${base}/v1/messages`, settings, cfg.useProxy);
	const body: Record<string, unknown> = {
		model: cfg.model,
		max_tokens: cfg.maxTokens,
		system,
		stream: true,
		messages: toAnthropicMessages(messages),
		tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
	};
	if (anthropicAcceptsTemperature(cfg.model)) body["temperature"] = cfg.temperature;

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
		throw corsHint(e, cfg.useProxy);
	}
	if (!res.ok) throw await httpError(res);

	const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "end_turn" };
	const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};

	for await (const ev of sseEvents(res, opts.signal)) {
		if (ev.data === "[DONE]") break;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(ev.data);
		} catch {
			continue;
		}
		const type = msg["type"] as string;
		if (type === "content_block_start") {
			const idx = msg["index"] as number;
			const cb = msg["content_block"] as Record<string, unknown>;
			blocks[idx] = { type: cb["type"] as string, id: cb["id"] as string, name: cb["name"] as string, json: "" };
			if (cb["type"] === "tool_use") emit(opts, { type: "tool_start", id: cb["id"] as string, name: cb["name"] as string });
		} else if (type === "content_block_delta") {
			const idx = msg["index"] as number;
			const delta = msg["delta"] as Record<string, unknown>;
			if (delta["type"] === "text_delta") {
				turn.text += delta["text"] as string;
				emit(opts, { type: "text", delta: delta["text"] as string });
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
			}
		} else if (type === "message_delta") {
			const delta = msg["delta"] as Record<string, unknown>;
			if (delta && delta["stop_reason"]) turn.stopReason = delta["stop_reason"] as string;
		} else if (type === "error") {
			const err = msg["error"] as Record<string, unknown>;
			throw new ProviderError((err?.["message"] as string) ?? "stream error");
		}
	}
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

function toOpenAIMessages(system: string, messages: Message[]): unknown[] {
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
	return out;
}

async function streamOpenAI(settings: Settings, system: string, messages: Message[], tools: ToolDef[], opts: StreamOptions): Promise<AssistantTurn> {
	const cfg = settings.chat;
	const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
	const url = endpoint(`${base}/chat/completions`, settings, cfg.useProxy);
	const body = {
		model: cfg.model,
		max_tokens: cfg.maxTokens,
		temperature: cfg.temperature,
		stream: true,
		messages: toOpenAIMessages(system, messages),
		tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
	};

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
			body: JSON.stringify(body),
			signal: opts.signal ?? null,
		});
	} catch (e) {
		throw corsHint(e, cfg.useProxy);
	}
	if (!res.ok) throw await httpError(res);

	const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "stop" };
	const calls: Record<number, { id: string; name: string; args: string }> = {};

	for await (const ev of sseEvents(res, opts.signal)) {
		if (ev.data === "[DONE]") break;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(ev.data);
		} catch {
			continue;
		}
		const choice = (msg["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
		if (!choice) continue;
		const delta = choice["delta"] as Record<string, unknown> | undefined;
		if (delta?.["content"]) {
			turn.text += delta["content"] as string;
			emit(opts, { type: "text", delta: delta["content"] as string });
		}
		const tcs = delta?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
		if (tcs) {
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
	emit(opts, { type: "done", stopReason: turn.stopReason });
	return turn;
}

// ---- dispatch + helpers -----------------------------------------------------

export function streamChat(settings: Settings, system: string, messages: Message[], tools: ToolDef[], opts: StreamOptions = {}): Promise<AssistantTurn> {
	if (settings.chat.provider === "anthropic") return streamAnthropic(settings, system, messages, tools, opts);
	return streamOpenAI(settings, system, messages, tools, opts);
}

export interface TestResult {
	ok: boolean;
	message: string;
}

/** Fire a tiny non-streaming request to validate the API key, model, base URL,
 * and (CORS) connectivity for the current chat settings. */
export async function testConnection(settings: Settings): Promise<TestResult> {
	const cfg = settings.chat;
	if (!cfg.apiKey.trim()) return { ok: false, message: "No API key set." };
	if (!cfg.model.trim()) return { ok: false, message: "No model set." };

	let url: string;
	let headers: Record<string, string>;
	let body: string;
	if (cfg.provider === "anthropic") {
		const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
		url = endpoint(`${base}/v1/messages`, settings, cfg.useProxy);
		headers = { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
		body = JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] });
	} else {
		const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
		url = endpoint(`${base}/chat/completions`, settings, cfg.useProxy);
		headers = { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` };
		body = JSON.stringify({ model: cfg.model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] });
	}

	let res: Response;
	try {
		res = await fetch(url, { method: "POST", headers, body });
	} catch (e) {
		const pe = corsHint(e, cfg.useProxy);
		return { ok: false, message: `${pe.message}${pe.hint ? ` ${pe.hint}` : ""}` };
	}
	if (res.ok) {
		res.body?.cancel().catch(() => {});
		return { ok: true, message: `Connected — ${cfg.model} responded.` };
	}
	const err = await httpError(res);
	return { ok: false, message: `${err.message}${err.hint ? ` ${err.hint}` : ""}` };
}

function emit(opts: StreamOptions, ev: StreamEvent): void {
	opts.onEvent?.(ev);
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

function corsHint(e: unknown, useProxy: boolean): ProviderError {
	const msg = e instanceof Error ? e.message : String(e);
	if (e instanceof DOMException && e.name === "AbortError") return new ProviderError("Request cancelled.");
	const hint = useProxy ? "The CORS proxy may be unreachable; check the proxy URL in Settings." : "This is likely a CORS/network error. Try enabling 'Route through CORS proxy' in Settings.";
	return new ProviderError(`Network error: ${msg}`, undefined, hint);
}
