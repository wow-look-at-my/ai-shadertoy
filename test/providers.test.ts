// Unit tests for the provider registry and the endpoint it composes. Run with:
//   node --experimental-strip-types test/providers.test.ts
// The property worth pinning is that picking a provider is enough: its base URL
// and, where the endpoint refuses browser calls, the CORS proxy come from the
// registry rather than from the user finding a toggle.

import { PROVIDERS, DEFAULT_SETTINGS, providerBaseUrl } from "../src/state/defaults.ts";
import { anthropicBody, chatEndpoint, openaiAuthHeaders, openaiBody } from "../src/ai/providers.ts";
import type { Message, ProviderId, Settings } from "../src/state/types.ts";
import type { ToolDef } from "../src/ai/types.ts";

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

// ---- base URL: the override wins, the default fills in ----------------------

eq(providerBaseUrl("openrouter", ""), "https://openrouter.ai/api/v1", "a blank override falls back to the provider default");
eq(providerBaseUrl("openrouter", "  "), "https://openrouter.ai/api/v1", "a whitespace override is still blank");
eq(providerBaseUrl("openrouter", "https://my.gateway/v1"), "https://my.gateway/v1", "an override replaces the default");

// ---- the endpoint a chat request goes to ------------------------------------

eq(chatEndpoint(settingsFor("anthropic")), "https://api.anthropic.com/v1/messages", "Anthropic posts to /v1/messages, unproxied");
eq(chatEndpoint(settingsFor("openai")), "https://api.openai.com/v1/chat/completions", "OpenAI posts to /chat/completions, unproxied");
eq(chatEndpoint(settingsFor("openrouter")), "https://openrouter.ai/api/v1/chat/completions", "OpenRouter sends CORS headers, so it is called directly");

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

// ---- credential header ------------------------------------------------------

// Bifrost is OpenAI-compatible and reads its virtual key from `x-bf-vk`
// verbatim, so a key without the `sk-bf-` prefix works there. The generic
// provider sends the key both ways; hosted providers get only the bearer form.
{
	const generic = openaiAuthHeaders({ ...DEFAULT_SETTINGS.chat, provider: "openai", apiKey: " vk-abc " });
	eq(generic["x-bf-vk"], "vk-abc", "the OpenAI-compatible provider sends the trimmed key in x-bf-vk");
	eq(generic["authorization"], "Bearer vk-abc", "and it also sends the bearer form");
	eq(openaiAuthHeaders({ ...DEFAULT_SETTINGS.chat, provider: "openai", apiKey: " " })["x-bf-vk"], undefined, "a blank key sends no header");
	const hosted = openaiAuthHeaders({ ...DEFAULT_SETTINGS.chat, provider: "openrouter", apiKey: "sk-x" });
	eq(hosted["authorization"], "Bearer sk-x", "hosted providers keep the bearer token");
	ok(!("x-bf-vk" in hosted), "hosted providers get no x-bf-vk");
}

// ---- request body gates: never a field the model rejects with a 400 ---------

const HISTORY: Message[] = [{ id: "m1", role: "user", ts: 0, blocks: [{ type: "text", text: "hi" }] }];
const TOOL: ToolDef = { name: "read", description: "d", parameters: { type: "object", properties: {} } };

// Anthropic: adaptive thinking on current models, a token budget on 4.5-era ones,
// and temperature only where sampling is still accepted. An id this code has
// never seen is treated as new (adaptive, no temperature).
{
	const body = (model: string) => anthropicBody({ ...DEFAULT_SETTINGS.chat, model }, "sys", "", HISTORY, [TOOL]);
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
		eq((b["thinking"] as { type: string })?.type, "enabled", `${m}: budget thinking`);
		ok(!("output_config" in b), `${m}: no effort (rejected with a 400)`);
	}
	eq((body("claude-opus-4-5")["output_config"] as { effort: string })?.effort, "medium", "Opus 4.5 accepts effort");
	// The history holds tool blocks after a turn, so tools must stay defined even
	// when the model may not call any (compaction).
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
		const b = body({ model });
		eq(b["max_completion_tokens"], DEFAULT_SETTINGS.chat.maxTokens, `${model}: max_completion_tokens`);
		ok(!("max_tokens" in b) && !("temperature" in b), `${model}: no max_tokens/temperature`);
	}
	const classic = body({ model: "gpt-4.1" });
	eq(classic["max_tokens"], DEFAULT_SETTINGS.chat.maxTokens, "gpt-4.1 keeps max_tokens");
	eq(classic["temperature"], DEFAULT_SETTINGS.chat.temperature, "gpt-4.1 keeps temperature");
	const local = body({ model: "gpt-5-something", baseUrl: "http://localhost:11434/v1" });
	ok("max_tokens" in local, "a self-hosted server keeps max_tokens whatever the model id");
	eq(local["cache_prompt"], true, "a self-hosted server gets cache_prompt");
	ok(!("cache_prompt" in classic), "hosted OpenAI never gets cache_prompt");
	eq(body({ model: "gpt-4.1" }, { toolChoice: "none" })["tool_choice"], "none", "tool_choice none on the OpenAI wire");
}

console.log(`ok - ${passed} assertions passed`);
