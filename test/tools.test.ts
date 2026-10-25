// Unit tests for the redesigned generic tool surface: - ref resolution (layer
// by name / id / stack index.

import { getTool, toolDefs } from "../src/ai/tools/index.ts";
import "../src/ai/tools/index.ts"; // register every tool
import type { ToolContext, ToolResult } from "../src/ai/tools/types.ts";
import { makeProject } from "../src/state/defaults.ts";
import { makeCompositeLayer, makePass, makeShape, LAYER_COMPOSITE_SOURCE, type Layer, type Pass, type Project, type ShapeKind, type Uniform } from "../src/state/types.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function eq(a: unknown, b: unknown, msg: string): void {
	check(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);
}
function txt(r: ToolResult): string {
	return r.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
}

const DEFAULT_SRC = "void mainImage(out vec4 c, in vec2 f){ c = vec4(0.0); }";

/** A DOM-free ToolContext over an in-memory Project, mirroring the store's
 * (selection-free) ref resolution + the mutations the tools touch. */
function makeCtx(project: Project): ToolContext {
	const topLayer = (): Layer | null => project.layers[project.layers.length - 1] ?? null;
	const layerById = (id: string): Layer | undefined => {
		const out: Layer[] = [];
		const walk = (l: Layer) => {
			out.push(l);
			if (l.mask) walk(l.mask);
		};
		project.layers.forEach(walk);
		return out.find((l) => l.id === id);
	};
	const layerOfPass = (passId: string): Layer | undefined => {
		const all: Layer[] = [];
		const walk = (l: Layer) => {
			all.push(l);
			if (l.mask) walk(l.mask);
		};
		project.layers.forEach(walk);
		return all.find((l) => l.passes.some((p) => p.id === passId));
	};
	const passById = (id: string): Pass | undefined => layerOfPass(id)?.passes.find((p) => p.id === id);

	let rendered = "";
	const render = (): void => {
		const layer = topLayer();
		const out = layer?.passes.find((p) => p.id === layer.outputPassId) ?? layer?.passes[0];
		rendered = out?.source ?? "";
	};

	const resolveLayer = (ref?: string | number): Layer | null => {
		if (ref === undefined || ref === "") return topLayer();
		if (typeof ref === "number" && Number.isInteger(ref)) return project.layers[ref] ?? null;
		const s = String(ref);
		if (/^\d+$/.test(s.trim())) {
			const byIndex = project.layers[Number(s.trim())];
			if (byIndex) return byIndex;
		}
		const n = s.toLowerCase();
		return layerById(s) ?? project.layers.find((l) => l.name.toLowerCase() === n) ?? null;
	};
	const resolvePass = (layer: Layer, ref?: string): Pass | null => {
		if (!ref) return layer.passes.find((p) => p.id === layer.outputPassId) ?? layer.passes[0] ?? null;
		return layer.passes.find((p) => p.id === ref) ?? layer.passes.find((p) => p.name.toLowerCase() === ref.toLowerCase()) ?? passById(ref) ?? null;
	};

	const renderer = {
		maxInputs: () => 16,
		supportsFloat: () => true,
		stats: () => ({ time: 0, width: 4, height: 4, layers: project.layers.length, passes: project.layers.reduce((n, l) => n + l.passes.length, 0) }),
		readViewport: () => ({ width: 2, height: 1, data: Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0]) }),
		readPass: () => ({ width: 1, height: 1, data: Uint8Array.from([0, 255, 0, 255]) }),
	} as unknown as ToolContext["renderer"];

	return {
		settings: { imageGen: { enabled: false }, autoScreenshot: false } as unknown as ToolContext["settings"],
		project,
		assets: [],
		renderer,
		layers: () => project.layers,
		resolveLayer,
		resolvePass,
		resolveShape: (layer, index) => layer.shapes[index] ?? null,
		defaultLayer: () => topLayer(),
		isOutputUnauthored: (layer) => {
			const out = layer.passes.find((p) => p.id === layer.outputPassId);
			if (!out) return false;
			const src = out.source.trim();
			return src === DEFAULT_SRC.trim() || src === LAYER_COMPOSITE_SOURCE.trim();
		},
		setPassSource: (id, src) => {
			const p = passById(id);
			if (p) p.source = src;
			return { ok: true, log: "" };
		},
		addPass: (name, source, format, layerId) => {
			const layer = layerById(layerId)!;
			const p = makePass(name, source);
			p.format = format;
			layer.passes.unshift(p);
			return p;
		},
		removePass: (id) => {
			const layer = layerOfPass(id);
			if (!layer) return { ok: false, error: "no pass" };
			if (layer.passes.length <= 1) return { ok: false, error: "Cannot remove a layer's only pass." };
			layer.passes = layer.passes.filter((p) => p.id !== id);
			if (layer.outputPassId === id) layer.outputPassId = layer.passes[layer.passes.length - 1].id;
			return { ok: true };
		},
		setOutputPass: (id) => {
			const layer = layerOfPass(id);
			if (layer) layer.outputPassId = id;
		},
		setPassFormat: (id, fmt) => {
			const p = passById(id);
			if (p) p.format = fmt;
		},
		setUniforms: (u: Uniform[]) => {
			project.uniforms = u;
			return { ok: true, log: "" };
		},
		connectPin: () => {},
		addLayer: (name, shapes) => {
			const l = makeCompositeLayer(name, shapes ?? []);
			project.layers.push(l);
			return l;
		},
		removeLayer: (id) => {
			if (project.layers.length <= 1) return { ok: false, error: "Cannot remove the only layer." };
			project.layers = project.layers.filter((l) => l.id !== id);
			return { ok: true };
		},
		renameLayerById: (id, name) => {
			const l = layerById(id);
			if (l) l.name = name;
		},
		reorderLayer: (id, to) => {
			const from = project.layers.findIndex((l) => l.id === id);
			if (from === -1) return;
			const clamped = Math.max(0, Math.min(project.layers.length - 1, to));
			const [l] = project.layers.splice(from, 1);
			project.layers.splice(clamped, 0, l);
		},
		setLayerVisible: (id, v) => {
			const l = layerById(id);
			if (l) l.visible = v;
		},
		setLayerOpacity: (id, o) => {
			const l = layerById(id);
			if (l) l.opacity = Math.max(0, Math.min(1, o));
		},
		addMask: (id) => {
			const l = layerById(id);
			if (!l) return null;
			if (!l.mask) l.mask = makeCompositeLayer("Mask", [makeShape("circle", { falloff: 1 })]);
			return l.mask;
		},
		removeMask: (id) => {
			const l = layerById(id);
			if (l) l.mask = undefined;
		},
		addShape: (layerId, kind, patch) => {
			const l = layerById(layerId);
			if (!l) return null;
			const s = makeShape(kind as ShapeKind, patch ?? {});
			l.shapes.push(s);
			return s;
		},
		updateShape: (layerId, shapeId, patch) => {
			const l = layerById(layerId);
			const s = l?.shapes.find((x) => x.id === shapeId);
			if (s) Object.assign(s, patch);
		},
		removeShape: (layerId, shapeId) => {
			const l = layerById(layerId);
			if (l) l.shapes = l.shapes.filter((s) => s.id !== shapeId);
		},
		renameProject: (n) => {
			project.name = n;
		},
		addAsset: () => {},
		screenshotBlock: () => ({ type: "image", mediaType: "image/webp", data: rendered, _avg: "avg rgb(0,0,0)" }),
		nextFrame: async () => {
			render();
		},
		shaderResult: (prefix) => ({ content: [{ type: "text", text: prefix }] }),
		compileError: () => null,
	};
}

