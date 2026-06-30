// Unit tests for prompt-cache usage accounting. Run with:
//   node --experimental-strip-types test/cache.test.ts
// Covers the two pure pieces of the cost/cache surface: `cachePct` (the % cached
// indicator) and `messageCost` (the spend formula). The cardinal rule under test
// is HONESTY: the cache-hit rate and the spend come ONLY from server-reported
// token counts. Nothing is estimated or inferred — when the server omits the
// cache-read count, the indicator is undefined ("n/a"), and the cost formula
// prices real counts at their published rates.

import { cachePct, messageCost } from "../src/ai/pricing.ts";
import type { Usage } from "../src/ai/types.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}
function close(a: number, b: number, msg: string, tol = 1e-9): void {
	if (Math.abs(a - b) > tol) throw new Error(`FAIL: ${msg} (got ${a}, want ${b})`);
	passed++;
}

// ---- cachePct: tri-state, server-truth only -------------------------------

// (a) Server omitted the cache-read count -> undefined ("n/a"), never a guess.
eq(cachePct({ inputTokens: 1000, outputTokens: 50 }), undefined, "no cacheReadTokens => undefined (n/a)");
eq(cachePct({ inputTokens: 1000, outputTokens: 50, cacheWriteTokens: 200 }), undefined, "cacheWrite present but no cacheRead => still undefined");

// (b) An explicit server-reported 0 is a real figure -> 0%, NOT undefined.
eq(cachePct({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0 }), 0, "explicit cacheRead 0 => 0% (not n/a)");

// (b) A real non-zero count reflects the exact server-reported share.
// Anthropic shape: inputTokens is the UNCACHED remainder; total = in + read + write.
close(cachePct({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 900 }), 90, "900 read of 1000 total => 90%");
close(cachePct({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 800, cacheWriteTokens: 100 }), 80, "800 read of 1000 total (incl. write) => 80%");
close(cachePct({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 500 }), 100, "all input cached => 100%");

// Degenerate: a reported read count but zero total input -> 0 (no division blowup).
eq(cachePct({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }), 0, "zero total with reported 0 => 0%");

// ---- messageCost: real counts × published rates, never cheap-by-default ----

// Opus rates (per 1M): in 5, out 25, cacheRead 0.5 (0.1x base), cacheWrite 6.25 (1.25x base).
// A full CACHE-WRITE turn must be priced at the write premium, NOT the read discount.
{
	const writeTurn: Usage = { inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
	const cost = messageCost("claude-opus-4-8", writeTurn)!;
	// 1,000,000 write * 6.25/1e6 + 100 out * 25/1e6 = 6.25 + 0.0025 = 6.2525
	close(cost, 6.2525, "full cache-WRITE turn priced at 1.25x write premium");
	// Same token volume as a cache-READ would have cost 1,000,000 * 0.5/1e6 = 0.5 —
	// proving write is NOT billed cheap like a read.
	const asRead: Usage = { inputTokens: 0, outputTokens: 100, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
	close(messageCost("claude-opus-4-8", asRead)!, 0.5025, "the same volume as a cache-READ is ~12.5x cheaper");
}

// A no-cache turn prices the prompt at FULL base input rate — never cheap.
{
	const noCache: Usage = { inputTokens: 1_000_000, outputTokens: 0 };
	close(messageCost("claude-opus-4-8", noCache)!, 5, "no-cache turn billed at full 5/1M base input");
}

// A turn that mixes all four classes sums them at their own rates (no double-count).
{
	const mixed: Usage = { inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 300_000 };
	// 200k*5 + 100k*25 + 500k*0.5 + 300k*6.25, all /1e6
	// = 1.0 + 2.5 + 0.25 + 1.875 = 5.625
	close(messageCost("claude-opus-4-8", mixed)!, 5.625, "mixed turn sums each class at its own rate");
}

// Undefined cache counts contribute 0 to cost (we never invent cached tokens to bill).
{
	const omitted: Usage = { inputTokens: 1_000_000, outputTokens: 0 };
	const explicitZero: Usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	close(messageCost("claude-opus-4-8", omitted)!, messageCost("claude-opus-4-8", explicitZero)!, "omitted cache counts cost the same as explicit 0");
}

// Unknown model => no cost (tokens-only display), not a fabricated number.
eq(messageCost("some-unknown-model", { inputTokens: 1000, outputTokens: 100 }), null, "unknown model => null (no cost)");

console.log(`ok - ${passed} assertions passed`);
