// edit_object -- the single "change a thing's properties" tool (NOT shader
// source; that's edit_shader).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext } from "./types.ts";
import type { PassFormat } from "../../state/types.ts";
import { parseShapePatch, SHAPE_SCHEMA_FIELDS } from "./geometry_util.ts";

const TYPES = ["layer", "pass", "shape", "project"] as const;
const MAX_NAME_LEN = 100;

function cleanProjectName(input: Record<string, unknown>): string {
	return String(input["name"] ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_LEN);
}

function editLayer(ctx: ToolContext, input: Record<string, unknown>) {
	// `ref` is the documented field.
	const ref = input["ref"] ?? input["layer"];
	const layer = ctx.resolveLayer(ref !== undefined ? String(ref) : undefined);
	if (!layer) return { content: [text(`No layer "${String(ref)}". read what:layers to list them.`)], isError: true };
	const did: string[] = [];

	if (typeof input["name"] === "string" && input["name"].trim()) {
		ctx.renameLayerById(layer.id, String(input["name"]));
		did.push("renamed");
	}
	if (typeof input["visible"] === "boolean") {
		ctx.setLayerVisible(layer.id, input["visible"]);
		did.push(input["visible"] ? "shown" : "hidden");
	}
	if (input["opacity"] !== undefined) {
		const opacity = Number(input["opacity"]);
		if (typeof input["opacity"] !== "number" || !Number.isFinite(opacity)) return { content: [text("opacity must be a number 0..1.")], isError: true };
		ctx.setLayerOpacity(layer.id, opacity);
		did.push(`opacity ${Math.max(0, Math.min(1, opacity)).toFixed(2)}`);
	}
	if (typeof input["output_pass"] === "string" && input["output_pass"].trim()) {
		const pass = ctx.resolvePass(layer, String(input["output_pass"]));
		if (!pass) return { content: [text(`No pass named "${String(input["output_pass"])}" in layer "${layer.name}". read what:passes to list them.`)], isError: true };
		ctx.setOutputPass(pass.id);
		did.push(`output -> "${pass.name}"`);
	}
	// Reorder via an absolute `order` index or a relative `move`.
	const layers = ctx.layers();
	const from = layers.findIndex((l) => l.id === layer.id);
	let to = from;
	const move = input["move"] ? String(input["move"]) : "";
	if (move === "up") to = from + 1;
	else if (move === "down") to = from - 1;
	else if (move === "top") to = layers.length - 1;
	else if (move === "bottom") to = 0;
	else if (move) return { content: [text("move must be one of up, down, top, bottom.")], isError: true };
	else if (input["order"] !== undefined) {
		if (typeof input["order"] !== "number" || !Number.isInteger(input["order"])) return { content: [text("order must be an integer stack index (0 = bottom/back).")], isError: true };
		to = input["order"];
	}
	if (to !== from) {
		ctx.reorderLayer(layer.id, to);
		const newIdx = ctx.layers().findIndex((l) => l.id === layer.id);
		did.push(`moved to index ${newIdx}`);
	}

	if (!did.length) return { content: [text("Nothing to change -- pass name, visible, opacity, output_pass, and/or order|move.")], isError: true };
	return ctx.shaderResult(`Layer "${layer.name}": ${did.join(", ")}.`, input["screenshot"] === true);
}

function editPass(ctx: ToolContext, input: Record<string, unknown>) {
	const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
	if (!layer) return { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true };
	const pass = ctx.resolvePass(layer, input["ref"] ? String(input["ref"]) : undefined);
	if (!pass) return { content: [text(`No pass named "${String(input["ref"])}" in layer "${layer.name}". read what:passes to list them.`)], isError: true };
	const fmt = input["format"];
	if (fmt !== "rgba8" && fmt !== "rgba16f") return { content: [text("Pass edit: pass format (rgba8|rgba16f). To change a pass's GLSL use edit_shader.")], isError: true };
	ctx.setPassFormat(pass.id, fmt as PassFormat);
	return ctx.shaderResult(`Pass "${pass.name}" in layer "${layer.name}": format ${fmt}.`, input["screenshot"] === true);
}

