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

export interface AssistantTurn {
	text: string;
	toolCalls: ToolCall[];
	stopReason: string;
	/** Captured thinking blocks (Anthropic extended thinking), in order. Must be
	 * replayed unchanged on the next turn or tool-use continuations 400. */
	thinking: Array<{ thinking: string; signature: string }>;
}

export interface StreamOptions {
	signal?: AbortSignal;
	onEvent?: (ev: StreamEvent) => void;
}
