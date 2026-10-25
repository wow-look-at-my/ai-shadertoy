// Unit tests for the provider registry and the endpoint it composes.

import { PROVIDERS, DEFAULT_SETTINGS, mergeSettings, providerBaseUrl } from "../src/state/defaults.ts";
import { anthropicBody, anthropicHeaders, appendThinking, chatApiKey, chatEndpoint, listModels, modelsEndpoint, openaiAuthHeaders, openaiBody, reasoningPieces, streamChat, testConnection, toOpenAIMessages } from "../src/ai/providers.ts";
import type { Message, ProviderId, Settings } from "../src/state/types.ts";
import type { AssistantTurn, ToolDef } from "../src/ai/types.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}
function ok(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}

const IDS: ProviderId[] = ["anthropic", "openai", "openrouter", "ollama-cloud"];

function settingsFor(provider: ProviderId, over: Partial<Settings["chat"]> = {}): Settings {
	return { ...structuredClone(DEFAULT_SETTINGS), chat: { ...DEFAULT_SETTINGS.chat, provider, ...over } };
}

// ---- registry completeness --------------------------------------------------

// Adding an id to ProviderId without registry data would strand every lookup,
// so every id must resolve to a usable entry.
eq(Object.keys(PROVIDERS).length, IDS.length, "the registry covers exactly the known provider ids");
for (const id of IDS) {
	const info = PROVIDERS[id];
	ok(!!info, `${id} has a registry entry`);
	ok(info.label.trim().length > 0, `${id} has a label for the dropdown`);
	ok(/^https:\/\//.test(info.baseUrl), `${id} has an absolute https base URL`);
	ok(info.models.length > 0, `${id} offers at least one model preset`);
}

// ---- wire format ------------------------------------------------------------

eq(PROVIDERS.anthropic.wire, "anthropic", "Anthropic uses the Messages wire format");
for (const id of ["openai", "openrouter", "ollama-cloud"] as ProviderId[]) {
	eq(PROVIDERS[id].wire, "openai", `${id} speaks OpenAI Chat Completions`);
}

// ---- base URL: the override wins. ----------------------

eq(providerBaseUrl("openrouter", ""), "https://openrouter.ai/api/v1", "a blank override falls back to the provider default");
eq(providerBaseUrl("openrouter", "  "), "https://openrouter.ai/api/v1", "a whitespace override is still blank");
eq(providerBaseUrl("openrouter", "https://my.gateway/v1"), "https://my.gateway/v1", "an override replaces the default");


eq(chatEndpoint(settingsFor("anthropic")), "https://api.anthropic.com/v1/messages", "Anthropic posts to /v1/messages, unproxied");
eq(chatEndpoint(settingsFor("openai")), "https://api.openai.com/v1/chat/completions", "OpenAI posts to /chat/completions, unproxied");
eq(chatEndpoint(settingsFor("openrouter")), "https://openrouter.ai/api/v1/chat/completions", "OpenRouter sends CORS headers, so it is called directly");
eq(chatEndpoint(settingsFor("openai", { baseUrl: "http://localhost:8080/v1" })), "http://localhost:8080/v1/chat/completions", "OpenAI-wire Bifrost posts to its chat route");
eq(chatEndpoint(settingsFor("anthropic", { baseUrl: "http://localhost:8080/anthropic" })), "http://localhost:8080/anthropic/v1/messages", "Anthropic-wire Bifrost posts to its messages route");
eq(modelsEndpoint(settingsFor("openai", { baseUrl: "http://localhost:8080/v1" })), "http://localhost:8080/v1/models", "OpenAI-wire models use the override base");
eq(modelsEndpoint(settingsFor("anthropic", { baseUrl: "http://localhost:8080/anthropic" })), "http://localhost:8080/anthropic/v1/models?limit=1000", "Anthropic-wire models use the override base");
eq(modelsEndpoint(settingsFor("anthropic")), "https://api.anthropic.com/v1/models?limit=1000", "the default Anthropic base keeps its models path");

// Ollama Cloud answers with no access-control-allow-origin, so a direct browser
// call cannot be read. Picking it has to route through the proxy on its own --
// with useProxy still false, which is the default.
{
	const s = settingsFor("ollama-cloud");
	eq(s.chat.useProxy, false, "the stored toggle is still off");
	eq(chatEndpoint(s), "https://proxy.pazer.ai/?url=https%3A%2F%2Follama.com%2Fv1%2Fchat%2Fcompletions", "Ollama Cloud is proxied anyway");
}

// The toggle still turns the proxy on for a provider that does not require one.
eq(
	chatEndpoint(settingsFor("openrouter", { useProxy: true })),
	"https://proxy.pazer.ai/?url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1%2Fchat%2Fcompletions",
	"asking for the proxy on OpenRouter is honoured",
);

// A base-URL override is proxied too -- someone pointing Ollama Cloud at a
// gateway still cannot read a cross-origin reply without it.
eq(
	chatEndpoint(settingsFor("ollama-cloud", { baseUrl: "https://gw.example.com/v1" })),
	"https://proxy.pazer.ai/?url=https%3A%2F%2Fgw.example.com%2Fv1%2Fchat%2Fcompletions",
	"the override is what gets proxied",
);

// ---- keys -------------------------------------------------------------------

// Only the generic OpenAI-compatible provider may run keyless (a local server);
// every hosted one is blocked before the request with a useful message instead.
eq(PROVIDERS.openai.needsKey, false, "OpenAI-compatible can be keyless for a local server");
for (const id of ["anthropic", "openrouter", "ollama-cloud"] as ProviderId[]) {
	eq(PROVIDERS[id].needsKey, true, `${id} needs an API key to chat`);
}
// Both new providers serve their catalogue openly, so the model combobox fills
// itself before a key is entered.
eq(PROVIDERS.openrouter.needsKeyForModels, false, "OpenRouter lists models unauthenticated");
eq(PROVIDERS["ollama-cloud"].needsKeyForModels, false, "Ollama Cloud lists models unauthenticated");

// ---- per-provider keys ------------------------------------------------------
{
	const migrated = mergeSettings({ chat: { provider: "openrouter", apiKey: "sk-or-legacy" } } as unknown as Partial<Settings>);
	eq(migrated.chat.apiKeys.openrouter, "sk-or-legacy", "a legacy single key moves to its provider");
	eq(migrated.chat.apiKeys.anthropic, undefined, "other providers start without a key");
	const keys = mergeSettings({ chat: { provider: "anthropic", apiKeys: { anthropic: "a", openrouter: "o" } } } as unknown as Partial<Settings>);
	eq(chatApiKey(keys.chat), "a", "the active provider's key is read");
	eq(chatApiKey({ ...keys.chat, provider: "openrouter" }), "o", "another provider's key is still there");
}

// ---- credential header ------------------------------------------------------

// A base-URL override is a gateway, so its virtual key rides in x-bf-vk as well.
{
	const generic = openaiAuthHeaders({ ...DEFAULT_SETTINGS.chat, provider: "openai", apiKeys: { openai: " vk-abc " }, baseUrl: "http://localhost:8080/v1" });
	eq(generic["x-bf-vk"], "vk-abc", "the OpenAI-compatible gateway gets the trimmed key in x-bf-vk");
	eq(generic["authorization"], "Bearer vk-abc", "and it also gets the bearer form");
	eq(openaiAuthHeaders({ ...DEFAULT_SETTINGS.chat, provider: "openai", apiKeys: { openai: " " } })["x-bf-vk"], undefined, "a blank key sends no header");
	const hosted = openaiAuthHeaders({ ...DEFAULT_SETTINGS.chat, provider: "openrouter", apiKeys: { openrouter: "sk-x" } });
	eq(hosted["authorization"], "Bearer sk-x", "the hosted default keeps the bearer token");
	ok(!("x-bf-vk" in hosted), "the hosted default gets no x-bf-vk");
	const anthropic = anthropicHeaders({ ...DEFAULT_SETTINGS.chat, provider: "anthropic", apiKeys: { anthropic: "sk-ant" } });
	eq(anthropic["x-api-key"], "sk-ant", "the default Anthropic headers carry x-api-key");
	ok(!("x-bf-vk" in anthropic), "the default Anthropic endpoint gets no x-bf-vk");
	const bifrost = anthropicHeaders({ ...DEFAULT_SETTINGS.chat, provider: "anthropic", apiKeys: { anthropic: "vk" }, baseUrl: "http://localhost:8080/anthropic" });
	eq(bifrost["x-api-key"], "vk", "the Anthropic gateway keeps x-api-key");
	eq(bifrost["x-bf-vk"], "vk", "the Anthropic gateway also gets x-bf-vk");
}

// ---- reasoning capture ------------------------------------------------------
{
	const only = (delta: Record<string, unknown>) => {
		const pieces = reasoningPieces(delta);
		eq(pieces.length, 1, `one piece from ${JSON.stringify(delta)}`);
		return pieces[0];
	};
	eq(only({ reasoning: "r1" }).text, "r1", "the reasoning field is captured");
	eq(only({ reasoning_content: "r2" }).text, "r2", "the reasoning_content field is captured");
	eq(only({ reasoning: "We", reasoning_content: "We", reasoning_details: [{ format: "text", text: "We" }] }).text, "We", "details win over duplicate spellings");
	eq(only({ reasoning_details: [{ format: "text", text: "We" }] }).text, "We", "an untyped detail still carries text");
	eq(only({ reasoning: "We", reasoning_content: "We" }).text, "We", "identical string spellings count once");
	const detail = only({ reasoning_details: [{ type: "reasoning.text", text: "r3", signature: "s3" }] });
	eq(detail.text, "r3", "a reasoning.text detail is captured");
	eq(detail.signature, "s3", "its signature is kept");

	// The shape the HAR shows from deepseek V4.1 Flash via OpenRouter/Together.
	const deepseek = only({ reasoning: "Let", reasoning_details: [{ type: "reasoning.text", text: "Let", format: "unknown", index: 0 }] });
	eq(deepseek.detailType, "reasoning.text", "the detail type is kept");
	eq(deepseek.detailFormat, "unknown", "the detail format is kept");
	eq(deepseek.detailIndex, 0, "the detail index is kept");

	const encrypted = only({ reasoning_details: [{ type: "reasoning.encrypted", data: "x", format: "openai-responses-v1", id: "rs_1" }] });
	eq(encrypted.encrypted, "x", "an encrypted detail keeps its data");
	eq(encrypted.detailId, "rs_1", "and its id");
	eq(only({ reasoning: "sum", reasoning_details: [{ type: "reasoning.summary", summary: "sum" }] }).detailType, "reasoning.summary", "a summary detail is captured");

	const unknown = only({ reasoning_details: [{ type: "reasoning.future", blob: 1 }] });
	eq(JSON.stringify(unknown.raw), '{"type":"reasoning.future","blob":1}', "an unknown detail type is kept verbatim");
	eq(unknown.rawWire, "openai", "from the OpenAI wire");

	const extra = reasoningPieces({ reasoning: "more", reasoning_details: [{ type: "reasoning.text", text: "less" }] });
	eq(extra.length, 2, "text beyond the details is its own piece");
	eq(extra[1].text, "more", "and it holds the extra text");

	const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "stop", thinking: [], usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 };
	appendThinking(turn, { text: "a", signature: "" });
	appendThinking(turn, { text: "b", signature: "" });
	eq(turn.thinking.length, 1, "unsigned deltas extend one block");
	eq(turn.thinking[0].thinking, "ab", "the block accumulates the text");
	appendThinking(turn, { text: "", signature: "sig" });
	appendThinking(turn, { text: "c", signature: "" });
	eq(turn.thinking.length, 2, "text after a signature starts a new block");
	eq(turn.thinking[0].signature, "sig", "the signature stays on its block");
	eq(turn.thinking[1].thinking, "c", "the new block holds the later text");

	const streamed: AssistantTurn = { text: "", toolCalls: [], stopReason: "stop", thinking: [], usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 };
	for (const t of ["Let", " me", " look"]) for (const p of reasoningPieces({ reasoning: t, reasoning_details: [{ type: "reasoning.text", text: t, format: "unknown", index: 0 }] })) appendThinking(streamed, p);
	eq(streamed.thinking.length, 1, "chunks of one detail entry make one block");
	eq(streamed.thinking[0].thinking, "Let me look", "the block holds the whole text");
	for (const p of reasoningPieces({ reasoning_details: [{ type: "reasoning.encrypted", data: "ab", index: 1 }] })) appendThinking(streamed, p);
	for (const p of reasoningPieces({ reasoning_details: [{ type: "reasoning.encrypted", data: "cd", index: 1 }] })) appendThinking(streamed, p);
	eq(streamed.thinking.length, 2, "a new entry index starts a new block");
	eq(streamed.thinking[1].encrypted, "abcd", "encrypted chunks concatenate");
}

