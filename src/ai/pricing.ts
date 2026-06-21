// Per-model pricing + context windows for the chat usage indicator (cost and
// context-window %). Anthropic rates are authoritative (Claude API pricing); a
// few common OpenAI models are included as a convenience. Unknown models report
// no cost (the indicator then shows only tokens/sec + context %) and fall back to
// a default context window.
//
// Rates are USD per 1,000,000 tokens. cacheRead / cacheWrite are the prompt-cache
// read and (5-minute ephemeral) write rates; Anthropic bills these at 0.1x and
// 1.25x the base input rate respectively. OpenAI does not bill cache writes, so
// cacheWrite is unused for those models (we report 0 cache-write tokens there).

import type { Usage } from "./types.ts";

interface Rate {
	in: number;
	out: number;
	cacheRead: number;
	cacheWrite: number;
}
interface ModelInfo {
	rate?: Rate; // omitted => pricing unknown
	context: number; // context window, in tokens
}

const PER_M = 1_000_000;
const DEFAULT_CONTEXT = 128_000;

// First matching pattern wins; keep most-specific entries first.
const TABLE: Array<[RegExp, ModelInfo]> = [
	// Anthropic (authoritative).
	[/opus-4/, { rate: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }, context: 1_000_000 }],
	[/(fable|mythos)-/, { rate: { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 }, context: 1_000_000 }],
	[/sonnet-4/, { rate: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }, context: 1_000_000 }],
	[/haiku-4/, { rate: { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }, context: 200_000 }],
	// OpenAI (approximate; cached input billed at ~0.5x, no write charge).
	[/gpt-4o-mini/, { rate: { in: 0.15, out: 0.6, cacheRead: 0.075, cacheWrite: 0 }, context: 128_000 }],
	[/gpt-4o/, { rate: { in: 2.5, out: 10, cacheRead: 1.25, cacheWrite: 0 }, context: 128_000 }],
	[/gpt-4\.1-mini/, { rate: { in: 0.4, out: 1.6, cacheRead: 0.1, cacheWrite: 0 }, context: 1_000_000 }],
	[/gpt-4\.1-nano/, { rate: { in: 0.1, out: 0.4, cacheRead: 0.025, cacheWrite: 0 }, context: 1_000_000 }],
	[/gpt-4\.1/, { rate: { in: 2, out: 8, cacheRead: 0.5, cacheWrite: 0 }, context: 1_000_000 }],
];

function lookup(model: string): ModelInfo {
	const m = model.toLowerCase();
	for (const [re, info] of TABLE) if (re.test(m)) return info;
	return { context: DEFAULT_CONTEXT };
}

export function modelContextWindow(model: string): number {
	return lookup(model).context;
}

export function hasPricing(model: string): boolean {
	return lookup(model).rate !== undefined;
}

/** Cost in USD for one request's usage, or null when the model's pricing is
 * unknown. Cache-read tokens bill at the read discount, cache-write tokens at the
 * write premium, the rest at the base input rate. */
export function messageCost(model: string, u: Usage): number | null {
	const rate = lookup(model).rate;
	if (!rate) return null;
	return (u.inputTokens * rate.in + u.outputTokens * rate.out + u.cacheReadTokens * rate.cacheRead + u.cacheWriteTokens * rate.cacheWrite) / PER_M;
}
