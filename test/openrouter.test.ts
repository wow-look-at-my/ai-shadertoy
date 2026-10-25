// Unit tests for the OpenRouter PKCE sign-in helpers.

<<<<<<< HEAD
import { DEFAULT_SETTINGS } from "../src/state/defaults.ts";
import { base64url, completeOpenRouterSignIn, createPkcePair, draftSettings, exchangeOpenRouterCode, mergeSettingsDraft, openRouterAuthUrl, openRouterExchangeRequest, OPENROUTER_KEYS_URL, pkceChallenge, readSettingsDraft, takeCallbackCode } from "../src/ai/openrouter.ts";
=======
import { base64url, completeOpenRouterSignIn, createPkcePair, exchangeOpenRouterCode, openRouterAuthUrl, openRouterExchangeRequest, OPENROUTER_KEYS_URL, pkceChallenge, takeCallbackCode } from "../src/ai/openrouter.ts";
>>>>>>> origin/master

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}
function ok(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function deep(a: unknown, b: unknown, msg: string): void {
	eq(JSON.stringify(a), JSON.stringify(b), msg);
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => body } as Response;
}

// ---- PKCE -------------------------------------------------------------------

eq(base64url(new Uint8Array([0xfb, 0xff])), "-_8", "base64url uses the URL-safe alphabet and drops padding");
eq(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "the published PKCE vector matches");

const pair = await createPkcePair(() => Uint8Array.from({ length: 32 }, (_, i) => i));
ok(/^[A-Za-z0-9_-]{43}$/.test(pair.verifier), "the verifier is url-safe and unpadded");
eq(pair.challenge, await pkceChallenge(pair.verifier), "the challenge is the hash of the verifier");

// ---- authorize URL ----------------------------------------------------------

const auth = new URL(openRouterAuthUrl("https://example.com/app/?x=1#frag", "chal"));
eq(auth.origin + auth.pathname, "https://openrouter.ai/auth", "the authorize endpoint");
eq(auth.searchParams.get("callback_url"), "https://example.com/app/", "the callback drops the query and hash");
eq(auth.searchParams.get("code_challenge"), "chal", "the challenge is passed");
eq(auth.searchParams.get("code_challenge_method"), "S256", "the challenge method is S256");
<<<<<<< HEAD
eq(auth.searchParams.get("key_label"), "AI Shadertoy", "the key label names the app");
=======
>>>>>>> origin/master
let threw = false;
try {
	openRouterAuthUrl("file:///tmp/app.html", "chal");
} catch {
	threw = true;
}
ok(threw, "a file page cannot start sign-in");

// ---- exchange ---------------------------------------------------------------

const request = openRouterExchangeRequest("code-1", "ver-1");
eq(request.url, OPENROUTER_KEYS_URL, "the exchange posts to the keys endpoint");
eq(request.init.method, "POST", "the exchange is a POST");
deep(JSON.parse(String(request.init.body)), { code: "code-1", code_verifier: "ver-1", code_challenge_method: "S256" }, "the body carries the code, verifier, and method");

let seen = "";
const key = await exchangeOpenRouterCode(
	"code-2",
	"ver-2",
	fakeFetch((url) => {
		seen = url;
		return jsonResponse({ key: "sk-or-live" });
	}),
);
eq(key, "sk-or-live", "the returned key is extracted");
eq(seen, OPENROUTER_KEYS_URL, "the exchange used the keys endpoint");

let rejected = false;
try {
	await exchangeOpenRouterCode("code", "ver", fakeFetch(() => jsonResponse({ error: "bad" }, false, 401)));
} catch {
	rejected = true;
}
ok(rejected, "an HTTP failure rejects");

let malformed = false;
try {
	await exchangeOpenRouterCode("code", "ver", fakeFetch(() => jsonResponse({})));
} catch {
	malformed = true;
}
ok(malformed, "a response without a key rejects");

// ---- callback ---------------------------------------------------------------

deep(takeCallbackCode("https://example.com/app?code=abc&state=1#frag"), { code: "abc", url: "https://example.com/app?state=1#frag" }, "the code comes out of the URL");
eq(takeCallbackCode("https://example.com/app?state=1"), null, "no code means no callback");

const done = await completeOpenRouterSignIn("https://example.com/app?code=abc", "ver", fakeFetch(() => jsonResponse({ key: "sk-or-1" })));
eq(done?.key, "sk-or-1", "a successful callback yields the key");
eq(done?.url, "https://example.com/app", "the callback URL has no code");

const expired = await completeOpenRouterSignIn("https://example.com/app?code=abc", null);
eq(expired?.key, undefined, "an expired verifier saves no key");
ok(!!expired?.error, "an expired verifier reports a failure");

const failed = await completeOpenRouterSignIn("https://example.com/app?code=abc", "ver", fakeFetch(() => jsonResponse({}, false, 500)));
eq(failed?.key, undefined, "a failed exchange saves no key");
ok(!!failed?.error, "a failed exchange reports the reason");
eq(failed?.url, "https://example.com/app", "a failure still cleans the URL");

eq(await completeOpenRouterSignIn("https://example.com/app", "ver"), null, "no code means nothing to do");

<<<<<<< HEAD
// ---- settings draft ---------------------------------------------------------

{
	const live = { ...DEFAULT_SETTINGS.chat, provider: "openai" as const, model: "gpt-5", baseUrl: "http://localhost:8080/v1", apiKeys: { anthropic: "a", openai: "o" } };
	const draft = readSettingsDraft(draftSettings(live));
	eq(draft?.provider, "openai", "the draft keeps the provider");
	eq(draft?.model, "gpt-5", "the draft keeps the model");
	eq(draft?.baseUrl, "http://localhost:8080/v1", "the draft keeps the base URL");
	eq(draft?.apiKeys?.anthropic, "a", "the draft keeps every provider key");

	const stored = { ...DEFAULT_SETTINGS.chat, apiKeys: { "ollama-cloud": "c" } };
	const merged = mergeSettingsDraft(stored, draft);
	eq(merged.provider, "openai", "the draft replaces the stored provider");
	eq(merged.apiKeys.openai, "o", "the draft per-provider keys merge in");
	eq(merged.apiKeys["ollama-cloud"], "c", "a stored key outside the draft survives");

	const kept = mergeSettingsDraft(stored, null);
	eq(kept.apiKeys["ollama-cloud"], "c", "no draft leaves the stored keys alone");
	eq(readSettingsDraft(null), null, "no raw draft is null");
	eq(readSettingsDraft("not json"), null, "a malformed draft is ignored");
	eq(readSettingsDraft("[]"), null, "an array is not a draft");
}

=======
>>>>>>> origin/master
console.log(`ok - ${passed} assertions passed`);