// ---- reasoning replay -------------------------------------------------------
const THINKING: Message = {
	id: "m2",
	role: "assistant",
	ts: 0,
	blocks: [
		{ type: "thinking", thinking: "plan", signature: "sig" },
		{ type: "text", text: "answer" },
	],
};
{
	const messages = toOpenAIMessages("sys", [THINKING], "") as Array<Record<string, unknown>>;
	eq(messages[1]["reasoning_content"], "plan", "the thinking text becomes reasoning_content");
	const details = messages[1]["reasoning_details"] as Array<Record<string, unknown>>;
	eq(details[0]["type"], "reasoning.text", "a signed block becomes a reasoning.text detail");
	eq(details[0]["text"], "plan", "the detail carries the text");
	eq(details[0]["signature"], "sig", "the detail carries the signature");

	const unsigned = toOpenAIMessages("sys", [{ ...THINKING, blocks: [{ type: "thinking", thinking: "plan", signature: "" }] }], "") as Array<Record<string, unknown>>;
	eq(unsigned[1]["reasoning_content"], "plan", "an unsigned block still replays its text");
	ok(!("reasoning_details" in unsigned[1]), "no detail without a signature");

	const compacted = openaiBody(settingsFor("openai").chat, "sys", "", [THINKING], [], { toolChoice: "none" });
	const compactMessages = compacted["messages"] as Array<Record<string, unknown>>;
	eq(compactMessages[1]["reasoning_content"], "plan", "compaction uses the same conversion");
}

