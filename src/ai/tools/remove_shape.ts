// remove_shape -- delete a shape from a layer by its index.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.removeShape,
	def: {
		name: TOOL_NAMES.removeShape,
		description: "Remove a shape from a layer by its `index` (0-based; see list_shapes). Later shapes shift down by one. Defaults to the active layer.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "integer", description: "Shape index within the layer (0-based)." },
				layer: { type: "string", description: "Layer name or id (default: the active layer)." },
				screenshot: { type: "boolean" },
			},
			required: ["index"],
		},
	},
	execute: (ctx, input) => {
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		const idx = Number(input["index"]);
		const shape = layer.shapes[idx];
		if (!shape) return { content: [text(`No shape at index ${input["index"]} in layer "${layer.name}".`)], isError: true };
		ctx.removeShape(layer.id, shape.id);
		return ctx.shaderResult(`Removed ${shape.kind} [${idx}] from layer "${layer.name}".`, input["screenshot"] === true);
	},
});
