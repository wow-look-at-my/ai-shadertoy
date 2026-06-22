// select_layer -- make a layer the ACTIVE one, so the pass/geometry tools
// (edit_shader, add_pass, connect_pins, add_shape, ...) target its graph.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.selectLayer,
	def: {
		name: TOOL_NAMES.selectLayer,
		description: "Make a layer the ACTIVE layer. Pass-scoped and geometry tools (edit_shader, add_pass, connect_pins, get_shader, list_passes, add_shape, edit_shape, ...) operate on the active layer's graph, so call this first to work on a specific layer. Identify it by name, id, or stack index (0 = bottom/back).",
		parameters: {
			type: "object",
			properties: {
				layer: { type: "string", description: "Layer name or id." },
				index: { type: "integer", description: "Stack index (0 = bottom/back). Alternative to `layer`." },
			},
		},
	},
	execute: (ctx, input) => {
		let layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (input["index"] !== undefined) {
			const i = Number(input["index"]);
			const byIndex = ctx.layers()[i];
			if (byIndex) layer = byIndex;
		}
		if (!layer) return { content: [text(`No such layer. Use list_layers.`)], isError: true };
		ctx.selectLayer(layer.id);
		return { content: [text(`Active layer is now "${layer.name}". edit_shader / add_pass / connect_pins / add_shape now target it.`)] };
	},
});
