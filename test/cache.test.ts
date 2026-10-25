// Unit tests for prompt-cache usage accounting.

import { cachePct, hasContextWindow, hasPricing, messageCost, modelContextWindow, recordContextWindows } from "../src/ai/pricing.ts";
import { contextWindows } from "../src/ai/providers.ts";
import { shouldAutoCompact } from "../src/ai/compact.ts";
import type { Usage } from "../src/ai/types.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}
// `a` is widened to the tri-state cachePct returns.
function close(a: number | undefined, b: number, msg: string, tol = 1e-9): void {
	if (a === undefined || Math.abs(a - b) > tol) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${b})`);
	passed++;
}

// ---- cachePct: tri-state, server-truth only -------------------------------

// (a) Server omitted the cache-read count -> undefined ("n/a"), never a guess.
eq(cachePct({ inputTokens: 1000, outputTokens: 50 }), undefined, "no cacheReadTokens => undefined (n/a)");
eq(cachePct({ inputTokens: 1000, outputTokens: 50, cacheWriteTokens: 200 }), undefined, "cacheWrite present but no cacheRead => still undefined");

// (b) An explicit the first server-reported is a real figure -> 0%, NOT undefined.
eq(cachePct({ inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0 }), 0, "explicit cacheRead 0 => 0% (not n/a)");

// (b) A real non-zero count reflects the exact server-reported share.
// Anthropic shape: inputTokens is the UNCACHED remainder; total = in + read + write.
close(cachePct({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 900 }), 90, "900 read of 1000 total => 90%");
close(cachePct({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 800, cacheWriteTokens: 100 }), 80, "800 read of 1000 total (incl. write) => 80%");
close(cachePct({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 500 }), 100, "all input cached => 100%");

// Degenerate: a reported read count but zero total input -> 0 (no division blowup).
eq(cachePct({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }), 0, "zero total with reported 0 => 0%");

// ---- messageCost: real counts × published rates, never cheap-by-default ----

// A full CACHE-WRITE turn must be priced at the write premium, NOT the read discount.
{
	const writeTurn: Usage = { inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
	const cost = messageCost("claude-opus-4-8", writeTurn)!;
	close(cost, 6.2525, "full cache-WRITE turn priced at 1.25x write premium");
	const asRead: Usage = { inputTokens: 0, outputTokens: 100, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
	close(messageCost("claude-opus-4-8", asRead)!, 0.5025, "the same volume as a cache-READ is ~12.5x cheaper");
}

// A no-cache turn prices the prompt at FULL base input rate — never cheap.
{
	const noCache: Usage = { inputTokens: 1_000_000, outputTokens: 0 };
	close(messageCost("claude-opus-4-8", noCache)!, 5, "no-cache turn billed at full 5/1M base input");
}

// A turn that mixes all classes sums them at their own rates (no double-count).
{
	const mixed: Usage = { inputTokens: 200_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 300_000 };
	close(messageCost("claude-opus-4-8", mixed)!, 5.625, "mixed turn sums each class at its own rate");
}

{
	const omitted: Usage = { inputTokens: 1_000_000, outputTokens: 0 };
	const explicitZero: Usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	close(messageCost("claude-opus-4-8", omitted)!, messageCost("claude-opus-4-8", explicitZero)!, "omitted cache counts cost the same as explicit 0");
}

// Unknown model => no cost (tokens-only display), not a fabricated number.
eq(messageCost("some-unknown-model", { inputTokens: 1000, outputTokens: 100 }), null, "unknown model => null (no cost)");

// ---- server-reported cost wins over the local table -------------------------
{
	const reported: Usage = { inputTokens: 128406, outputTokens: 380, cost: 0.003189768 };
	eq(messageCost("some-unknown-model", reported), 0.003189768, "a reported cost is used for an unpriced model");
	eq(hasPricing("some-unknown-model", reported), true, "a reported cost makes the readout available");
	eq(messageCost("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0, cost: 7 }), 7, "a reported cost wins over the table");

	const absent: Usage = { inputTokens: 128406, outputTokens: 380 };
	eq(messageCost("some-unknown-model", absent), null, "an absent cost is not guessed");
	eq(hasPricing("some-unknown-model", absent), false, "an absent cost leaves the readout hidden");
	eq(hasPricing("gpt-4o", absent), true, "the local table still prices a known model");
}

// ---- context windows resolve through a provider prefix ----------------------
{
	eq(modelContextWindow("anthropic/claude-opus-5"), 1_000_000, "a provider-prefixed id resolves its base window");
	eq(hasContextWindow("anthropic/claude-opus-5"), true, "the prefixed id counts as known");
	eq(hasContextWindow("deepseek/deepseek-chat"), false, "an unknown model has no known window");
	eq(modelContextWindow("deepseek/deepseek-chat"), undefined, "an unknown model's window stays unknown, never a guess");

	const listing = [{ id: "deepseek/deepseek-v4.1-flash-1017", context_length: 1_048_576 }, { id: "claude-opus-5", max_input_tokens: 1_000_000 }, { id: "no-window" }, { id: "nested", top_provider: { context_length: 65_536 } }];
	const windows = contextWindows(listing);
	eq(windows.get("deepseek/deepseek-v4.1-flash-1017"), 1_048_576, "context_length is read");
	eq(windows.get("claude-opus-5"), 1_000_000, "Anthropic's max_input_tokens is read");
	eq(windows.get("nested"), 65_536, "top_provider.context_length is read");
	eq(windows.has("no-window"), false, "a model with no published window is left out");
	recordContextWindows(windows);
	eq(modelContextWindow("deepseek/deepseek-v4.1-flash-1017"), 1_048_576, "a recorded window is used");
	eq(hasContextWindow("deepseek/deepseek-v4.1-flash-1017"), true, "and counts as known");
	eq(shouldAutoCompact({ promptTokens: 265_749, window: modelContextWindow("deepseek/deepseek-v4.1-flash-1017") }), false, "the HAR's 265k prompt is far from compaction on a 1M window");
	eq(shouldAutoCompact({ promptTokens: 265_749, window: undefined }), false, "an unknown window never auto-compacts");
	eq(shouldAutoCompact({ promptTokens: 900_000, window: 1_048_576 }), true, "85% of a known window does");
}

console.log(`ok - ${passed} assertions passed`);
