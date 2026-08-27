// Unit tests for the provider registry and the endpoint it composes. Run with:
//   node --experimental-strip-types test/providers.test.ts
// The property worth pinning is that picking a provider is enough: its base URL
// and, where the endpoint refuses browser calls, the CORS proxy come from the
// registry rather than from the user finding a toggle.

import { PROVIDERS, DEFAULT_SETTINGS, providerBaseUrl } from "../src/state/defaults.ts";
import { chatEndpoint } from "../src/ai/providers.ts";
import type { ProviderId, Settings } from "../src/state/types.ts";

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

console.log(`ok - ${passed} assertions passed`);
