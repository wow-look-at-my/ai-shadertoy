// Orchestrates an agent turn. Two modes:
//
// - native: tool/function calling via the provider API. The model emits
//   tool_use blocks; we execute them and feed tool_result blocks back.
// - text: for models/endpoints without tool calling. The tool catalogue is
//   described in the system prompt as forgiving XML tags; we parse the model's
//   reply text for those tags, execute them, and feed the results back as a
//   plain user message. No tool_use/tool_result blocks (which the API would
//   reject when no tools were sent).
//
// In both modes the offered tool set is recomputed each iteration, so
// init_shader drops out once the shader has been authored.

import type { ImageBlock, Message, Settings, TextBlock } from "../state/types.ts";
import type { ToolDef } from "./types.ts";
import type { ToolResult } from "./tools/index.ts";
import { text } from "./tools/index.ts";
import { streamChat } from "./providers.ts";
import { parseTextToolCalls } from "./texttools.ts";
import { textToolInstructions } from "./system-prompt.ts";
import { uid } from "../util/misc.ts";

export type { ToolResult } from "./tools/index.ts";

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
	baseSystem: () => string,
	messages: Message[],
	toolsFor: () => ToolDef[],
	applyTool: (name: string, input: unknown) => Promise<ToolResult>,
	cb: AgentCallbacks,
): Promise<void> {
	const textMode = settings.chat.toolMode === "text";

	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		cb.onTurnStart();
		const tools = toolsFor();
		const system = textMode ? `${baseSystem()}\n\n${textToolInstructions(tools)}` : baseSystem();
		const turn = await streamChat(settings, system, messages, textMode ? [] : tools, {
			signal: cb.signal,
			onEvent: (ev) => {
				if (ev.type === "text") cb.onAssistantDelta(ev.delta);
				else if (ev.type === "tool_start") cb.onToolActivity(ev.name, "start");
			},
		});

		const calls = textMode ? parseTextToolCalls(turn.text, new Set(tools.map((t) => t.name))) : turn.toolCalls;

		const assistantMsg: Message = {
			id: uid("m_"),
			role: "assistant",
			ts: Date.now(),
			blocks: textMode
				? [{ type: "text", text: turn.text } as TextBlock]
				: [...(turn.text ? [{ type: "text", text: turn.text } as TextBlock] : []), ...turn.toolCalls.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input }))],
			...(textMode ? { textTools: calls.map((c) => c.name) } : {}),
		};
		messages.push(assistantMsg);
		cb.onMessage(assistantMsg);

		if (calls.length === 0) return;

		// Execute every call.
		const results: Array<{ id: string; result: ToolResult }> = [];
		for (const tc of calls) {
			cb.onToolActivity(tc.name, "start");
			let result: ToolResult;
			try {
				result = await applyTool(tc.name, tc.input);
			} catch (e) {
				result = { content: [text(`Tool error: ${e instanceof Error ? e.message : String(e)}`)], isError: true };
			}
			cb.onToolActivity(tc.name, "done", result.isError ? "error" : undefined);
			results.push({ id: tc.id, result });
		}

		let resultMsg: Message;
		if (textMode) {
			// Results as a plain user message (text + images), no tool_result blocks.
			const blocks: Array<TextBlock | ImageBlock> = [];
			for (const { result } of results) {
				blocks.push(...result.content);
			}
			resultMsg = { id: uid("m_"), role: "user", ts: Date.now(), blocks, toolOutput: true };
		} else {
			resultMsg = {
				id: uid("m_"),
				role: "tool",
				ts: Date.now(),
				blocks: results.map(({ id, result }) => ({ type: "tool_result" as const, toolUseId: id, content: result.content, isError: result.isError ?? false })),
			};
		}
		messages.push(resultMsg);
		cb.onMessage(resultMsg);

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
