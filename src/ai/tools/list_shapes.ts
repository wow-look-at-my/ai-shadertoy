// list_shapes -- report a layer's geometry (its shapes, in paint order).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { describeShape } from "./geometry_util.ts";

registerTool({
	name: TOOL_NAMES.listShapes,
	def: {
		name: TOOL_NAMES.listShapes,
		description: "List a layer's shapes in paint order (index 0 first/back). Each line gives the index, kind, centre, size, rotation, and colour -- use the index with edit_shape / remove_shape. Defaults to the active layer.",
		parameters: {
			type: "object",
			properties: { layer: { type: "string", description: "Layer name or id (default: the active layer)." } },
		},
	},
	execute: (ctx, input) => {
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		if (!layer.shapes.length) return { content: [text(`Layer "${layer.name}" has no shapes. Add one with add_shape.`)] };
		const lines = layer.shapes.map((s, i) => describeShape(s, i));
		return { content: [text(`Shapes in layer "${layer.name}" (paint order):\n${lines.join("\n")}`)] };
	},
});
