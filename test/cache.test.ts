// Unit tests for the local prompt-cache estimator. Run with:
//   node --experimental-strip-types test/cache.test.ts
// Pure + DOM-free: covers the prefix math that turns "Ollama doesn't report
// cached tokens" into a meter-visible estimate. Validated empirically against a
// real Ollama (its reported `cached n_tokens`) to within ~1-2% on two-turn chats.

import { estimateCachedFromPrefix } from "../src/ai/providers.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}

// No previous request (cold start / first message) -> nothing is cached.
eq(estimateCachedFromPrefix(undefined, "abcdef", 100), 0, "no prev => 0");
eq(estimateCachedFromPrefix("", "abcdef", 100), 0, "empty prev => 0");

// Identical prompt -> whole prompt cached.
eq(estimateCachedFromPrefix("abcdef", "abcdef", 100), 100, "identical => total");

// Half the leading characters match -> ~half cached.
eq(estimateCachedFromPrefix("abcXXX", "abcYYY", 100), 50, "half prefix => half");

// The real shape: stable system+history prefix, only a short differing suffix
// (new user turn + trailing project state) -> most of the prompt cached.
{
	const prefix = "x".repeat(950);
	const prev = prefix + "OLD-TRAILING-STATE"; // len 968
	const cur = prefix + "NEW-USER-MESSAGE-AND-STATE"; // len 976
	// 950 shared chars / 976 total => round(1000 * 950/976) = 973 tokens cached.
	const est = estimateCachedFromPrefix(prev, cur, 1000);
	eq(est, 973, `mostly cached (got ${est}/1000)`);
	eq(est >= 900, true, "most of the prompt is cached on the next turn");
}

// Guards: non-positive totals, and clamping when prev is longer than cur.
eq(estimateCachedFromPrefix("abc", "abcdef", 0), 0, "total<=0 => 0");
eq(estimateCachedFromPrefix("abc", "abcdef", -5), 0, "negative total => 0");
eq(estimateCachedFromPrefix("abcdefghij", "abc", 100), 100, "full match, prev longer => clamp to total");
eq(estimateCachedFromPrefix("zzz", "abcdef", 100), 0, "no common prefix => 0");

console.log(`ok - ${passed} assertions passed`);
