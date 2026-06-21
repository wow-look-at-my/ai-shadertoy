// set_output_pass -- choose which pass is composited to the screen (the visible
// result). The other passes still render to their textures as inputs.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.setOutputPass,
	def: {
		name: TOOL_NAMES.setOutputPass,
		description: "Set which pass is shown on screen (the final composite). Use this once your last pass in the chain should be the visible result.",
		parameters: {
			type: "object",
			properties: {
				pass: { type: "string", description: "Name of the pass to make the output." },
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result." },
			},
			required: ["pass"],
		},
	},
	execute: (ctx, input) => {
		const name = String(input["pass"] ?? "");
		const pass = ctx.resolvePass(name);
		if (!pass) return { content: [text(`No pass named "${name}". Use list_passes.`)], isError: true };
		ctx.setOutputPass(pass.id);
		return ctx.shaderResult(`Output is now pass "${pass.name}".`, input["screenshot"] === true);
	},
});