function run(ctx: ToolContext, name: string, input: Record<string, unknown>): ToolResult {
	const tool = getTool(name);
	if (!tool) throw new Error(`FAIL: tool ${name} not registered`);
	const r = tool.execute(ctx, input);
	if (r instanceof Promise) throw new Error("FAIL: sync test path expected");
	return r;
}

async function runAsync(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
	const tool = getTool(name);
	if (!tool) throw new Error(`FAIL: tool ${name} not registered`);
	return await tool.execute(ctx, input);
}

// ---- ref resolution: layer by name / id / stack index ----------------------
{
	const project = makeProject("T", DEFAULT_SRC);
	const ctx = makeCtx(project);
	run(ctx, "create_object", { type: "layer", name: "Shapes" });
	run(ctx, "create_object", { type: "layer", name: "Glow" });
	eq(project.layers.length, 3, "two layers added on top of Base");

	// by index
	const byIndex = ctx.resolveLayer(0);
	eq(byIndex?.name, "Base", "stack index 0 = Base (bottom)");
	// by numeric string
	eq(ctx.resolveLayer("2")?.name, "Glow", "numeric-string index 2 = top layer");
	// by name (case-insensitive)
	eq(ctx.resolveLayer("shapes")?.name, "Shapes", "layer by name, case-insensitive");
	// by id
	const glow = project.layers[2];
	eq(ctx.resolveLayer(glow.id)?.id, glow.id, "layer by id");
	// default = top
	eq(ctx.resolveLayer()?.name, "Glow", "no ref = top layer");
}

