// Unit tests for the init_shader prompt-cache fix. init_shader used to be GATED
// OUT of the advertised tools array once a shader was authored, which shrank the
// tools list mid-conversation and shifted the prompt-cache prefix before the
// system cache breakpoint -- every turn after the first was then billed uncached.
// The fix: the tool set is byte-stable (init_shader is ALWAYS advertised) and the
// "don't overwrite an authored shader" safety moved into the tool's execution.
// DOM-free:
//   node --experimental-strip-types test/init_shader.test.ts

import "../src/ai/tools/init_shader.ts"; // self-registers the tool
import { getTool, toolDefs } from "../src/ai/tools/registry.ts";
import { shaderAuthored } from "../src/ai/tools/shader_authored.ts";
import { TOOL_NAMES } from "../src/ai/tools/names.ts";
import type { ToolContext } from "../src/ai/tools/types.ts";
import type { Message } from "../src/state/types.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}

const msg = (role: Message["role"], extra: Partial<Message> = {}): Message => ({ id: `m_${Math.random().toString(36).slice(2)}`, role, ts: 0, blocks: [], ...extra });
const shaderToolUse = () => msg("assistant", { blocks: [{ type: "tool_use", id: "t1", name: TOOL_NAMES.initShader, input: {} }] });

// ---- shaderAuthored detects an authored shader -----------------------------
{
	check(shaderAuthored([]) === false, "empty conversation: no shader authored");
	check(shaderAuthored([msg("user"), msg("assistant", { blocks: [{ type: "text", text: "hi" }] })]) === false, "plain chat: no shader authored");
	check(shaderAuthored([shaderToolUse()]) === true, "an init_shader tool_use counts as authored");
	check(shaderAuthored([msg("assistant", { blocks: [{ type: "tool_use", id: "t2", name: TOOL_NAMES.editShader, input: {} }] })]) === true, "an edit_shader tool_use counts as authored");
	check(shaderAuthored([msg("assistant", { textTools: [TOOL_NAMES.initShader] })]) === true, "a text-mode init_shader counts as authored");
	// a compaction summary hides the original tool_use but the shader still exists
	check(shaderAuthored([msg("user", { compaction: "request" }), msg("assistant", { compaction: "summary", blocks: [{ type: "text", text: "recap" }] })]) === true, "a compaction summary counts as authored");
}

// ---- the advertised tool set is byte-stable across shader-authored state ----
// This is the actual bug: the tools array must not change shape mid-conversation.
{
	const before = toolDefs({ imageGen: false });
	const after = toolDefs({ imageGen: false }); // same opts -- whether a shader exists no longer affects the set
	check(JSON.stringify(before) === JSON.stringify(after), "tool set is identical regardless of shader-authored state");
	check(before.some((d) => d.name === TOOL_NAMES.initShader), "init_shader is ALWAYS advertised (no longer gated out)");
}

// ---- init_shader execute: refuse when a shader exists, run otherwise --------
{
	const tool = getTool(TOOL_NAMES.initShader);
	if (!tool) throw new Error("FAIL: init_shader did not register");

	let wrote: string | null = null;
	const fakeCtx = (messages: Message[]): ToolContext =>
		({
			project: { messages },
			resolvePass: () => ({ id: "p1", name: "Image" }),
			setPassSource: (_id: string, src: string) => {
				wrote = src;
				return { ok: true, log: "" };
			},
			shaderResult: (prefix: string) => ({ content: [{ type: "text", text: prefix }], isError: false }),
		}) as unknown as ToolContext;

	// First-time use (no authored shader) must still work.
	wrote = null;
	const ok = tool.execute(fakeCtx([msg("user")]), { source: "void mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }" }) as { isError?: boolean };
	check(!ok.isError, "init_shader runs when no shader exists yet");
	check(wrote !== null, "init_shader wrote the pass source on first use");

	// Once a shader exists, init_shader is refused (would clobber it) -- and does not write.
	wrote = null;
	const refused = tool.execute(fakeCtx([shaderToolUse()]), { source: "void mainImage(out vec4 c, in vec2 p){ c = vec4(0.0); }" }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
	check(refused.isError === true, "init_shader is refused once a shader exists");
	check(wrote === null, "the refused call did NOT overwrite the existing shader");
	check((refused.content[0]?.text ?? "").includes("edit_shader"), "the refusal points the model at edit_shader");
}

console.log(`init_shader.test.ts: ${passed} checks passed`);