// ---- Anthropic thinking replay ----------------------------------------------
{
	const body = anthropicBody(DEFAULT_SETTINGS.chat, "sys", "", [THINKING], []);
	const content = (body["messages"] as Array<Record<string, unknown>>)[0]["content"] as Array<Record<string, unknown>>;
	eq(content[0]["type"], "thinking", "the thinking block leads the Anthropic turn");
	eq(content[0]["thinking"], "plan", "the thinking text is replayed");
	eq(content[0]["signature"], "sig", "the signature is replayed");
}

// ---- every captured reasoning form replays ----------------------------------
{
	const FORMS: Message = {
		id: "m3",
		role: "assistant",
		ts: 0,
		blocks: [
			{ type: "thinking", thinking: "plan", signature: "", detailType: "reasoning.text", detailFormat: "unknown", detailIndex: 0 },
			{ type: "thinking", thinking: "", signature: "", encrypted: "ant-redacted" },
			{ type: "thinking", thinking: "", signature: "", encrypted: "oai-blob", detailType: "reasoning.encrypted", detailFormat: "openai-responses-v1", detailId: "rs_1" },
			{ type: "thinking", thinking: "?", signature: "", raw: { type: "reasoning.future", blob: 1 }, rawWire: "openai" },
			{ type: "thinking", thinking: "", signature: "", raw: { type: "future_thinking", x: 2 }, rawWire: "anthropic" },
			{ type: "text", text: "answer" },
		],
	};
	const msg = (toOpenAIMessages("sys", [FORMS], "") as Array<Record<string, unknown>>)[1];
	eq(msg["reasoning_content"], "plan", "only readable, modelled text goes in reasoning_content");
	eq(
		JSON.stringify(msg["reasoning_details"]),
		JSON.stringify([
			{ type: "reasoning.text", text: "plan", format: "unknown", index: 0 },
			{ type: "reasoning.encrypted", data: "ant-redacted" },
			{ type: "reasoning.encrypted", data: "oai-blob", format: "openai-responses-v1", id: "rs_1" },
			{ type: "reasoning.future", blob: 1 },
		]),
		"every OpenAI-wire form is rebuilt as its reasoning_details entry",
	);

	const content = (anthropicBody(DEFAULT_SETTINGS.chat, "sys", "", [FORMS], [])["messages"] as Array<Record<string, unknown>>)[0]["content"] as Array<Record<string, unknown>>;
	eq(
		JSON.stringify(content.map((c) => c["type"])),
		JSON.stringify(["thinking", "redacted_thinking", "future_thinking", "text"]),
		"Anthropic gets every form it has a shape for, and the rest stay on the message",
	);
	eq(content[1]["data"], "ant-redacted", "redacted thinking replays its data");
	eq(content[2]["x"], 2, "a raw Anthropic block replays verbatim");
}

