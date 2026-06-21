// remove_pass -- delete a pass from the graph. Any channel that sampled it is
// reset to empty. The output pass cannot be left undefined: removing the output
// promotes another pass to output.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.removePass,
	def: {
		name: TOOL_NAMES.removePass,
		description: "Remove a pass from the render graph by name. Channels in other passes that referenced it are cleared. You cannot remove the only pass.",
		parameters: {
			type: "object",
			properties: {
				pass: { type: "string", description: "Name of the pass to remove." },
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result." },
			},
			required: ["pass"],
		},
	},
	execute: (ctx, input) => {
		const name = String(input["pass"] ?? "");
		const pass = ctx.resolvePass(name);
		if (!pass) return { content: [text(`No pass named "${name}". Use list_passes.`)], isError: true };
		const res = ctx.removePass(pass.id);
		if (!res.ok) return { content: [text(res.error ?? "Could not remove pass.")], isError: true };
		return ctx.shaderResult(`Removed pass "${pass.name}".`, input["screenshot"] === true);
	},
});
