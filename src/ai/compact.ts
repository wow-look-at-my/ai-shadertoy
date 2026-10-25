// Conversation compaction. A long chat accumulates user prompts, assistant
// turns, tool calls, and (heavy) base64 screenshots, steadily filling the
// context window the chat meters.

import type { Message, Settings } from "../state/types.ts";
import type { ToolDef, Usage } from "./types.ts";
import { streamChat } from "./providers.ts";
import { uid } from "../util/misc.ts";

// The summarizer's system prompt. The summary call sends NO tools, so the model
// can't act -- it only writes the recap. Kept focused on the self-handoff goal.
export const COMPACT_SYSTEM = `You are compacting a conversation between a user and an AI agent that builds WebGL2 fragment shaders in a live sandbox (a multi-layer, multi-pass render graph plus instanced geometry). Your job is to write a detailed summary of the conversation so far so that a future instance of the agent can pick up exactly where this one left off, with the long history removed.

The agent ALWAYS receives the live project state separately (current layers, passes, shapes, uniforms, and the last compile error) and treats it as ground truth -- so do NOT transcribe shader code or restate the full current state. Capture the CONVERSATIONAL context that would otherwise be lost:
- The user's overall goal and their specific requests, in order.
- Stylistic intent: colours, mood, motion, references, and any "make it more/less X" feedback.
- Decisions and approaches taken, and importantly what was TRIED AND REJECTED (and why) so the next agent doesn't repeat dead ends.
- Any unresolved problems, bugs, or requests that are still outstanding, and the immediate next step.

Write it as a briefing to yourself (the future agent), detailed but without filler. Output ONLY the summary -- no preamble, no sign-off.`;

// The instruction the user "sends" to trigger the summary.
export const COMPACT_REQUEST_TEXT = "Summarize this entire conversation in detail for a future instance of yourself to pick up. Output only the summary.";

export interface CompactOptions {
	signal?: AbortSignal;
}

/** Measured prompt size for the compaction gate. */
export interface ContextUsage {
	promptTokens: number;
	window: number | undefined; // undefined: the model's window is not known
}

const COMPACT_AT = 0.85;

/** Auto-compact before the next send? Only from measured usage against a known window. */
export function shouldAutoCompact(usage: ContextUsage | undefined): boolean {
	return !!usage && usage.window !== undefined && usage.window > 0 && usage.promptTokens / usage.window >= COMPACT_AT;
}

/** Worth compacting on request? Measured context usage wins. The message count
 * is the fallback when no usage or window is known. */
export function shouldCompact(messages: Message[], usage?: ContextUsage): boolean {
	if (usage && usage.window) return shouldAutoCompact(usage);
	return messages.filter((m) => !m.compaction).length >= 4;
}

/** Rough token estimate for text not yet sent. Used by the compaction gate. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}

/** Whether `messages` already contains a compaction summary (history was
 * compacted at least once). */
export function hasCompactionSummary(messages: Message[]): boolean {
	return messages.some((m) => m.compaction === "summary");
}

/** The compacted conversation: a valid user -> assistant round that BEGINS the
 * new chat. The request mirrors what you'd type by hand; the assistant reply is
 * the model's recap. Ends on assistant, so the next real prompt continues a
 * clean alternation. Pure (testable). */
export function buildCompactedMessages(summary: string): Message[] {
	const now = Date.now();
	return [
		{ id: uid("m_"), role: "user", ts: now, compaction: "request", blocks: [{ type: "text", text: COMPACT_REQUEST_TEXT }] },
		{ id: uid("m_"), role: "assistant", ts: now, compaction: "summary", blocks: [{ type: "text", text: summary }] },
	];
}

/** Ask the model to summarize the conversation for a self-handoff. Sends the current history with the summarize instruction as the trailing message and returns the recap text (+ token usage). `tools` must be the set the conversation used: a history holding tool_use/tool_result blocks is rejected without a matching `tools` field. They stay defined with tool_choice "none" and the model can only write. Throws ProviderError on
 * a network/API failure or an empty summary. */
export async function summarizeConversation(settings: Settings, messages: Message[], tools: ToolDef[], opts: CompactOptions = {}): Promise<{ summary: string; usage: Usage }> {
	const turn = await streamChat(settings, COMPACT_SYSTEM, COMPACT_REQUEST_TEXT, messages, tools, { signal: opts.signal, toolChoice: "none" });
	const summary = turn.text.trim();
	if (!summary) throw new Error("The model returned an empty summary; nothing was compacted.");
	return { summary, usage: turn.usage };
}
