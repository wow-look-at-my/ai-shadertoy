// remove_mask -- remove a layer's mask (the layer then composites unmasked).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.removeMask,
	def: {
		name: TOOL_NAMES.removeMask,
		description: "Remove a layer's mask, so the layer composites normally again.",
		parameters: {
			type: "object",
			properties: {
				layer: { type: "string", description: "Masked layer (name or id; default: the active layer)." },
				screenshot: { type: "boolean" },
			},
		},
	},
	execute: (ctx, input) => {
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		ctx.removeMask(layer.id);
		return ctx.shaderResult(`Removed the mask from layer "${layer.name}".`, input["screenshot"] === true);
	},
});
