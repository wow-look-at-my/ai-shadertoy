// list_layers -- report the document's layer stack (the One True draw order) with
// each layer's visibility, opacity, pass count, and shape count.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext } from "./types.ts";

registerTool({
	name: TOOL_NAMES.listLayers,
	def: {
		name: TOOL_NAMES.listLayers,
		description: "List the layer stack: the One True draw order (index 0 = bottom/back, drawn first; last = top/front, drawn last). Each line shows the layer's visibility, opacity, pass count, shape count, and whether it is the ACTIVE layer (the one pass/shape edits target). Each layer's graph sees the composite of the layers below it as its 'under' input.",
		parameters: { type: "object", properties: {} },
	},
	execute: (ctx: ToolContext) => {
		const layers = ctx.layers();
		const activeId = ctx.activeLayerId();
		const lines = layers.map((l, i) => {
			const flags = [l.visible ? null : "hidden", l.opacity < 1 ? `opacity ${l.opacity.toFixed(2)}` : null, l.id === activeId ? "ACTIVE" : null].filter(Boolean).join(", ");
			return `[${i}] ${l.name} -- ${l.passes.length} pass${l.passes.length === 1 ? "" : "es"}, ${l.shapes.length} shape${l.shapes.length === 1 ? "" : "s"}${flags ? ` (${flags})` : ""}`;
		});
		return { content: [text(`Layer stack, back (0) to front (${layers.length - 1}):\n${lines.join("\n")}`)] };
	},
});
