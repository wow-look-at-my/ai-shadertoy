// add_mask -- give a layer a MASK. The mask is itself a layer (rendered
// standalone, no `under`); add_mask also adds a visible Masked Composite pass to
// the owner graph that samples under + the unmasked output + mask. The mask is
// made ACTIVE so add_shape / edit_shader target it.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.addMask,
	def: {
		name: TOOL_NAMES.addMask,
		description:
			"Add a MASK to a layer (or focus its existing mask). The mask is a layer whose output ALPHA is sampled by a visible 'Masked Composite' pass in the owner layer's graph: iChannel0=under, iChannel1=unmasked layer output, iChannel2=mask, shader math result=mix(under, layerComposite, mask.alpha). Use it to reveal a layer (e.g. a texture) through a shape -- an ellipse with falloff makes a soft radial-gradient mask. The mask is seeded with a soft circle and becomes the ACTIVE layer, so subsequent add_shape / edit_shape / connect_pins calls build the MASK; call select_layer (or list_layers) to return to the main stack. The mask layer never samples `under`.",
		parameters: {
			type: "object",
			properties: {
				layer: { type: "string", description: "Layer to mask (name or id; default: the active layer)." },
				screenshot: { type: "boolean" },
			},
		},
	},
	execute: (ctx, input) => {
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		const mask = ctx.addMask(layer.id);
		if (!mask) return { content: [text("Could not add the mask.")], isError: true };
		return ctx.shaderResult(`Added a mask to layer "${layer.name}" (now editing the MASK; the owner graph has a Masked Composite pass wired to kind=mask). Edit its shapes with add_shape/edit_shape; select_layer to go back to the stack.`, input["screenshot"] === true);
	},
});
