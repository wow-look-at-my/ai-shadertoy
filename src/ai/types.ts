// Provider-neutral types for the chat client: tool definitions, streaming
// events, and the assembled assistant turn.

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
	// Prompt-cache token counts, ONLY ever the values the server reports. A number
	// (including 0) is a real server-reported count; `undefined` means the endpoint
	// did not report cache info at all (e.g. Ollama/local OpenAI-compatible servers
	// omit it). These are NEVER estimated/inferred — the UI shows "n/a" (not a
	// guessed value) when undefined, and an explicit 0 means 0% cached.
	cacheReadTokens?: number; // served from the prompt cache (Anthropic cache_read; OpenAI cached prompt tokens)
	cacheWriteTokens?: number; // written to the prompt cache this request (Anthropic cache_creation)
}

export interface AssistantTurn {
	text: string;
	toolCalls: ToolCall[];
	stopReason: string;
	/** Captured thinking blocks (Anthropic extended thinking), in order. Must be
	 * replayed unchanged on the next turn or tool-use continuations 400. */
	thinking: Array<{ thinking: string; signature: string }>;
	usage: Usage;
	durationMs: number; // generation wall-clock (first token -> done), for tokens/sec
}

export interface StreamOptions {
	signal?: AbortSignal;
	onEvent?: (ev: StreamEvent) => void;
	/** Stable per-conversation routing hint for OpenAI prompt caching
	 * (`prompt_cache_key`). Requests that share a prompt prefix should share this
	 * so they route to the same cache; ignored by the Anthropic path. */
	cacheKey?: string;
	/** "none" keeps `tools` defined (a history holding tool blocks needs them) but
	 * forbids new calls; used by compaction so the model only writes the recap. */
	toolChoice?: "none";
}
