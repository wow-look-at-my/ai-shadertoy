// remove_layer -- delete a layer from the stack.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.removeLayer,
	def: {
		name: TOOL_NAMES.removeLayer,
		description: "Remove a layer from the document. Cannot remove the only layer. The layers above it close the gap (their 'under' input becomes the next layer down).",
		parameters: {
			type: "object",
			properties: {
				layer: { type: "string", description: "Layer name or id to remove (default: the active layer)." },
				screenshot: { type: "boolean" },
			},
		},
	},
	execute: (ctx, input) => {
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		const res = ctx.removeLayer(layer.id);
		if (!res.ok) return { content: [text(res.error ?? "Could not remove layer.")], isError: true };
		return ctx.shaderResult(`Removed layer "${layer.name}".`, input["screenshot"] === true);
	},
});
