// init_shader -- author the whole fragment shader. Meant for the first shader /
// a deliberate full rewrite; edit_shader is preferred for changes to an existing
// shader. The tool is ALWAYS advertised (it must stay in the tools array for the
// whole conversation, or the prompt-cache prefix before the system cache
// breakpoint shifts and every turn is billed uncached). The "don't clobber an
// authored shader" safety is enforced at EXECUTION time below, not by dropping
// the tool from the offered set.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { shaderAuthored } from "./shader_authored.ts";

registerTool({
	name: TOOL_NAMES.initShader,
	def: {
		name: TOOL_NAMES.initShader,
		description:
			"INITIALIZE the shader: write the WHOLE fragment shader from scratch. Use ONLY for the first shader of a project or a deliberate complete rewrite -- for ANY change to an existing shader use edit_shader instead (do not re-init). Once a shader has been authored this turn or earlier, init_shader is REFUSED (it would overwrite the existing work) -- use edit_shader. Provide the COMPLETE GLSL ES 3.00 body defining `void mainImage(out vec4 fragColor, in vec2 fragCoord)` (Shadertoy convention). Do NOT include #version, precision, the iChannel/iTime uniform declarations, or main() -- those are added automatically. After it compiles it is rendered and the compile log is returned (set screenshot:true to get the rendered frame too).",
		parameters: {
			type: "object",
			properties: {
				source: { type: "string", description: "Full GLSL source containing at least mainImage()." },
				note: { type: "string", description: "Optional one-line summary of the change." },
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result so you can see it (default false). Set true when you want to check this change visually." },
			},
			required: ["source"],
		},
	},
	execute: (ctx, input) => {
		// Execution-time guard (replaces the old offer-time gate, which broke the
		// prompt cache by changing the advertised tools mid-conversation): once a
		// shader exists, refuse rather than overwrite it.
		if (shaderAuthored(ctx.project.messages)) {
			return { content: [text("A shader already exists -- use edit_shader instead; init_shader would overwrite it.")], isError: true };
		}
		const source = String(input["source"] ?? "");
		if (!source.trim()) return { content: [text("init_shader requires non-empty source.")], isError: true };
		const pass = ctx.resolvePass(); // the output ("Image") pass
		if (!pass) return { content: [text("No output pass to initialize.")], isError: true };
		ctx.setPassSource(pass.id, source, true);
		const note = input["note"] ? ` (${String(input["note"])})` : "";
		return ctx.shaderResult(`Initialized shader${note}.`, input["screenshot"] === true);
	},
});
