// edit_shape -- change an existing shape's transform, colour, or style.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { parseShapePatch, SHAPE_SCHEMA_FIELDS } from "./geometry_util.ts";

registerTool({
	name: TOOL_NAMES.editShape,
	def: {
		name: TOOL_NAMES.editShape,
		description: "Edit one shape's transform / colour / style. Identify it by its `index` in the layer (0-based, the order shown by list_shapes). Only the fields you pass change. Defaults to the active layer; set `layer` to target another.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "integer", description: "Shape index within the layer (0-based; see list_shapes)." },
				layer: { type: "string", description: "Layer name or id (default: the active layer)." },
				...SHAPE_SCHEMA_FIELDS,
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
		if (!shape) return { content: [text(`No shape at index ${input["index"]} in layer "${layer.name}" (it has ${layer.shapes.length}). Use list_shapes.`)], isError: true };
		const patch = parseShapePatch(input);
		if (Object.keys(patch).length === 0) return { content: [text("Nothing to change -- pass x/y/w/h/rotation/color/cornerRadius/feather.")], isError: true };
		ctx.updateShape(layer.id, shape.id, patch);
		return ctx.shaderResult(`Edited ${shape.kind} [${idx}] in layer "${layer.name}".`, input["screenshot"] === true);
	},
});