// ---- ref resolution: pass by name, shape by index --------------------------
{
	const project = makeProject("T", DEFAULT_SRC);
	const ctx = makeCtx(project);
	run(ctx, "create_object", { type: "pass", layer: "Base", name: "BlurX", format: "rgba16f" });
	const base = project.layers[0];
	eq(ctx.resolvePass(base, "BlurX")?.name, "BlurX", "pass resolved by name");
	eq(ctx.resolvePass(base)?.id, base.outputPassId, "no pass ref = output pass");

	run(ctx, "create_object", { type: "shape", layer: "Base", kind: "circle", x: 0.5, y: 0.5 });
	run(ctx, "create_object", { type: "shape", layer: "Base", kind: "quad" });
	eq(base.shapes.length, 2, "two shapes added");
	eq(ctx.resolveShape(base, 1)?.kind, "quad", "shape resolved by index");
	eq(ctx.resolveShape(base, 9), null, "out-of-range shape index = null");
}

// ---- create_object: author the output pass (init_shader collapse) ----------
{
	const project = makeProject("T", DEFAULT_SRC);
	const ctx = makeCtx(project);
	const authored = "void mainImage(out vec4 c, in vec2 f){ c = vec4(1.0, 0.0, 0.0, 1.0); }";
	const r = run(ctx, "create_object", { type: "pass", layer: "Base", source: authored });
	check(!r.isError, "authoring the unauthored output pass succeeds");
	eq(project.layers[0].passes[0].source, authored, "output pass source written");

	// Once authored, create_object refuses to overwrite (points at edit_shader).
	const r2 = run(ctx, "create_object", { type: "pass", layer: "Base", source: "void mainImage(out vec4 c, in vec2 f){ c = vec4(0.0); }" });
	check(!!r2.isError, "re-authoring an authored output pass is refused");
	check(/edit_shader/.test(txt(r2)), "refusal points at edit_shader");
	eq(project.layers[0].passes[0].source, authored, "authored source left intact after refusal");
}

// ---- create/destroy round-trip: pass + shape + mask ------------------------
{
	const project = makeProject("T", DEFAULT_SRC);
	const ctx = makeCtx(project);
	run(ctx, "create_object", { type: "pass", layer: 0, name: "Effect" });
	eq(project.layers[0].passes.length, 2, "new pass added");
	run(ctx, "destroy_object", { type: "pass", layer: 0, pass: "Effect" });
	eq(project.layers[0].passes.length, 1, "pass removed");

	// can't remove the only pass
	const r = run(ctx, "destroy_object", { type: "pass", layer: 0, pass: project.layers[0].passes[0].name });
	check(!!r.isError, "removing a layer's only pass is refused");

	run(ctx, "create_object", { type: "shape", layer: 0, kind: "circle" });
	eq(project.layers[0].shapes.length, 1, "shape added");
	run(ctx, "destroy_object", { type: "shape", layer: 0, shape: 0 });
	eq(project.layers[0].shapes.length, 0, "shape removed by index");

	run(ctx, "create_object", { type: "layer", name: "Glow" });
	run(ctx, "create_object", { type: "mask", layer: "Glow" });
	check(!!ctx.resolveLayer("Glow")?.mask, "mask added to layer");
	run(ctx, "destroy_object", { type: "mask", layer: "Glow" });
	check(!ctx.resolveLayer("Glow")?.mask, "mask removed");

	// can't remove the only layer
	run(ctx, "destroy_object", { type: "layer", layer: "Glow" });
	const rOnly = run(ctx, "destroy_object", { type: "layer", layer: 0 });
	check(!!rOnly.isError, "removing the only layer is refused");
}

