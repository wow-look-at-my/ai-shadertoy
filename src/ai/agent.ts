// Orchestrates a full agent turn: stream the assistant response, execute any
// tool calls, feed the results (including rendered screenshots) back, and loop
// until the model stops calling tools. Tool execution itself lives in the store
// (it owns the renderer, project, and assets); this module only drives the
// conversation.

import type { ImageBlock, Message, Settings, TextBlock } from "../state/types.ts";
import type { ToolDef } from "./types.ts";
import { streamChat } from "./providers.ts";
import { uid } from "../util/misc.ts";

export interface ToolResult {
	content: Array<TextBlock | ImageBlock>;
	isError?: boolean;
}

export interface AgentCallbacks {
	onTurnStart(): void;
	onAssistantDelta(text: string): void;
	onToolActivity(name: string, phase: "start" | "done", detail?: string): void;
	onMessage(msg: Message): void; // a finalized message; caller persists + renders
	signal?: AbortSignal;
}

const MAX_ITERATIONS = 12;

export async function runAgent(
	settings: Settings,
	systemPrompt: () => string,
	messages: Message[],
	tools: ToolDef[],
	applyTool: (name: string, input: unknown) => Promise<ToolResult>,
	cb: AgentCallbacks,
): Promise<void> {
	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		cb.onTurnStart();
		const turn = await streamChat(settings, systemPrompt(), messages, tools, {
			signal: cb.signal,
			onEvent: (ev) => {
				if (ev.type === "text") cb.onAssistantDelta(ev.delta);
				else if (ev.type === "tool_start") cb.onToolActivity(ev.name, "start");
			},
		});

		const assistantMsg: Message = {
			id: uid("m_"),
			role: "assistant",
			ts: Date.now(),
			blocks: [
				...(turn.text ? [{ type: "text", text: turn.text } as TextBlock] : []),
				...turn.toolCalls.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input })),
			],
		};
		messages.push(assistantMsg);
		cb.onMessage(assistantMsg);

		if (turn.toolCalls.length === 0) return;

		const resultBlocks: Message["blocks"] = [];
		for (const tc of turn.toolCalls) {
			let result: ToolResult;
			try {
				result = await applyTool(tc.name, tc.input);
			} catch (e) {
				result = { content: [{ type: "text", text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
			}
			cb.onToolActivity(tc.name, "done", result.isError ? "error" : undefined);
			resultBlocks.push({ type: "tool_result", toolUseId: tc.id, content: result.content, isError: result.isError ?? false });
		}

		const toolMsg: Message = { id: uid("m_"), role: "tool", ts: Date.now(), blocks: resultBlocks };
		messages.push(toolMsg);
		cb.onMessage(toolMsg);

		if (cb.signal?.aborted) return;
	}

	const note: Message = {
		id: uid("m_"),
		role: "assistant",
		ts: Date.now(),
		blocks: [{ type: "text", text: `(Stopped after ${MAX_ITERATIONS} tool iterations. Send another message to continue.)` }],
	};
	messages.push(note);
	cb.onMessage(note);
}
