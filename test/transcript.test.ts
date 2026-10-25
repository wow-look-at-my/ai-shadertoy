// Unit tests for the chat transcript serializer.

import { buildTranscript, transcriptJson } from "../src/util/conversation.ts";
import type { Message } from "../src/state/types.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function deep(a: unknown, b: unknown, msg: string): void {
	eq(JSON.stringify(a), JSON.stringify(b), msg);
}

const user: Message = {
	id: "u1",
	role: "user",
	ts: 1,
	blocks: [
		{ type: "text", text: "make it red" },
		{ type: "image", mediaType: "image/png", data: "AAAA" },
	],
};

const assistant: Message = {
	id: "a1",
	role: "assistant",
	ts: 2,
	note: "Cut off at the output token limit.",
	textTools: ["read"],
	blocks: [
		{ type: "thinking", thinking: "plan the edit", signature: "sig-1" },
		{ type: "text", text: "done" },
		{ type: "tool_use", id: "call_1", name: "edit_shader", input: { old: "a", new: "b" } },
	],
};

const tool: Message = {
	id: "t1",
	role: "tool",
	ts: 3,
	blocks: [
		{
			type: "tool_result",
			toolUseId: "call_1",
			content: [
				{ type: "text", text: "ok" },
				{ type: "image", mediaType: "image/jpeg", data: "BBBB" },
			],
		},
	],
};

const textResult: Message = { id: "u2", role: "user", ts: 4, toolOutput: true, blocks: [{ type: "text", text: "result" }] };
const meta = { project: "Shaded orb", model: "claude-opus-5" };
const transcript = buildTranscript([user, assistant, tool, textResult], meta, 1_700_000_000_000);

eq(transcript.kind, "ai-shadertoy-transcript", "the transcript is tagged");
eq(transcript.version, 1, "the transcript carries a format version");
eq(transcript.exportedAt, 1_700_000_000_000, "the export time is pinned");
eq(transcript.project, meta.project, "the project name is kept");
eq(transcript.model, meta.model, "the model is kept");
eq(transcript.messages.length, 4, "every message is kept");

const u = transcript.messages[0];
eq(u.id, "u1", "the user message id survives");
eq(u.role, "user", "the user role survives");
eq(u.ts, 1, "the timestamp survives");
eq(u.blocks.length, 2, "every user block is kept");
const ut = u.blocks[0];
check(ut.type === "text" && ut.text === "make it red", "text survives");
const ui = u.blocks[1];
check(ui.type === "image" && ui.mediaType === "image/png", "the image media type survives");
check(ui.type === "image" && ui.dataUrl === "data:image/png;base64,AAAA", "a user image becomes a data URL");

const a = transcript.messages[1];
eq(a.note, "Cut off at the output token limit.", "notes survive");
eq(a.textTools?.[0], "read", "text-tool names survive");
const at = a.blocks[0];
check(at.type === "thinking" && at.text === "plan the edit", "thinking text survives");
check(at.type === "thinking" && at.signature === "sig-1", "the thinking signature survives");
const au = a.blocks[2];
check(au.type === "tool_use" && au.id === "call_1", "the tool call id survives");
check(au.type === "tool_use" && au.name === "edit_shader", "the tool call name survives");
if (au.type === "tool_use") deep(au.input, { old: "a", new: "b" }, "the tool input survives");

const t = transcript.messages[2];
const tr = t.blocks[0];
check(tr.type === "tool_result" && tr.toolUseId === "call_1", "the tool-result pairing survives");
check(tr.type === "tool_result" && tr.isError === false, "the tool-result error flag survives");
if (tr.type === "tool_result") {
	eq(tr.content.length, 2, "every tool-result block is kept");
	const text = tr.content[0];
	check(text.type === "text" && text.text === "ok", "tool-result text survives");
	const image = tr.content[1];
	check(image.type === "image" && image.dataUrl === "data:image/jpeg;base64,BBBB", "a tool-result image is embedded");
}

check(transcript.messages[0].toolOutput === undefined, "an ordinary message has no toolOutput flag");
eq(transcript.messages[3].toolOutput, true, "the text-mode tool-output flag survives");

const json = transcriptJson([user, assistant, tool], meta, 1_700_000_000_000);
check(json.includes("\"data:image/png;base64,AAAA\""), "the JSON embeds the user image");
check(json.includes("\"data:image/jpeg;base64,BBBB\""), "the JSON embeds the tool-result image");
const parsed = JSON.parse(json) as { exportedAt: number; messages: Array<{ blocks: Array<{ type: string }> }> };
eq(parsed.exportedAt, 1_700_000_000_000, "the JSON round-trips");
eq(parsed.messages[1].blocks[0].type, "thinking", "the JSON keeps thinking");

console.log(`ok - ${passed} assertions passed`);
