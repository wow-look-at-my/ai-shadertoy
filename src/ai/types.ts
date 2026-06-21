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
	cacheReadTokens: number; // served from the prompt cache (Anthropic; OpenAI cached prompt tokens)
	cacheWriteTokens: number; // written to the prompt cache this request (Anthropic only)
}

export interface AssistantTurn {
	text: string;
	toolCalls: ToolCall[];
	stopReason: string;
	usage: Usage;
	durationMs: number; // generation wall-clock (first token -> done), for tokens/sec
}

export interface StreamOptions {
	signal?: AbortSignal;
	onEvent?: (ev: StreamEvent) => void;
}
