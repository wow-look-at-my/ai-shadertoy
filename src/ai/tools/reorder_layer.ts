// reorder_layer -- move a layer within the back-to-front stack (the draw order).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.reorderLayer,
	def: {
		name: TOOL_NAMES.reorderLayer,
		description: "Move a layer to a new position in the draw order (index 0 = bottom/back, drawn first; higher = more in front). Pass a target `to` index, or `move` = up | down | top | bottom. Reordering changes what each layer composites over, since a layer's 'under' input is everything below it.",
		parameters: {
			type: "object",
			properties: {
				layer: { type: "string", description: "Layer name or id (default: the active layer)." },
				to: { type: "integer", description: "Target stack index (0 = bottom/back)." },
				move: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Relative move; 'up' = toward the front." },
				screenshot: { type: "boolean" },
			},
		},
	},
	execute: (ctx, input) => {
		const layer = ctx.resolveLayer(input["layer"] ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer named "${String(input["layer"])}". Use list_layers.`)], isError: true };
		const layers = ctx.layers();
		const from = layers.findIndex((l) => l.id === layer.id);
		let to = from;
		const move = input["move"] ? String(input["move"]) : "";
		if (move === "up") to = from + 1;
		else if (move === "down") to = from - 1;
		else if (move === "top") to = layers.length - 1;
		else if (move === "bottom") to = 0;
		else if (input["to"] !== undefined) to = Number(input["to"]);
		else return { content: [text("Pass `to` (target index) or `move` (up|down|top|bottom).")], isError: true };
		ctx.reorderLayer(layer.id, to);
		const newIdx = ctx.layers().findIndex((l) => l.id === layer.id);
		return ctx.shaderResult(`Moved layer "${layer.name}" to index ${newIdx} (0 = back).`, input["screenshot"] === true);
	},
});
