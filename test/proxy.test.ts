// Unit tests for the CORS-proxy URL shape. Run with:
//   node --experimental-strip-types test/proxy.test.ts
// proxy.pazer.ai reads its target from a URL-encoded `?url=` query parameter.
// A prefix-style URL (proxy + "/" + target) reaches the worker with no `url`
// parameter, so it answers 200 with its usage text -- a "success" the caller
// then tries to parse as JSON/SSE. Encoding the target is what keeps that from
// happening, so these tests pin the encoding.

import { proxied } from "../src/util/misc.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

// The documented shape, byte for byte.
eq(
	proxied(ANTHROPIC, "https://proxy.pazer.ai/"),
	"https://proxy.pazer.ai/?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages",
	"target is percent-encoded into ?url=",
);

// A proxy URL with no trailing slash, and one typed without a scheme, both land
// on the same request.
eq(proxied(ANTHROPIC, "https://proxy.pazer.ai"), proxied(ANTHROPIC, "https://proxy.pazer.ai/"), "trailing slash is irrelevant");
eq(proxied(ANTHROPIC, "proxy.pazer.ai"), proxied(ANTHROPIC, "https://proxy.pazer.ai/"), "a bare host gets https://");

// Pasting the documented URL verbatim (parameter already present, empty) must
// not produce two `url` parameters.
eq(
	proxied(ANTHROPIC, "https://proxy.pazer.ai/?url="),
	"https://proxy.pazer.ai/?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages",
	"an empty ?url= placeholder is filled, not duplicated",
);

// The target's own query string survives: `listModels` asks for ?limit=1000, and
// an unencoded `?` there would end up as a parameter of the PROXY.
{
	const url = proxied("https://api.anthropic.com/v1/models?limit=1000", "https://proxy.pazer.ai/");
	eq(url, "https://proxy.pazer.ai/?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmodels%3Flimit%3D1000", "the target's query string is encoded, not merged");
	eq(new URL(url).searchParams.get("url"), "https://api.anthropic.com/v1/models?limit=1000", "the worker reads the target back intact");
}

// A proxy that needs its own parameters (an access token, say) keeps them.
{
	const url = proxied(ANTHROPIC, "https://proxy.example.com/go?key=abc");
	eq(new URL(url).searchParams.get("key"), "abc", "the proxy's own parameters survive");
	eq(new URL(url).searchParams.get("url"), ANTHROPIC, "the target is still readable");
}

// A local OpenAI-compatible endpoint (http, port, no TLS) round-trips too.
eq(new URL(proxied("http://localhost:11434/v1/chat/completions", "https://proxy.pazer.ai/")).searchParams.get("url"), "http://localhost:11434/v1/chat/completions", "an http localhost target round-trips");

// An empty proxy setting is not a proxy: the target goes out untouched rather
// than to a malformed URL.
eq(proxied(ANTHROPIC, ""), ANTHROPIC, "an empty proxy URL leaves the target alone");
eq(proxied(ANTHROPIC, "   "), ANTHROPIC, "a whitespace-only proxy URL leaves the target alone");

console.log(`ok - ${passed} assertions passed`);