const HISTORY: Message[] = [{ id: "m1", role: "user", ts: 0, blocks: [{ type: "text", text: "hi" }] }];
const TOOL: ToolDef = { name: "read", description: "d", parameters: { type: "object", properties: {} } };

// ---- request-path headers ---------------------------------------------------
{
	const original = globalThis.fetch;
	const seen: Array<Record<string, string>> = [];
	const json = { choices: [{ message: { content: "Hi" } }], content: [{ type: "text", text: "Hi" }], data: [] };
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		seen.push((init?.headers ?? {}) as Record<string, string>);
		return { ok: true, status: 200, json: async () => json } as Response;
	}) as typeof fetch;
	try {
		await listModels(settingsFor("openai", { baseUrl: "http://localhost:8080/v1", apiKeys: { openai: "vk" } }));
		await listModels(settingsFor("anthropic", { baseUrl: "http://localhost:8080/anthropic", apiKeys: { anthropic: "vk" } }));
		await testConnection(settingsFor("openai", { baseUrl: "http://localhost:8080/v1", apiKeys: { openai: "vk" } }));
		await testConnection(settingsFor("anthropic", { baseUrl: "http://localhost:8080/anthropic", apiKeys: { anthropic: "vk" } }));
	} finally {
		globalThis.fetch = original;
	}
	eq(seen[0]["authorization"], "Bearer vk", "the OpenAI model list carries the bearer token");
	eq(seen[0]["x-bf-vk"], "vk", "the OpenAI model list carries x-bf-vk");
	eq(seen[1]["x-api-key"], "vk", "the Anthropic model list carries x-api-key");
	eq(seen[1]["x-bf-vk"], "vk", "the Anthropic model list carries x-bf-vk");
	eq(seen[2]["authorization"], "Bearer vk", "the OpenAI test connection carries the bearer token");
	eq(seen[2]["x-bf-vk"], "vk", "the OpenAI test connection carries x-bf-vk");
	eq(seen[3]["x-api-key"], "vk", "the Anthropic test connection carries x-api-key");
	eq(seen[3]["x-bf-vk"], "vk", "the Anthropic test connection carries x-bf-vk");
}

