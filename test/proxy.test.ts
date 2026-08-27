// Unit tests for the CORS-proxy URL template. Run with:
//   node --experimental-strip-types test/proxy.test.ts
// The setting names where the target goes: {{.url}} percent-encoded (what
// proxy.pazer.ai's ?url= parameter needs) or {{.rawurl}} verbatim (what a
// path-prefix proxy needs). Getting proxy.pazer.ai's shape wrong is silent --
// it answers 200 with its usage text, which the caller reads as a success --
// so these pin both forms, and the token-less fallback that keeps an older
// saved setting working.

import { proxied, hasProxyToken } from "../src/util/misc.ts";
import { migrateProxyTemplate } from "../src/state/defaults.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const QUERY = "https://proxy.pazer.ai/?url={{.url}}";
const PREFIX = "https://cors.example.com/{{.rawurl}}";

// ---- {{.url}}: encoded, for a query parameter ------------------------------

eq(
	proxied(ANTHROPIC, QUERY),
	"https://proxy.pazer.ai/?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages",
	"{{.url}} takes the percent-encoded target",
);
eq(proxied(ANTHROPIC, "proxy.pazer.ai/?url={{.url}}"), proxied(ANTHROPIC, QUERY), "a template without a scheme gets https://");
eq(proxied(ANTHROPIC, "https://proxy.pazer.ai/?url={{ .url }}"), proxied(ANTHROPIC, QUERY), "whitespace inside the braces is allowed");

// The target's own query string is the case an unencoded substitution breaks:
// listModels asks for ?limit=1000, which would otherwise become a parameter of
// the PROXY rather than part of the target.
{
	const url = proxied("https://api.anthropic.com/v1/models?limit=1000", QUERY);
	eq(new URL(url).searchParams.get("url"), "https://api.anthropic.com/v1/models?limit=1000", "the worker reads the target back intact");
}
// An `&` in the target is the same hazard, and only encoding survives it.
eq(new URL(proxied("https://api.example.com/v1/models?a=1&b=2", QUERY)).searchParams.get("url"), "https://api.example.com/v1/models?a=1&b=2", "an & in the target does not split the parameter");

// ---- {{.rawurl}}: verbatim, for a path-prefix proxy ------------------------

eq(proxied(ANTHROPIC, PREFIX), `https://cors.example.com/${ANTHROPIC}`, "{{.rawurl}} takes the target verbatim");
eq(proxied(ANTHROPIC, "https://cors.example.com/prefix/{{.rawurl}}?mode=raw"), `https://cors.example.com/prefix/${ANTHROPIC}?mode=raw`, "the rest of the template is preserved around the token");

// ---- no token: the pre-template prefix form, so nothing regresses ----------

eq(proxied(ANTHROPIC, "https://cors.example.com/"), `https://cors.example.com/${ANTHROPIC}`, "a token-less template appends the target");
eq(proxied(ANTHROPIC, "https://cors.example.com"), proxied(ANTHROPIC, "https://cors.example.com/"), "trailing slashes do not double up");

// An empty setting is not a proxy: the target goes out untouched.
eq(proxied(ANTHROPIC, ""), ANTHROPIC, "an empty template leaves the target alone");
eq(proxied(ANTHROPIC, "   "), ANTHROPIC, "a whitespace-only template leaves the target alone");

// A local endpoint (http, port, no TLS) survives both forms.
eq(new URL(proxied("http://localhost:11434/v1/chat/completions", QUERY)).searchParams.get("url"), "http://localhost:11434/v1/chat/completions", "an http localhost target round-trips");

// ---- hasProxyToken: what the Settings field reports -------------------------

eq(hasProxyToken(QUERY), true, "{{.url}} counts as a token");
eq(hasProxyToken(PREFIX), true, "{{.rawurl}} counts as a token");
eq(hasProxyToken("https://cors.example.com/"), false, "a bare base URL has no token");

// ---- migration: a setting saved before templates existed -------------------

// The pazer default spoke ?url=, so it must keep speaking ?url= -- not silently
// flip to the prefix form the token-less fallback would otherwise give it.
eq(migrateProxyTemplate("https://proxy.pazer.ai/"), "https://proxy.pazer.ai/?url={{.url}}", "the old pazer default migrates to the query template");
eq(proxied(ANTHROPIC, migrateProxyTemplate("https://proxy.pazer.ai/")), proxied(ANTHROPIC, QUERY), "and builds the same request it used to");
// Any other saved proxy was joined as a prefix, and stays that way.
eq(migrateProxyTemplate("https://cors.example.com/"), "https://cors.example.com/{{.rawurl}}", "another saved proxy migrates to the prefix template");
eq(proxied(ANTHROPIC, migrateProxyTemplate("https://cors.example.com/")), `https://cors.example.com/${ANTHROPIC}`, "and builds the same request it used to");
// A template already written by hand is left exactly as typed.
eq(migrateProxyTemplate(QUERY), QUERY, "an explicit template is not rewritten");
eq(migrateProxyTemplate(PREFIX), PREFIX, "an explicit prefix template is not rewritten");

console.log(`ok - ${passed} assertions passed`);
