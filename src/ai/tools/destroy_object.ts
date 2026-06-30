// destroy_object -- the single "remove a thing" tool. `type` selects what to
// remove: a layer, a pass (in a layer), a shape (in a layer, by index), or a
// layer's mask. Store guards stay: can't remove the only layer/pass; removing a
// pass clears channels that referenced it. Replaces remove_layer / remove_pass /
// remove_shape / remove_mask. Targets are explicit refs.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import type { Layer } from "../../state/types.ts";

const TYPES = ["layer", "pass", "shape", "mask"] as const;

function resolveLayerOrErr(ctx: ToolContext, input: Record<string, unknown>): { error: ToolResult; layer: null } | { error: null; layer: Layer } {
	const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
	if (!layer) return { error: { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true }, layer: null };
	return { error: null, layer };
}

registerTool({
	name: TOOL_NAMES.destroyObject,
	def: {
		name: TOOL_NAMES.destroyObject,
		description:
			"Remove an object. `type`:\n- 'layer': remove a layer (cannot remove the only layer). Needs `layer`.\n- 'pass': remove a pass from a layer's graph (cannot remove a layer's only pass; channels referencing it are cleared). Needs `layer` + `pass` (name/id).\n- 'shape': remove a shape from a layer by `shape` (0-based index; later shapes shift down). Needs `layer` + `shape`.\n- 'mask': remove a layer's mask (the layer composites unmasked again). Needs `layer`.\nA `layer` ref is a name, id, or stack index (0 = bottom/back); it defaults to the top layer.",
		parameters: {
			type: "object",
			properties: {
				type: { type: "string", enum: TYPES as unknown as string[], description: "What to remove." },
				layer: { type: "string", description: "Layer ref (name/id/stack index)." },
				pass: { type: "string", description: "Pass name or id (type:pass)." },
				shape: { type: "integer", description: "Shape index within the layer, 0-based (type:shape)." },
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result." },
			},
			required: ["type"],
		},
	},
	execute: (ctx: ToolContext, input) => {
		const type = String(input["type"] ?? "");
		const shot = input["screenshot"] === true;

		if (type === "layer") {
			const { error, layer } = resolveLayerOrErr(ctx, input);
			if (error) return error;
			const res = ctx.removeLayer(layer.id);
			if (!res.ok) return { content: [text(res.error ?? "Could not remove layer.")], isError: true };
			return ctx.shaderResult(`Removed layer "${layer.name}".`, shot);
		}
		if (type === "pass") {
			const { error, layer } = resolveLayerOrErr(ctx, input);
			if (error) return error;
			const pass = ctx.resolvePass(layer, input["pass"] ? String(input["pass"]) : undefined);
			if (!pass) return { content: [text(`No pass named "${String(input["pass"])}" in layer "${layer.name}". read what:passes to list them.`)], isError: true };
			const res = ctx.removePass(pass.id);
			if (!res.ok) return { content: [text(res.error ?? "Could not remove pass.")], isError: true };
			return ctx.shaderResult(`Removed pass "${pass.name}" from layer "${layer.name}".`, shot);
		}
		if (type === "shape") {
			const { error, layer } = resolveLayerOrErr(ctx, input);
			if (error) return error;
			const idx = Number(input["shape"]);
			const shape = ctx.resolveShape(layer, idx);
			if (!shape) return { content: [text(`No shape at index ${input["shape"]} in layer "${layer.name}" (it has ${layer.shapes.length}). read what:shapes to list them.`)], isError: true };
			ctx.removeShape(layer.id, shape.id);
			return ctx.shaderResult(`Removed ${shape.kind} [${idx}] from layer "${layer.name}".`, shot);
		}
		if (type === "mask") {
			const { error, layer } = resolveLayerOrErr(ctx, input);
			if (error) return error;
			if (!layer.mask) return { content: [text(`Layer "${layer.name}" has no mask.`)], isError: true };
			ctx.removeMask(layer.id);
			return ctx.shaderResult(`Removed the mask from layer "${layer.name}".`, shot);
		}
		return { content: [text(`type must be one of: ${TYPES.join(", ")}.`)], isError: true };
	},
});