function editShape(ctx: ToolContext, input: Record<string, unknown>) {
	const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
	if (!layer) return { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true };
	if (input["index"] === undefined) return { content: [text("Shape edit needs `index` (0-based; see read what:shapes).")], isError: true };
	const idx = Number(input["index"]);
	const shape = ctx.resolveShape(layer, idx);
	if (!shape) return { content: [text(`No shape at index ${input["index"]} in layer "${layer.name}" (it has ${layer.shapes.length}). read what:shapes to list them.`)], isError: true };
	const patch = parseShapePatch(input);
	if (Object.keys(patch).length === 0) return { content: [text("Nothing to change -- pass x/y/w/h/rotation/color/cornerRadius/feather/falloff.")], isError: true };
	ctx.updateShape(layer.id, shape.id, patch);
	return ctx.shaderResult(`Edited ${shape.kind} [${idx}] in layer "${layer.name}".`, input["screenshot"] === true);
}

registerTool({
	name: TOOL_NAMES.editObject,
	// Only project renames are gated; layer/pass/shape edits run freely.
	requiresPermission: (input) => String(input["type"] ?? "") === "project",
	permissionPrompt: (input) => {
		const name = cleanProjectName(input);
		return name ? `Rename the current shader to "${name}"?` : "Rename the current shader?";
	},
	def: {
		name: TOOL_NAMES.editObject,
		description:
			"Change an object's properties (NOT shader source -- use edit_shader for that). Only the fields you pass change. `type`:\n- 'layer': `ref` (layer name/id/index) + any of name, visible, opacity (0..1), output_pass (a pass name -> the layer's composite), and ONE of order (absolute stack index) or move (up|down|top|bottom).\n- 'pass': `layer` + `ref` (pass name/id) + format (rgba8|rgba16f).\n- 'shape': `layer` + `index` (0-based) + transform/colour/style fields.\n- 'project': name (renames the shader shown in the top bar; REQUIRES the user's approval before it takes effect -- only call when a rename is clearly wanted).\nA `layer` ref is a name, id, or stack index (0 = bottom/back); it defaults to the top layer.",
		parameters: {
			type: "object",
			properties: {
				type: { type: "string", enum: TYPES as unknown as string[], description: "What to edit." },
				ref: { type: "string", description: "Target ref: a layer (type:layer) or pass (type:pass) name/id/index." },
				layer: { type: "string", description: "Layer ref for type:pass / type:shape." },
				index: { type: "integer", description: "Shape index, 0-based (type:shape)." },
				name: { type: "string", description: "New name (type:layer or type:project)." },
				visible: { type: "boolean", description: "Show/hide a layer (type:layer)." },
				opacity: { type: "number", description: "Layer opacity 0..1 (type:layer)." },
				output_pass: { type: "string", description: "Pass name to make the layer's visible composite (type:layer)." },
				order: { type: "integer", description: "Absolute target stack index, 0 = bottom/back (type:layer)." },
				move: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Relative move in the stack; 'up' = toward the front (type:layer)." },
				format: { type: "string", enum: ["rgba8", "rgba16f"], description: "Pass render-target format (type:pass)." },
				...SHAPE_SCHEMA_FIELDS,
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result." },
			},
			required: ["type"],
		},
	},
	execute: (ctx: ToolContext, input) => {
		const type = String(input["type"] ?? "");
		if (type === "layer") return editLayer(ctx, input);
		if (type === "pass") return editPass(ctx, input);
		if (type === "shape") return editShape(ctx, input);
		if (type === "project") {
			const name = cleanProjectName(input);
			if (!name) return { content: [text("edit_object type:project requires a non-empty name.")], isError: true };
			ctx.renameProject(name);
			return { content: [text(`Renamed the shader to "${name}".`)] };
		}
		return { content: [text(`type must be one of: ${TYPES.join(", ")}.`)], isError: true };
	},
});
