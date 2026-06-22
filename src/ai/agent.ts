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
import type { ToolDef, Usage } from "./types.ts";
import type { ToolResult } from "./tools/index.ts";
import { getTool, text, TOOL_NAMES } from "./tools/index.ts";
import { streamChat } from "./providers.ts";
import { parseTextToolCalls } from "./texttools.ts";
import { textToolInstructions } from "./system-prompt.ts";
import { uid } from "../util/misc.ts";

export type { ToolResult } from "./tools/index.ts";

// Tools that change what's on screen. After any of these run, the model is
// shown a forced render when it tries to stop, so it always verifies its work.
const RENDER_TOOLS = new Set<string>([
	TOOL_NAMES.initShader,
	TOOL_NAMES.editShader,
	TOOL_NAMES.setUniforms,
	TOOL_NAMES.connectPins,
	TOOL_NAMES.generateTexture,
	TOOL_NAMES.addPass,
	TOOL_NAMES.removePass,
	TOOL_NAMES.setOutputPass,
	TOOL_NAMES.addLayer,
	TOOL_NAMES.removeLayer,
	TOOL_NAMES.reorderLayer,
	TOOL_NAMES.setLayer,
	TOOL_NAMES.addShape,
	TOOL_NAMES.editShape,
	TOOL_NAMES.removeShape,
	TOOL_NAMES.addMask,
	TOOL_NAMES.removeMask,
]);

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
	/** Ask the user to approve a permission-gated tool call. Resolves true to run
	 * it, false to deny (the denial is fed back to the model). */
	requestPermission(req: PermissionRequest): Promise<boolean>;
	/** Token usage + generation time for one model response (cost/context meter). */
	onUsage?(usage: Usage, durationMs: number): void;
	signal?: AbortSignal;
	/** Stable per-conversation key for OpenAI prompt-cache routing (prompt_cache_key). */
	cacheKey?: string;
}

const MAX_ITERATIONS = 12;

export async function runAgent(
	settings: Settings,
	baseSystem: () => string,
	projectState: () => string,
	messages: Message[],
	toolsFor: () => ToolDef[],
	applyTool: (name: string, input: unknown) => Promise<ToolResult>,
	cb: AgentCallbacks,
): Promise<void> {
	const textMode = settings.chat.toolMode === "text";
	let dirty = false; // shader/visual changed since the model last saw a render

	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
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

		const calls = textMode ? parseTextToolCalls(turn.text, new Set(tools.map((t) => t.name))) : turn.toolCalls;

		// Thinking blocks ride at the front of the assistant turn; Anthropic requires
		// them replayed unchanged or tool-use continuations 400.
		const thinkingBlocks = turn.thinking.map((t) => ({ type: "thinking" as const, thinking: t.thinking, signature: t.signature }));
		const assistantMsg: Message = {
			id: uid("m_"),
			role: "assistant",
			ts: Date.now(),
			blocks: textMode
				? [...thinkingBlocks, { type: "text", text: turn.text } as TextBlock]
				: [...thinkingBlocks, ...(turn.text ? [{ type: "text", text: turn.text } as TextBlock] : []), ...turn.toolCalls.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.name, input: tc.input }))],
			...(textMode ? { textTools: calls.map((c) => c.name) } : {}),
		};
		messages.push(assistantMsg);
		cb.onMessage(assistantMsg);

		if (calls.length === 0) {
			// The model wants to stop. If it changed the render since it last saw
			// one, force a final screenshot and give it one more turn to verify.
			if (dirty) {
				dirty = false;
				const shot = await applyTool(TOOL_NAMES.screenshot, {});
				const imgs = shot.content.filter((b): b is ImageBlock => b.type === "image");
				const verifyMsg: Message = {
					id: uid("m_"),
					role: "user",
					ts: Date.now(),
					toolOutput: true,
					blocks: [text("Here is the current render. Verify it matches the request -- if the colours/scale/composition look off or it's black, keep editing with edit_shader. If it looks right, briefly confirm and you're done."), ...imgs],
				};
				messages.push(verifyMsg);
				cb.onMessage(verifyMsg);
				continue;
			}
			return;
		}

		// Execute every call.
		const results: Array<{ id: string; result: ToolResult }> = [];
		for (const tc of calls) {
			// Permission-gated tools: ask the user before they take effect. A
			// denial is fed back to the model instead of running the tool.
			const tool = getTool(tc.name);
			if (tool?.requiresPermission) {
				const input = (tc.input ?? {}) as Record<string, unknown>;
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
		if (calls.some((c) => RENDER_TOOLS.has(c.name))) dirty = true;

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
