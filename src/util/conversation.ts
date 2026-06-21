// Helpers for editing the stored conversation (chat edit/delete). Kept pure and
// DOM-free so the index math -- which must never split a tool_use from its
// tool_result (an orphaned pair 400s the next provider request) -- is testable.

import type { Message } from "../state/types.ts";

/** A real user prompt: the boundary that starts a conversation "round". The
 * tool-output rows fed back to the model (role "user" with `toolOutput`, or role
 * "tool") are NOT boundaries -- they belong to the round they answer. */
export function isTurnStart(m: Message): boolean {
	return m.role === "user" && !m.toolOutput;
}

/** Whether a message may be deleted/edited from the chat UI. Only real user
 * prompts and assistant replies qualify: deleting either removes a [message, end
 * of round) span that always contains whole tool_use/tool_result pairs. The
 * auto-generated tool-result / tool-output rows are NOT independently deletable
 * (removing one would strand its partner); they ride along with their round. */
export function isDeletable(m: Message): boolean {
	return isTurnStart(m) || m.role === "assistant";
}

/** Exclusive end index of the round containing message index `from`: the index
 * of the next real user message, or the list length if there is none. */
export function roundEndIndex(messages: Message[], from: number): number {
	for (let j = from + 1; j < messages.length; j++) {
		if (isTurnStart(messages[j])) return j;
	}
	return messages.length;
}

/** Which messages a "delete" on message `id` should remove, as a [start, count]
 * splice range. Deleting a user prompt drops its whole round; deleting an
 * assistant reply drops it through the end of its round (sweeping up the tool
 * results it produced). Either way complete rounds remain on both sides, so no
 * tool_use is ever left without its tool_result. Returns null if `id` is gone or
 * names a non-deletable row (see isDeletable) -- so the helper can never be
 * coaxed into orphaning a tool pair, independent of the UI's affordances. */
export function deletionRange(messages: Message[], id: string): { start: number; count: number } | null {
	const start = messages.findIndex((m) => m.id === id);
	if (start === -1 || !isDeletable(messages[start])) return null;
	return { start, count: roundEndIndex(messages, start) - start };
}