// ---- edit_object: layer props / output_pass / reorder / shape --------------
{
	const project = makeProject("T", DEFAULT_SRC);
	const ctx = makeCtx(project);
	run(ctx, "create_object", { type: "layer", name: "Top" });

	run(ctx, "edit_object", { type: "layer", ref: "Top", visible: false, opacity: 0.5 });
	eq(ctx.resolveLayer("Top")?.visible, false, "layer hidden via edit_object");
	eq(ctx.resolveLayer("Top")?.opacity, 0.5, "layer opacity set");

	run(ctx, "edit_object", { type: "layer", ref: "Top", name: "Renamed" });
	check(!!ctx.resolveLayer("Renamed"), "layer renamed via edit_object");

	// reorder: move Renamed (top, one index) to the bottom
	run(ctx, "edit_object", { type: "layer", ref: "Renamed", move: "bottom" });
	eq(project.layers[0].name, "Renamed", "layer moved to the bottom");

	// output_pass
	run(ctx, "create_object", { type: "pass", layer: "Base", name: "Alt" });
	run(ctx, "edit_object", { type: "layer", ref: "Base", output_pass: "Alt" });
	const base = ctx.resolveLayer("Base")!;
	eq(base.passes.find((p) => p.id === base.outputPassId)?.name, "Alt", "output pass switched");

	// pass format
	run(ctx, "edit_object", { type: "pass", layer: "Base", ref: "Alt", format: "rgba16f" });
	eq(base.passes.find((p) => p.name === "Alt")?.format, "rgba16f", "pass format edited");

	// shape edit by index
	run(ctx, "create_object", { type: "shape", layer: "Base", kind: "quad" });
	run(ctx, "edit_object", { type: "shape", layer: "Base", index: 0, x: 0.25 });
	eq(base.shapes[0].x, 0.25, "shape transform edited by index");
}

// ---- edit_object type:project is permission-gated (only that type) ---------
{
	const tool = getTool("edit_object")!;
	const gate = tool.requiresPermission;
	check(typeof gate === "function", "edit_object uses a predicate permission gate");
	const fn = gate as (i: Record<string, unknown>) => boolean;
	check(fn({ type: "project", name: "X" }) === true, "project rename requires approval");
	check(fn({ type: "layer", ref: "Base" }) === false, "layer edit does NOT require approval");
}

// ---- tool-set byte-stability ------------------------------------------------
{
	const a = JSON.stringify(toolDefs({ imageGen: false }));
	const b = JSON.stringify(toolDefs({ imageGen: false }));
	eq(a, b, "advertised set is deterministic");

	const names = toolDefs({ imageGen: false }).map((t) => t.name);
	eq(names.length, 9, "9 tools without image gen");
	const withGen = toolDefs({ imageGen: true }).map((t) => t.name);
	eq(withGen.length, 10, "10 tools with image gen (generate_texture added)");
	check(!names.includes("generate_texture"), "generate_texture is the only gated tool");
	check(withGen.includes("generate_texture"), "generate_texture appears when imageGen on");

	// The non-generate set is identical regardless of imageGen (no other gate).
	eq(JSON.stringify(names), JSON.stringify(withGen.filter((n) => n !== "generate_texture")), "only generate_texture differs by gate");

	// No per-conversation / per-state gating: identical before vs after authoring.
	const expected = ["read", "create_object", "destroy_object", "edit_object", "edit_shader", "connect_pins", "set_uniforms", "capture_screenshot", "histogram"];
	eq(JSON.stringify(names), JSON.stringify(expected), "exactly the 9 generic + kept tools, in order");
}

// ---- screenshot barrier -----------------------------------------------------
{
	const project = makeProject("T", DEFAULT_SRC);
	const ctx = makeCtx(project);
	await runAsync(ctx, "edit_shader", { old: "vec4(0.0)", new: "vec4(1.0, 0.0, 0.0, 1.0)" });
	const shot = await runAsync(ctx, "capture_screenshot", {});
	const image = shot.content.find((b) => b.type === "image");
	check(image?.type === "image" && image.data.includes("vec4(1.0, 0.0, 0.0, 1.0)"), "a screenshot after an edit reads the post-edit frame");
	check(image?.type === "image" && !image.data.includes("vec4(0.0)"), "the pre-edit source is gone");
}

// ---- histogram tool ---------------------------------------------------------
{
	const project = makeProject("T", DEFAULT_SRC);
	const ctx = makeCtx(project);
	const tool = getTool("histogram");
	check(!!tool && tool.def.name === "histogram", "the histogram tool is registered");
	check(JSON.stringify(tool?.def.parameters).includes("\"channel\""), "the histogram schema exposes the channel");

	const view = txt(run(ctx, "histogram", { channel: "luma" }));
	check(view.includes("viewport | luma | 1 px"), "the viewport histogram reports its target and samples");
	check(view.includes("luma mean 255.0 peak 255 (1)"), "a white pixel peaks at the top bin");
	check(view.includes("255:1"), "the populated bins are listed");

	const pass = txt(run(ctx, "histogram", { target: "Image", channel: "g" }));
	check(pass.includes("Base / Image | g"), "a pass target reports its layer and pass");
	check(pass.includes("g mean 255.0"), "a pass target reads its own buffer");
}

console.log(`tools.test.ts: ${passed} checks passed`);
