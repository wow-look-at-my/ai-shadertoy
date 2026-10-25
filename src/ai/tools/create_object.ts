// create_object -- the single "add a thing" tool. `type` selects what to create:
// a layer (on top of the stack), a pass (in a layer), a shape (in a layer), or a
// mask (on a layer). Adding a child to a parent collection IS create_object with a
// `layer` parent. Replaces add_layer / add_pass / add_shape / add_mask AND
// init_shader (seeding a layer's output pass). Targets are explicit refs.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext } from "./types.ts";
import type { PassFormat, Shape } from "../../state/types.ts";
import { makeShape } from "../../state/types.ts";
import { isShapeKind, shapeDef, SHAPE_KINDS } from "../../gl/shapes.ts";
import { parseShapePatch, SHAPE_SCHEMA_FIELDS } from "./geometry_util.ts";

const PASSTHROUGH = "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n\tvec2 uv = fragCoord / iResolution.xy;\n\tfragColor = texture(iChannel0, uv);\n}\n";

const TYPES = ["layer", "pass", "shape", "mask"] as const;

function createLayer(ctx: ToolContext, input: Record<string, unknown>) {
	const name = input["name"] ? String(input["name"]) : "Layer";
	const shapes: Shape[] = [];
	const seed = input["shape"] ?? input["kind"]; // the schema documents both names
	if (typeof seed === "string" && isShapeKind(seed)) {
		shapes.push(makeShape(seed, { ...(shapeDef(seed)?.defaults ?? {}), ...parseShapePatch(input) }));
	}
	const layer = ctx.addLayer(name, shapes);
	const seeded = shapes.length ? ` with a ${seed}` : "";
	return ctx.shaderResult(`Added layer "${layer.name}"${seeded} on top. It composites its geometry over the layers below; add shapes with create_object type:shape (layer:"${layer.name}") or change the blend by editing its Composite pass with edit_shader.`, input["screenshot"] === true);
}

function createPass(ctx: ToolContext, input: Record<string, unknown>) {
	const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
	if (!layer) return { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true };
	const name = input["name"] ? String(input["name"]).trim() : "";
	const source = input["source"] ? String(input["source"]) : "";

	// No name = seed the layer's OUTPUT pass in place (the init_shader: author
	// the visible pass). Refuse if that pass has already been authored, so we
	// never silently overwrite real work -- point the model at edit_shader
	// instead.
	if (!name) {
		if (!source.trim()) return { content: [text("create_object type:pass needs either a `name` (to add a new pass) or a non-empty `source` (to author the layer's output pass).")], isError: true };
		const out = ctx.resolvePass(layer);
		if (!out) return { content: [text(`Layer "${layer.name}" has no output pass to author.`)], isError: true };
		if (!ctx.isOutputUnauthored(layer)) {
			return { content: [text(`Pass "${out.name}" in layer "${layer.name}" is already authored. To change it use edit_shader (replace a snippet); pass a "name" here only to ADD a new pass, not to overwrite the output.`)], isError: true };
		}
		ctx.setPassSource(out.id, source, true);
		return ctx.shaderResult(`Authored the output pass "${out.name}" of layer "${layer.name}".`, input["screenshot"] === true);
	}

	// Named = add a NEW pass (additive, always safe).
	const format = (input["format"] === "rgba16f" ? "rgba16f" : "rgba8") as PassFormat;
	const pass = ctx.addPass(name, source || PASSTHROUGH, format, layer.id);
	return ctx.shaderResult(`Added pass "${pass.name}" (${format}) to layer "${layer.name}". It is not visible yet -- wire it with connect_pins or make it the output with edit_object type:layer output_pass:"${pass.name}".`, input["screenshot"] === true);
}

function createShape(ctx: ToolContext, input: Record<string, unknown>) {
	const kind = String(input["kind"] ?? "");
	if (!isShapeKind(kind)) return { content: [text(`kind must be one of: ${SHAPE_KINDS.join(", ")}`)], isError: true };
	const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
	if (!layer) return { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true };
	const shape = ctx.addShape(layer.id, kind, parseShapePatch(input));
	if (!shape) return { content: [text("Could not add the shape.")], isError: true };
	const n = layer.shapes.length;
	return ctx.shaderResult(`Added a ${kind} to layer "${layer.name}" (now ${n} shape${n === 1 ? "" : "s"}; index ${n - 1}).`, input["screenshot"] === true);
}

function createMask(ctx: ToolContext, input: Record<string, unknown>) {
	const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
	if (!layer) return { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true };
	const mask = ctx.addMask(layer.id);
	if (!mask) return { content: [text("Could not add the mask.")], isError: true };
	return ctx.shaderResult(`Added a mask to layer "${layer.name}" (a soft circle, with a Masked Composite pass wired kind=mask: mix(under, comp, mask.alpha)). Edit the mask's shapes with create_object/edit_object type:shape layer:"${mask.name}"; remove it with destroy_object type:mask layer:"${layer.name}".`, input["screenshot"] === true);
}

registerTool({
	name: TOOL_NAMES.createObject,
	def: {
		name: TOOL_NAMES.createObject,
		description:
			"Create an object. `type`:\n- 'layer': add a LAYER on top of the stack, pre-wired to composite its geometry over the layers below (source-over). Optional `name`; optionally seed one `shape` (+ shape fields).\n- 'pass': add to a layer's render graph. With a `name` it ADDS a new pass (optional `source` defaults to a passthrough sampling iChannel0; `format` rgba8|rgba16f). With NO name it AUTHORS the layer's output pass from the given `source` -- this is how you write the FIRST shader (only allowed while that pass is still the unauthored default; otherwise use edit_shader). Needs `layer`.\n- 'shape': add a geometry primitive (`kind` quad|circle + x/y/w/h/rotation/color/...) to a layer. Needs `layer`.\n- 'mask': give a layer a MASK (seeds a soft circle + a Masked Composite pass). Needs `layer`.\nA `layer` ref is a name, id, or stack index (0 = bottom/back); it defaults to the top layer.",
		parameters: {
			type: "object",
			properties: {
				type: { type: "string", enum: TYPES as unknown as string[], description: "What to create." },
				layer: { type: "string", description: "Layer ref (name/id/stack index). Required for pass/shape/mask; the parent collection the new object joins." },
				name: { type: "string", description: "Name for a new layer, or a new pass (pass: omit to author the layer's output pass instead)." },
				kind: { type: "string", enum: SHAPE_KINDS, description: "Shape kind (type:shape) or seed-shape kind (type:layer)." },
				format: { type: "string", enum: ["rgba8", "rgba16f"], description: "Pass render-target format. rgba16f keeps HDR values (type:pass)." },
				source: { type: "string", description: "GLSL mainImage body (type:pass)." },
				shape: { type: "string", enum: SHAPE_KINDS, description: "Optionally seed a new layer with one shape of this kind (type:layer)." },
				...SHAPE_SCHEMA_FIELDS,
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result." },
			},
			required: ["type"],
		},
	},
	execute: (ctx: ToolContext, input) => {
		const type = String(input["type"] ?? "");
		if (type === "layer") return createLayer(ctx, input);
		if (type === "pass") return createPass(ctx, input);
		if (type === "shape") return createShape(ctx, input);
		if (type === "mask") return createMask(ctx, input);
		return { content: [text(`type must be one of: ${TYPES.join(", ")}.`)], isError: true };
	},
});