{
	const original = globalThis.fetch;
	const seen: Array<Record<string, string>> = [];
	const openaiStream = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	const anthropicStream = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push((init?.headers ?? {}) as Record<string, string>);
		const body = String(input).includes("/v1/messages") ? anthropicStream : openaiStream;
		return { ok: true, status: 200, body: new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(body)); c.close(); } }) } as Response;
	}) as typeof fetch;
	try {
		await streamChat(settingsFor("openai", { baseUrl: "http://localhost:8080/v1", apiKeys: { openai: "vk" } }), "sys", "", HISTORY, []);
		await streamChat(settingsFor("anthropic", { baseUrl: "http://localhost:8080/anthropic", apiKeys: { anthropic: "vk" } }), "sys", "", HISTORY, []);
	} finally {
		globalThis.fetch = original;
	}
	eq(seen[0]["authorization"], "Bearer vk", "the OpenAI chat carries the bearer token");
	eq(seen[0]["x-bf-vk"], "vk", "the OpenAI chat carries x-bf-vk");
	eq(seen[1]["x-api-key"], "vk", "the Anthropic chat carries x-api-key");
	eq(seen[1]["x-bf-vk"], "vk", "the Anthropic chat carries x-bf-vk");
}

// ---- reasoning through the shipped stream path ------------------------------
{
	const original = globalThis.fetch;
	const events: string[] = [];
	const delta = { reasoning: "We", reasoning_content: "We", reasoning_details: [{ format: "text", text: "We" }] };
	const stream = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
	globalThis.fetch = (async () => ({ ok: true, status: 200, body: new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(stream)); c.close(); } }) } as Response)) as typeof fetch;
	try {
		const turn = await streamChat(settingsFor("openai", { baseUrl: "http://localhost:8080/v1", apiKeys: { openai: "vk" } }), "sys", "", HISTORY, [], { onEvent: (ev) => { if (ev.type === "thinking") events.push(ev.delta); } });
		eq(turn.thinking.length, 1, "the combined delta makes one thinking block");
		eq(turn.thinking[0].thinking, "We", "the combined delta is not duplicated");
		eq(events.join(""), "We", "the combined delta emits one thinking delta");
	} finally {
		globalThis.fetch = original;
	}
}
{
	const original = globalThis.fetch;
	const events: string[] = [];
	const stream = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ format: "text", text: "We" }] }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
	globalThis.fetch = (async () => ({ ok: true, status: 200, body: new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(stream)); c.close(); } }) } as Response)) as typeof fetch;
	try {
		const turn = await streamChat(settingsFor("openai", { baseUrl: "http://localhost:8080/v1", apiKeys: { openai: "vk" } }), "sys", "", HISTORY, [], { onEvent: (ev) => { if (ev.type === "thinking") events.push(ev.delta); } });
		eq(turn.thinking[0].thinking, "We", "an untyped detail reaches the thinking block");
		eq(events.join(""), "We", "an untyped detail emits a thinking delta");
	} finally {
		globalThis.fetch = original;
	}
}

