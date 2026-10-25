// Provider-neutral types for the chat client: tool definitions, streaming events, and the assembled assistant turn.

import type { ThinkingBlock } from "../state/types.ts";

export interface JSONSchema {
	type: string;
	properties?: Record<string, JSONSchema & { description?: string; enum?: unknown[]; items?: JSONSchema }>;
	items?: JSONSchema;
	required?: string[];
	description?: string;
	enum?: unknown[];
	[k: string]: unknown;
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: JSONSchema;
}

export type StreamEvent =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| { type: "tool_start"; id: string; name: string }
	| { type: "tool_args"; id: string; delta: string }
	| { type: "done"; stopReason: string };

export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface Usage {
	inputTokens: number; // input tokens billed at the full rate (uncached)
	outputTokens: number;
	// Prompt-cache token counts, ONLY ever the values the server reports.
	cacheReadTokens?: number; // served from the prompt cache (Anthropic cache_read; OpenAI cached prompt tokens)
	cacheWriteTokens?: number; // written to the prompt cache this request (Anthropic cache_creation)
	/** Server-reported request cost in USD, when the endpoint reports one. */
	cost?: number;
}

export interface AssistantTurn {
	text: string;
	toolCalls: ToolCall[];
	stopReason: string;
<<<<<<< HEAD
	/** Captured thinking blocks, in order. */
	thinking: Array<Omit<ThinkingBlock, "type">>;
	/** Something about the response the user should see on the message. */
	note?: string;
=======
	/** Captured thinking blocks (Anthropic extended thinking), in order. */
	thinking: Array<{ thinking: string; signature: string }>;
>>>>>>> origin/master
	usage: Usage;
	durationMs: number; // generation wall-clock (first token -> done), for tokens/sec
}

export interface StreamOptions {
	signal?: AbortSignal;
	onEvent?: (ev: StreamEvent) => void;
	/** Stable per-conversation routing hint for OpenAI prompt caching (`prompt_cache_key`). */
	cacheKey?: string;
	/** "none" keeps `tools` defined (a history holding tool blocks needs them) but forbids new calls; used by compaction. */
	toolChoice?: "none";
}
