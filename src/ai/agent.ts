// Orchestrates an agent turn. Modes:
//
// - native: tool/function calling via the provider API. The model emits
// tool_use blocks; we execute them and feed tool_result blocks back. - text:
// for models/endpoints without tool calling. The tool catalogue is described
// in the system prompt as forgiving XML tags. We parse the model's reply text
// for those tags, execute them, and feed the results back as a plain user
// message.

import type { ImageBlock, Message, Settings, TextBlock } from "../state/types.ts";
import type { ToolDef, Usage } from "./types.ts";
import type { ToolResult } from "./tools/index.ts";
import { getTool, text } from "./tools/index.ts";
import { streamChat } from "./providers.ts";
import { acceptsParam } from "./modelinfo.ts";
import { parseTextToolCalls } from "./texttools.ts";
import { textToolInstructions } from "./system-prompt.ts";
import { uid } from "../util/misc.ts";

export type { ToolResult } from "./tools/index.ts";

/** A pending tool call awaiting the user's approval (see requiresPermission). */
export interface PermissionRequest {
	name: string;
	prompt: string;
	input: Record<string, unknown>;
}

export interface AgentCallbacks {
	onTurnStart(): void;
	onAssistantDelta(text: string): void;
	onThinkingDelta(text: string): void;
	onToolActivity(name: string, phase: "start" | "done", detail?: string): void;
	onMessage(msg: Message): void; // a finalized message; caller persists + renders
	/** Ask the user to approve a permission-gated tool call. */
	requestPermission(req: PermissionRequest): Promise<boolean>;
	/** Token usage + generation time for one model response (cost/context meter). */
	onUsage?(usage: Usage, durationMs: number): void;
	/** Drain any messages the user queued mid-turn (steering). */
	takeSteering?(): Message[];
	signal?: AbortSignal;
	/** Stable per-conversation key for OpenAI prompt-cache routing (prompt_cache_key). */
	cacheKey?: string;
}

const MAX_ITERATIONS = 100;

/** A tool input the provider could not parse (streaming stopped mid-JSON). */
function isTruncatedInput(input: unknown): boolean {
	return typeof input === "object" && input !== null && "_raw" in input;
}

export async function runAgent(
	settings: Settings,
	baseSystem: () => string,
	projectState: () => string,
	messages: Message[],
	toolsFor: () => ToolDef[],
	applyTool: (name: string, input: unknown) => Promise<ToolResult>,
	cb: AgentCallbacks,
): Promise<void> {
	// A model whose endpoint lists no native tool support gets the text-tag protocol.
	const textMode = settings.chat.toolMode === "text" || !acceptsParam(settings.chat.model, "tools");

	// Fold any steering messages the user queued mid-turn into the conversation
	// so the model sees them on its next response.
	const drainSteering = (): boolean => {
		const queued = cb.takeSteering?.() ?? [];
		for (const m of queued) messages.push(m);
		return queued.length > 0;
	};

	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		drainSteering(); // pick up anything queued during the previous model call / tool run
		cb.onTurnStart();
		const tools = toolsFor();
		const system = textMode ? `${baseSystem()}\n\n${textToolInstructions(tools)}` : baseSystem();
		const turn = await streamChat(settings, system, projectState(), messages, textMode ? [] : tools, {
			signal: cb.signal,
			cacheKey: cb.cacheKey,
			onEvent: (ev) => {
				if (ev.type === "text") cb.onAssistantDelta(ev.delta);
				else if (ev.type === "thinking") cb.onThinkingDelta(ev.delta);
				else if (ev.type === "tool_start") cb.onToolActivity(ev.name, "start");
			},
		});
		cb.onUsage?.(turn.usage, turn.durationMs);

		// A response cut off by max_tokens leaves a truncated tool call whose input never parsed (`_raw`).
		const truncated = turn.stopReason === "max_tokens" || turn.stopReason === "length";
		const refused = turn.stopReason === "refusal";
		const toolCalls = truncated ? turn.toolCalls.filter((tc) => !isTruncatedInput(tc.input)) : turn.toolCalls;
		const calls = textMode ? parseTextToolCalls(turn.text, new Set(tools.map((t) => t.name))) : toolCalls;

		// Thinking blocks ride at the front of the assistant turn.
		const thinkingBlocks = turn.thinking.map((t) => ({ type: "thinking" as const, ...t }));
		const textBlocks: TextBlock[] = turn.text.trim() ? [{ type: "text", text: turn.text }] : [];
		const assistantMsg: Message = {
			id: uid("m_"),
			role: "assistant",
			ts: Date.now(),
			blocks: textMode
				? [...thinkingBlocks, ...textBlocks]
				: [...thinkingBlocks, ...textBlocks, ...toolCalls.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input }))],
			...(textMode ? { textTools: calls.map((c) => c.name) } : {}),
		};
		if (truncated) {
			const limit = settings.chat.maxTokens === undefined ? "the output token limit" : `${settings.chat.maxTokens} output tokens`;
			assistantMsg.note = `Cut off at ${limit}${toolCalls.length < turn.toolCalls.length ? "; an incomplete tool call was dropped" : ""}. Raise "Max tokens" in Settings, or ask for a smaller step.`;
		}
		else if (refused) assistantMsg.note = "The model declined this request (safety refusal).";
		if (turn.note) assistantMsg.note = assistantMsg.note ? `${assistantMsg.note} ${turn.note}` : turn.note;
		// An assistant turn must carry content; the API rejects an empty one.
		if (assistantMsg.blocks.length === 0) assistantMsg.blocks.push({ type: "text", text: refused ? "(declined)" : "(no response)" });
		messages.push(assistantMsg);
		cb.onMessage(assistantMsg);

		if (calls.length === 0) {
			// No tool calls means the model is done.
			if (drainSteering()) continue;
			return;
		}

		// Execute every call.
		const results: Array<{ id: string; result: ToolResult }> = [];
		for (const tc of calls) {
			// Permission-gated tools: ask the user before they take effect.
			const tool = getTool(tc.name);
			const input = (tc.input ?? {}) as Record<string, unknown>;
			const gated = tool && (typeof tool.requiresPermission === "function" ? tool.requiresPermission(input) : tool.requiresPermission === true);
			if (tool && gated) {
				const prompt = tool.permissionPrompt ? tool.permissionPrompt(input) : `Allow ${tc.name} to run?`;
				const granted = await cb.requestPermission({ name: tc.name, prompt, input });
				if (!granted) {
					cb.onToolActivity(tc.name, "done", "denied");
					results.push({ id: tc.id, result: { content: [text(`The user DECLINED permission to run ${tc.name}; it did not run and nothing changed. Do not retry it unless the user asks -- continue or ask what they'd prefer.`)], isError: true } });
					continue;
				}
			}
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
