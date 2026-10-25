// Per-model pricing + context windows for the chat usage indicator (cost and context-window %).

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

// First matching pattern wins; keep most-specific entries first.
const TABLE: Array<[RegExp, ModelInfo]> = [
	// Anthropic (authoritative).
	[/(fable|mythos)-5-1/, { rate: { in: 10, out: 50, cacheRead: 0.25, cacheWrite: 12.5 }, context: 1_000_000 }],
	[/(fable|mythos)-/, { rate: { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 }, context: 1_000_000 }],
	[/opus-5|opus-4-[678]/, { rate: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }, context: 1_000_000 }],
	[/opus-4-5/, { rate: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 }, context: 200_000 }],
	[/opus-4/, { rate: { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 }, context: 200_000 }],
	[/sonnet-5/, { rate: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 }, context: 1_000_000 }],
	[/sonnet-4-6/, { rate: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }, context: 1_000_000 }],
	[/sonnet-4/, { rate: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }, context: 200_000 }],
	[/haiku-4/, { rate: { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 }, context: 200_000 }],
	// OpenAI (approximate; cached input billed at ~0.5x, no write charge).
	[/gpt-4o-mini/, { rate: { in: 0.15, out: 0.6, cacheRead: 0.075, cacheWrite: 0 }, context: 128_000 }],
	[/gpt-4o/, { rate: { in: 2.5, out: 10, cacheRead: 1.25, cacheWrite: 0 }, context: 128_000 }],
	[/gpt-4\.1-mini/, { rate: { in: 0.4, out: 1.6, cacheRead: 0.1, cacheWrite: 0 }, context: 1_000_000 }],
	[/gpt-4\.1-nano/, { rate: { in: 0.1, out: 0.4, cacheRead: 0.025, cacheWrite: 0 }, context: 1_000_000 }],
	[/gpt-4\.1/, { rate: { in: 2, out: 8, cacheRead: 0.5, cacheWrite: 0 }, context: 1_000_000 }],
];

function find(model: string): ModelInfo | undefined {
	const m = model.toLowerCase();
	for (const [re, info] of TABLE) if (re.test(m)) return info;
	const slash = m.lastIndexOf("/");
	if (slash >= 0) {
		const tail = m.slice(slash + 1);
		for (const [re, info] of TABLE) if (re.test(tail)) return info;
	}
	return undefined;
}

// Context windows the endpoint itself published (its /models listing), by model id.
const published = new Map<string, number>();

/** Record the context windows an endpoint's model listing reported. */
export function recordContextWindows(windows: Map<string, number>): void {
	for (const [id, tokens] of windows) published.set(id.toLowerCase(), tokens);
}

/** The model's context window: what its endpoint published, else the table, else unknown. */
export function modelContextWindow(model: string): number | undefined {
	return published.get(model.toLowerCase()) ?? find(model)?.context;
}

/** True when the model's context window is known. */
export function hasContextWindow(model: string): boolean {
	return modelContextWindow(model) !== undefined;
}

export function hasPricing(model: string, u?: Usage): boolean {
	return (u?.cost !== undefined && Number.isFinite(u.cost)) || find(model)?.rate !== undefined;
}

/** Cost in USD for one request's usage, or null when neither the server nor the
 * local table gives a cost. The server-reported cost wins; token math is the
 * fallback. */
export function messageCost(model: string, u: Usage): number | null {
	if (u.cost !== undefined && Number.isFinite(u.cost)) return u.cost;
	const rate = find(model)?.rate;
	if (!rate) return null;
	const cacheRead = u.cacheReadTokens ?? 0;
	const cacheWrite = u.cacheWriteTokens ?? 0;
	return (u.inputTokens * rate.in + u.outputTokens * rate.out + cacheRead * rate.cacheRead + cacheWrite * rate.cacheWrite) / PER_M;
}

export function cachePct(u: Usage): number | undefined {
	if (u.cacheReadTokens === undefined) return undefined;
	const totalIn = u.inputTokens + u.cacheReadTokens + (u.cacheWriteTokens ?? 0);
	return totalIn > 0 ? (u.cacheReadTokens / totalIn) * 100 : 0;
}
