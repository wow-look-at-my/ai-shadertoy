// Helpers for editing the stored conversation (chat edit/delete).

import type { Message } from "../state/types.ts";

/** A real user prompt: the boundary that starts a conversation "round". */
export function isTurnStart(m: Message): boolean {
	return m.role === "user" && !m.toolOutput;
}

/** Whether a message may be deleted/edited from the chat UI. */
export function isDeletable(m: Message): boolean {
	return isTurnStart(m) || m.role === "assistant";
}

/** Exclusive end index of the round containing message index `from`. The index
 * of the next real user message, or the list length if there is none. */
export function roundEndIndex(messages: Message[], from: number): number {
	for (let j = from + 1; j < messages.length; j++) {
		if (isTurnStart(messages[j])) return j;
	}
	return messages.length;
}

/** Which messages a "delete" on message `id` should remove, as a [start,
 * count] splice range. Deleting a user prompt drops its whole round; deleting
 * an assistant reply drops it through the end of its round (sweeping up the
 * tool results it produced). */
export function deletionRange(messages: Message[], id: string): { start: number; count: number } | null {
	const start = messages.findIndex((m) => m.id === id);
	if (start === -1 || !isDeletable(messages[start])) return null;
	return { start, count: roundEndIndex(messages, start) - start };
}
