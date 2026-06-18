// write_shader -- author the whole fragment shader. Gated to the first shader /
// full rewrite; edit_shader is preferred for changes to an existing shader.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.writeShader,
	available: (o) => o.allowWriteShader,
	def: {
		name: TOOL_NAMES.writeShader,
		description:
			"Write the WHOLE fragment shader from scratch. Use this only for the very first shader or a complete rewrite -- once a shader exists, prefer edit_shader. Provide the COMPLETE GLSL ES 3.00 body defining `void mainImage(out vec4 fragColor, in vec2 fragCoord)` (Shadertoy convention). Do NOT include #version, precision, the iChannel/iTime uniform declarations, or main() -- those are added automatically. After it compiles it is rendered and a screenshot plus compile log are returned to you.",
		parameters: {
			type: "object",
			properties: {
				source: { type: "string", description: "Full GLSL source containing at least mainImage()." },
				note: { type: "string", description: "Optional one-line summary of the change." },
			},
			required: ["source"],
		},
	},
	execute: (ctx, input) => {
		const source = String(input["source"] ?? "");
		if (!source.trim()) return { content: [text("write_shader requires non-empty source.")], isError: true };
		ctx.setShaderSource(source, true);
		const note = input["note"] ? ` (${String(input["note"])})` : "";
		return ctx.shaderResult(`Wrote shader${note}.`);
	},
});