/** Run one streamed chat against a canned SSE body and return the turn plus the request body sent. */
async function streamed(settings: Settings, sse: string): Promise<{ turn: AssistantTurn; sent: Record<string, unknown> }> {
	const original = globalThis.fetch;
	let sent: Record<string, unknown> = {};
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		sent = JSON.parse(String(init?.body));
		return { ok: true, status: 200, body: new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }) } as Response;
	}) as typeof fetch;
	try {
		return { turn: await streamChat(settings, "sys", "", HISTORY, []), sent };
	} finally {
		globalThis.fetch = original;
	}
}
const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const OPENROUTER = settingsFor("openrouter", { apiKeys: { openrouter: "sk-or" }, model: "deepseek/deepseek-v4.1-flash-1017" });

// The HAR's stream, chunk for chunk: reasoning arrives in both spellings and
// replays as reasoning_content plus its reasoning_details entry.
{
	const chunk = (t: string) => ({ choices: [{ delta: { content: "", role: "assistant", reasoning: t, reasoning_details: [{ type: "reasoning.text", text: t, format: "unknown", index: 0 }] }, finish_reason: null }] });
	const { turn, sent } = await streamed(OPENROUTER, sse([chunk("Let"), chunk(" me look"), { choices: [{ delta: { content: "" }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } }]));
	eq(turn.thinking.length, 1, "the HAR's stream makes one thinking block");
	eq(turn.thinking[0].thinking, "Let me look", "with all of its text");
	eq(turn.note, undefined, "captured reasoning raises no note");
	eq(JSON.stringify(sent["reasoning"]), '{"enabled":true}', "OpenRouter gets reasoning on at its default effort");
	const replay = (toOpenAIMessages("sys", [{ id: "a", role: "assistant", ts: 0, blocks: [{ type: "thinking", ...turn.thinking[0] }, { type: "text", text: "x" }] }], "") as Array<Record<string, unknown>>)[1];
	eq(replay["reasoning_content"], "Let me look", "the turn replays as reasoning_content");
	eq(JSON.stringify(replay["reasoning_details"]), '[{"type":"reasoning.text","text":"Let me look","format":"unknown","index":0}]', "and as its reasoning_details entry");
}
{
	const { sent } = await streamed(settingsFor("openai", { apiKeys: { openai: "k" } }), sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
	ok(!("reasoning" in sent), "a non-OpenRouter endpoint gets no reasoning field");
}
{
	const { turn } = await streamed(OPENROUTER, sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } } }]));
	ok(!!turn.note && turn.note.includes("20 reasoning tokens"), "billed reasoning that never arrived is noted on the turn");
}
{
	const { turn } = await streamed(settingsFor("anthropic", { apiKeys: { anthropic: "k" } }), sse([
		{ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "orphan" } },
		{ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "s" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "future_thinking", x: 1 } },
		{ type: "content_block_start", index: 3, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "unclosed" } },
	]));
	eq(turn.thinking.length, 4, "every Anthropic reasoning block is captured");
	eq(turn.thinking[0].encrypted, "opaque", "redacted thinking keeps its data");
	eq(turn.thinking[1].thinking, "orphan", "a delta with no start event still lands in a block");
	eq(turn.thinking[1].signature, "s", "with its signature");
	eq(turn.thinking[2].raw?.["x"], 1, "an unknown reasoning block is kept verbatim");
	eq(turn.thinking[3].thinking, "unclosed", "a block the stream never closed is kept");
}

