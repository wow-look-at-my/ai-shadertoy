// set_layer -- change a layer's name, visibility, or opacity.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.setLayer,
	def: {
		name: TOOL_NAMES.setLayer,
		description: "Change a layer's name, visibility, or opacity. Opacity (0..1) scales the layer's geometry contribution; hidden layers are skipped entirely (the layers above see straight through to what's below).",
		parameters: {
			type: "object",
			properties: {
				layer: { type: "string", description: "Layer name or id (default: the active layer)." },
				name: { type: "string", description: "New name for the layer." },
				visible: { type: "boolean", description: "Show (true) or hide (false) the layer." },
				opacity: { type: "number", description: "Layer opacity, 0..1." },
				screenshot: { type: "boolean" },
			},
		},
	},
	execute: (ctx, input) => {
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		const did: string[] = [];
		if (typeof input["name"] === "string" && input["name"].trim()) {
			ctx.renameLayerById(layer.id, String(input["name"]));
			did.push(`renamed`);
		}
		if (typeof input["visible"] === "boolean") {
			ctx.setLayerVisible(layer.id, input["visible"]);
			did.push(input["visible"] ? "shown" : "hidden");
		}
		if (input["opacity"] !== undefined && Number.isFinite(Number(input["opacity"]))) {
			ctx.setLayerOpacity(layer.id, Number(input["opacity"]));
			did.push(`opacity ${Math.max(0, Math.min(1, Number(input["opacity"]))).toFixed(2)}`);
		}
		if (!did.length) return { content: [text("Nothing to change -- pass name, visible, and/or opacity.")], isError: true };
		return ctx.shaderResult(`Layer "${layer.name}": ${did.join(", ")}.`, input["screenshot"] === true);
	},
});
