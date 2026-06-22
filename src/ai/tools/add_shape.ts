// add_shape -- add a geometry primitive (quad/circle) to a layer. Shapes are real
// instanced meshes rasterized into the layer's "geometry" input; the layer's
// graph then composites them (over the layers below, by default).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { isShapeKind, SHAPE_KINDS } from "../../gl/shapes.ts";
import { parseShapePatch, SHAPE_SCHEMA_FIELDS } from "./geometry_util.ts";

registerTool({
	name: TOOL_NAMES.addShape,
	def: {
		name: TOOL_NAMES.addShape,
		description:
			"Add a geometry primitive to a layer. Shapes paint back-to-front in the order added. Coordinates are normalized: centre (x,y) in 0..1 of the canvas (origin bottom-left), size (w,h) as a fraction of the canvas. The layer's graph turns these shapes (its iChannel bound kind=geometry) into the layer's contribution -- by default composited over the layers below. Defaults to the active layer; set `layer` to target another.",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", enum: SHAPE_KINDS, description: "Shape kind." },
				layer: { type: "string", description: "Layer name or id (default: the active layer)." },
				...SHAPE_SCHEMA_FIELDS,
				screenshot: { type: "boolean" },
			},
			required: ["kind"],
		},
	},
	execute: (ctx, input) => {
		const kind = String(input["kind"] ?? "");
		if (!isShapeKind(kind)) return { content: [text(`kind must be one of: ${SHAPE_KINDS.join(", ")}`)], isError: true };
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		const shape = ctx.addShape(layer.id, kind, parseShapePatch(input));
		if (!shape) return { content: [text("Could not add the shape.")], isError: true };
		const n = layer.shapes.length;
		return ctx.shaderResult(`Added a ${kind} to layer "${layer.name}" (now ${n} shape${n === 1 ? "" : "s"}; index ${n - 1}).`, input["screenshot"] === true);
	},
});
