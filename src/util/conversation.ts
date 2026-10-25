// Helpers for editing the stored conversation and serializing it.

import type { Block, ImageBlock, Message, Role } from "../state/types.ts";

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

// ---- transcript export -----------------------------------------------------

export interface TranscriptImage {
	type: "image";
	mediaType: string;
	dataUrl: string;
}

export interface TranscriptText {
	type: "text";
	text: string;
}

export type TranscriptContent = TranscriptText | TranscriptImage;

export type TranscriptBlock =
	| TranscriptText
	| TranscriptImage
	| { type: "thinking"; text: string; signature: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; toolUseId: string; isError: boolean; content: TranscriptContent[] };

export interface TranscriptMessage {
	id: string;
	role: Role;
	ts: number;
	note?: string;
	compaction?: "request" | "summary";
	textTools?: string[];
	toolOutput?: boolean;
	blocks: TranscriptBlock[];
}

export interface Transcript {
	kind: "ai-shadertoy-transcript";
	version: 1;
	exportedAt: number;
	project: string;
	model: string;
	messages: TranscriptMessage[];
}

function imageContent(b: ImageBlock): TranscriptImage {
	return { type: "image", mediaType: b.mediaType, dataUrl: `data:${b.mediaType};base64,${b.data}` };
}

function transcriptBlock(b: Block): TranscriptBlock {
	switch (b.type) {
		case "text":
			return { type: "text", text: b.text };
		case "image":
			return imageContent(b);
		case "thinking":
			return { type: "thinking", text: b.thinking, signature: b.signature };
		case "tool_use":
			return { type: "tool_use", id: b.id, name: b.name, input: b.input };
		case "tool_result":
			return {
				type: "tool_result",
				toolUseId: b.toolUseId,
				isError: b.isError ?? false,
				content: b.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : imageContent(c))),
			};
	}
}

/** A chat transcript with every image embedded as a data URL. */
export function buildTranscript(messages: Message[], meta: { project: string; model: string }, now = Date.now()): Transcript {
	return {
		kind: "ai-shadertoy-transcript",
		version: 1,
		exportedAt: now,
		project: meta.project,
		model: meta.model,
		messages: messages.map((m) => ({
			id: m.id,
			role: m.role,
			ts: m.ts,
			...(m.note ? { note: m.note } : {}),
			...(m.compaction ? { compaction: m.compaction } : {}),
			...(m.textTools ? { textTools: [...m.textTools] } : {}),
			...(m.toolOutput ? { toolOutput: true } : {}),
			blocks: m.blocks.map(transcriptBlock),
		})),
	};
}

export function transcriptJson(messages: Message[], meta: { project: string; model: string }, now = Date.now()): string {
	return JSON.stringify(buildTranscript(messages, meta, now), null, 2);
}