// ---- server-reported cost ---------------------------------------------------
{
	const original = globalThis.fetch;
	const chunk = {
		choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 128406, completion_tokens: 380, cost: 0.003189768, cost_details: { upstream_inference_cost: 0.0012 } },
	};
	const stream = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
	globalThis.fetch = (async () => ({ ok: true, status: 200, body: new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode(stream)); c.close(); } }) } as Response)) as typeof fetch;
	try {
		const turn = await streamChat(settingsFor("openrouter", { apiKeys: { openrouter: "sk-or" }, model: "deepseek/deepseek-chat" }), "sys", "", HISTORY, []);
		eq(turn.usage.cost, 0.003189768, "the final usage chunk keeps the reported cost");
		eq(turn.usage.inputTokens, 128406, "the recorded prompt tokens are kept");
		eq(turn.usage.outputTokens, 380, "the recorded completion tokens are kept");
	} finally {
		globalThis.fetch = original;
	}
}

// Anthropic: adaptive thinking on current models, a token budget on 4.5-era ones,
// and temperature only where sampling is still accepted. An id this code has
// never seen is treated as new (adaptive, no temperature).
{
	const body = (model: string, over: Partial<Settings["chat"]> = {}) => anthropicBody({ ...DEFAULT_SETTINGS.chat, model, ...over }, "sys", "", HISTORY, [TOOL]);
	for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5-1", "claude-opus-6"]) {
		const b = body(m);
		eq((b["thinking"] as { type: string })?.type, "adaptive", `${m}: adaptive thinking`);
		ok(!("temperature" in b), `${m}: no temperature (rejected with a 400)`);
		eq((b["output_config"] as { effort: string })?.effort, "medium", `${m}: effort is sent`);
	}
	for (const m of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
		const b = body(m);
		eq((b["thinking"] as { type: string })?.type, "adaptive", `${m}: adaptive thinking`);
		ok(!("temperature" in b), `${m}: thinking and temperature are mutually exclusive`);
	}
	for (const m of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"]) {
		const b = body(m);
		ok(!("thinking" in b), `${m}: no thinking without an output limit`);
		ok(!("output_config" in b), `${m}: no effort (rejected with a 400)`);
		const limited = body(m, { maxTokens: 8192 });
		eq((limited["thinking"] as { type: string })?.type, "enabled", `${m}: budget thinking with a limit`);
		eq(limited["max_tokens"], 8192, `${m}: max_tokens passes through`);
	}
	eq((body("claude-opus-4-5")["output_config"] as { effort: string })?.effort, "medium", "Opus 4.5 accepts effort");
	const blank = body("claude-opus-5");
	ok(!("max_tokens" in blank), "a blank max tokens is omitted");
	ok(!("temperature" in blank), "a blank temperature is omitted");
	const sampled = body("claude-sonnet-4-5", { temperature: 0.3 });
	eq(sampled["temperature"], 0.3, "an explicit temperature passes through when no thinking is sent");
	ok(!("max_tokens" in sampled), "an omitted max tokens stays omitted");
	// The history holds tool blocks after a turn, so tools must stay defined even when the model may not call any.
	const none = anthropicBody(DEFAULT_SETTINGS.chat, "sys", "", HISTORY, [TOOL], { toolChoice: "none" });
	ok(Array.isArray(none["tools"]), "tools stay defined with tool_choice none");
	eq((none["tool_choice"] as { type: string })?.type, "none", "tool_choice none is sent");
	ok(!("tool_choice" in body("claude-opus-5")), "tool_choice is absent for a normal turn");
}

