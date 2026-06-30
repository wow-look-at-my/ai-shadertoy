// Has a shader been authored in this conversation? True once init_shader or
// edit_shader has run (in either tool mode), or once the history has been
// compacted (the original init_shader tool_use is gone from the recap, but the
// shader still exists, so init_shader must stay refused). Pure + DOM-free so it
// can run both in the tool's execution guard and in unit tests.
//
// This is the EXECUTION-time guard for init_shader. It used to gate init_shader
// out of the advertised tools array, but that shifted the prompt-cache prefix
// before the system cache breakpoint every turn -- so the tool set must stay
// byte-stable and the guard moved here instead (see init_shader.ts).

import type { Message } from "../../state/types.ts";
import { hasCompactionSummary } from "../compact.ts";
import { TOOL_NAMES } from "./names.ts";

export function shaderAuthored(messages: Message[]): boolean {
	const isShaderTool = (n: string) => n === TOOL_NAMES.initShader || n === TOOL_NAMES.editShader;
	if (hasCompactionSummary(messages)) return true;
	return messages.some(
		(m) => m.role === "assistant" && ((m.textTools?.some(isShaderTool) ?? false) || m.blocks.some((b) => b.type === "tool_use" && isShaderTool(b.name))),
	);
}
