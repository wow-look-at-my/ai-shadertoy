// add_layer -- add a new layer ON TOP of the back-to-front stack. The new layer
// is a ready "Composite" graph wired iChannel0=under (layers below) and
// iChannel1=geometry (this layer's shapes), doing source-over.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import type { Shape } from "../../state/types.ts";
import { makeShape } from "../../state/types.ts";
import { isShapeKind, shapeDef, SHAPE_KINDS } from "../../gl/shapes.ts";
import { parseShapePatch, SHAPE_SCHEMA_FIELDS } from "./geometry_util.ts";

registerTool({
	name: TOOL_NAMES.addLayer,
	def: {
		name: TOOL_NAMES.addLayer,
		description:
			"Add a new LAYER on top of the stack (drawn in front of every layer below it). The new layer starts with a 'Composite' pass already wired iChannel0=under (the composite of the layers below) and iChannel1=geometry (this layer's shapes), doing source-over -- so it draws its geometry over what's underneath. It becomes the ACTIVE layer, so subsequent add_shape / edit_shader / set_channel calls target it. Optionally seed one shape with `shape`. To get a different blend mode, rewrite the Composite pass's mainImage (it samples under + geometry). Add more primitives with add_shape.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Layer name (e.g. 'Glow', 'Mask'). Defaults to 'Layer'." },
				shape: { type: "string", enum: SHAPE_KINDS, description: "Optionally seed the layer with one shape of this kind." },
				...SHAPE_SCHEMA_FIELDS,
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result." },
			},
		},
	},
	execute: (ctx, input) => {
		const name = input["name"] ? String(input["name"]) : "Layer";
		const shapes: Shape[] = [];
		const seed = input["shape"];
		if (typeof seed === "string" && isShapeKind(seed)) {
			shapes.push(makeShape(seed, { ...(shapeDef(seed)?.defaults ?? {}), ...parseShapePatch(input) }));
		}
		const layer = ctx.addLayer(name, shapes);
		const seeded = shapes.length ? ` with a ${seed}` : "";
		return ctx.shaderResult(`Added layer "${layer.name}"${seeded} on top (now active). It composites its geometry over the layers below; add shapes with add_shape or change the blend by editing its Composite pass.`, input["screenshot"] === true);
	},
});