// OpenAI: reasoning models take max_completion_tokens and no temperature; every
// other model and every compatible server keeps the classic fields.
{
	const body = (over: Partial<Settings["chat"]>, opts = {}) => openaiBody({ ...settingsFor("openai", over).chat }, "sys", "", HISTORY, [TOOL], opts);
	for (const model of ["gpt-5", "gpt-5-mini", "o4-mini"]) {
		const b = body({ model, maxTokens: 2048, temperature: 0.4 });
		eq(b["max_completion_tokens"], 2048, `${model}: max_completion_tokens`);
		ok(!("max_tokens" in b) && !("temperature" in b), `${model}: no max_tokens/temperature`);
		const blank = body({ model });
		ok(!("max_completion_tokens" in blank) && !("max_tokens" in blank) && !("temperature" in blank), `${model}: blank fields are omitted`);
	}
	const classic = body({ model: "gpt-4.1", maxTokens: 4096, temperature: 0.4 });
	eq(classic["max_tokens"], 4096, "gpt-4.1 keeps max_tokens");
	eq(classic["temperature"], 0.4, "gpt-4.1 keeps temperature");
	const blank = body({ model: "gpt-4.1" });
	ok(!("max_tokens" in blank) && !("temperature" in blank), "a blank classic request omits both fields");
	const local = body({ model: "gpt-5-something", baseUrl: "http://localhost:11434/v1", maxTokens: 1234, temperature: 0.2 });
	eq(local["max_tokens"], 1234, "a self-hosted server keeps max_tokens whatever the model id");
	eq(local["temperature"], 0.2, "a self-hosted server keeps temperature");
	eq(local["cache_prompt"], true, "a self-hosted server gets cache_prompt");
	ok(!("cache_prompt" in classic), "hosted OpenAI never gets cache_prompt");
	eq(body({ model: "gpt-4.1" }, { toolChoice: "none" })["tool_choice"], "none", "tool_choice none on the OpenAI wire");
}

console.log(`ok - ${passed} assertions passed`);
