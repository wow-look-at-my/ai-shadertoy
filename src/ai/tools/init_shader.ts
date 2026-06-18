// init_shader -- author the whole fragment shader. Gated to the first shader /
// full rewrite; edit_shader is preferred for changes to an existing shader.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.initShader,
	available: (o) => o.allowInitShader,
	def: {
		name: TOOL_NAMES.initShader,
		description:
			"INITIALIZE the shader: write the WHOLE fragment shader from scratch. Use ONLY for the first shader of a project or a deliberate complete rewrite -- for ANY change to an existing shader use edit_shader instead (do not re-init). This tool is offered only on the first turn; once a shader exists it disappears. Provide the COMPLETE GLSL ES 3.00 body defining `void mainImage(out vec4 fragColor, in vec2 fragCoord)` (Shadertoy convention). Do NOT include #version, precision, the iChannel/iTime uniform declarations, or main() -- those are added automatically. After it compiles it is rendered and a screenshot plus compile log are returned to you.",
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
		if (!source.trim()) return { content: [text("init_shader requires non-empty source.")], isError: true };
		ctx.setShaderSource(source, true);
		const note = input["note"] ? ` (${String(input["note"])})` : "";
		return ctx.shaderResult(`Initialized shader${note}.`);
	},
});
