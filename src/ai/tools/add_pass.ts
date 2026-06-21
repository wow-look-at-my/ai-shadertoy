// add_pass -- add a new render pass (a node in the graph). The pass renders to
// its own offscreen texture; wire it into other passes with set_channel
// (kind=pass) and/or make it the visible output with set_output_pass.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { PassFormat } from "../../state/types.ts";

const PASSTHROUGH = "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n\tvec2 uv = fragCoord / iResolution.xy;\n\tfragColor = texture(iChannel0, uv);\n}\n";

registerTool({
	name: TOOL_NAMES.addPass,
	def: {
		name: TOOL_NAMES.addPass,
		description:
			"Add a new render pass to the graph. Each pass is a full-screen fragment shader (same mainImage convention and built-in uniforms) rendering to its OWN texture at the canvas resolution; its four iChannel inputs can sample built-ins, image assets, or the output of OTHER passes (wire with set_channel kind=pass). The new pass is NOT shown until you set_output_pass it or another pass samples it. Use rgba16f format for HDR intermediates (bright sources for bloom/blur). Typical multi-pass build: add an Effect pass, add BlurX sampling Effect, add BlurY sampling BlurX, then have the output pass sample BlurY.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Short unique name for the pass (e.g. 'Effect', 'BlurX')." },
				source: { type: "string", description: "GLSL mainImage body. Defaults to a passthrough that samples iChannel0." },
				format: { type: "string", enum: ["rgba8", "rgba16f"], description: "Render-target format. rgba16f keeps HDR values (default rgba8)." },
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result." },
			},
			required: ["name"],
		},
	},
	execute: (ctx, input) => {
		const name = String(input["name"] ?? "").trim();
		if (!name) return { content: [text("add_pass requires a name.")], isError: true };
		const source = input["source"] ? String(input["source"]) : PASSTHROUGH;
		const format = (input["format"] === "rgba16f" ? "rgba16f" : "rgba8") as PassFormat;
		if (format === "rgba16f" && !ctx.renderer.supportsFloat()) {
			// Still allowed; the renderer falls back to rgba8 transparently.
		}
		const pass = ctx.addPass(name, source, format);
		return ctx.shaderResult(`Added pass "${pass.name}" (${format}). It is not visible yet — wire it with set_channel (kind=pass) or make it the output with set_output_pass.`, input["screenshot"] === true);
	},
});
