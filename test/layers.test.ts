// Unit tests for the layer data model: project migration (legacy -> layers),
// the composite-layer factory, the shape registry, and shape-input parsing.
// DOM-free, so plain Node can exercise it:
//   node --experimental-strip-types test/layers.test.ts

import { makeProject, normalizeProject } from "../src/state/defaults.ts";
import { makeCompositeLayer, makeMaskLayer, makeShape } from "../src/state/types.ts";
import { isShapeKind, shapeKindIndex, SHAPE_KINDS } from "../src/gl/shapes.ts";
import { parseShapePatch } from "../src/ai/tools/geometry_util.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function eq(a: unknown, b: unknown, msg: string): void {
	check(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);
}
function near(a: number, b: number, msg: string): void {
	check(Math.abs(a - b) < 1e-6, `${msg} (got ${a}, want ${b})`);
}

// ---- makeProject: one Base layer wrapping one Image pass --------------------
{
	const p = makeProject("Test", "void mainImage(out vec4 c, in vec2 f){ c = vec4(1.0); }");
	eq(p.layers.length, 1, "fresh project has one layer");
	eq(p.layers[0].name, "Base", "base layer named Base");
	eq(p.layers[0].passes.length, 1, "base layer has one pass");
	eq(p.layers[0].outputPassId, p.layers[0].passes[0].id, "output pass id points at the pass");
	eq(p.layers[0].shapes.length, 0, "base layer starts with no shapes");
	check(p.layers[0].passes[0].source.includes("mainImage"), "image pass keeps the source");
}

// ---- migration: very old single shaderSource -> Base layer ------------------
{
	const legacy = { id: "p1", name: "Old", shaderSource: "void mainImage(out vec4 c, in vec2 f){ c = vec4(0.5); }", channels: [{ kind: "builtin", builtin: "checker" }] };
	const p = normalizeProject(legacy);
	eq(p.id, "p1", "keeps id");
	eq(p.layers.length, 1, "one layer after migration");
	eq(p.layers[0].name, "Base", "migrated layer named Base");
	eq(p.layers[0].passes.length, 1, "one image pass");
	check(p.layers[0].passes[0].source.includes("0.5"), "preserves shader source");
	eq(p.layers[0].passes[0].channels[0].kind, "builtin", "preserves channel binding");
}

// ---- migration: mid-era flat passes/outputPassId -> Base layer --------------
{
	const legacy = {
		id: "p2",
		name: "Graph",
		passes: [
			{ id: "a", name: "Buffer", source: "// a", channels: [] },
			{ id: "b", name: "Image", source: "// b", channels: [{ kind: "pass", passId: "a" }] },
		],
		outputPassId: "b",
	};
	const p = normalizeProject(legacy);
	eq(p.layers.length, 1, "flat graph becomes one layer");
	eq(p.layers[0].passes.length, 2, "both passes carried over");
	eq(p.layers[0].outputPassId, "b", "output pass preserved");
	eq(p.layers[0].passes[1].channels[0].kind, "pass", "pass edge preserved");
	eq(p.layers[0].passes[1].channels[0].passId, "a", "pass edge target preserved");
}

// ---- migration: current layers pass through + shapes normalized -------------
{
	const raw = {
		id: "p3",
		name: "Doc",
		layers: [
			{ id: "L0", name: "Base", passes: [{ id: "img", name: "Image", source: "// img", channels: [] }], outputPassId: "img", shapes: [] },
			{
				id: "L1",
				name: "Shapes",
				opacity: 0.5,
				visible: false,
				passes: [{ id: "c", name: "Composite", source: "// c", channels: [{ kind: "under" }, { kind: "geometry" }] }],
				outputPassId: "c",
				shapes: [{ kind: "bogus", x: 0.3, y: 0.7, w: 0.2, h: 0.2, color: [1, 0] }],
			},
		],
	};
	const p = normalizeProject(raw);
	eq(p.layers.length, 2, "two layers preserved");
	eq(p.layers[1].opacity, 0.5, "layer opacity preserved");
	eq(p.layers[1].visible, false, "layer visibility preserved");
	eq(p.layers[1].passes[0].channels[0].kind, "under", "under channel preserved");
	eq(p.layers[1].passes[0].channels[1].kind, "geometry", "geometry channel preserved");
	eq(p.layers[1].shapes.length, 1, "shape carried over");
	eq(p.layers[1].shapes[0].kind, "quad", "invalid shape kind clamped to quad");
	eq(p.layers[1].shapes[0].color.length, 4, "shape color padded to rgba");
	near(p.layers[1].shapes[0].color[3], 1, "missing alpha defaults to 1");
}

// ---- makeCompositeLayer: wired under->iCh0, geometry->iCh1 ------------------
{
	const layer = makeCompositeLayer("Glow");
	eq(layer.passes.length, 1, "composite layer has one pass");
	eq(layer.passes[0].channels[0].kind, "under", "iChannel0 = under");
	eq(layer.passes[0].channels[1].kind, "geometry", "iChannel1 = geometry");
	eq(layer.outputPassId, layer.passes[0].id, "output is the composite pass");
	check(layer.passes[0].source.includes("iChannel0"), "default composite samples under");
}

// ---- shape registry --------------------------------------------------------
{
	eq(shapeKindIndex("quad"), 0, "quad is kind index 0");
	eq(shapeKindIndex("circle"), 1, "circle is kind index 1");
	check(isShapeKind("quad") && isShapeKind("circle"), "known kinds recognized");
	check(!isShapeKind("triangle"), "unknown kind rejected");
	check(SHAPE_KINDS.length >= 2, "registry has quad + circle");

	const s = makeShape("circle", { x: 0.25 });
	eq(s.kind, "circle", "makeShape sets kind");
	eq(s.x, 0.25, "makeShape applies patch");
	eq(s.color.length, 4, "shape color is rgba");
}

// ---- parseShapePatch: degrees -> radians, colour, clamps -------------------
{
	const patch = parseShapePatch({ x: 0.5, w: -3, rotation: 90, color: [1, 0, 0] });
	eq(patch.x, 0.5, "x parsed");
	eq(patch.w, 0, "negative width clamped to 0");
	near(patch.rotation ?? -1, Math.PI / 2, "90 degrees -> pi/2 radians");
	check(Array.isArray(patch.color) && patch.color.length === 4, "color expanded to rgba");
	near(patch.color?.[3] ?? -1, 1, "missing alpha defaults to 1");
	const empty = parseShapePatch({});
	eq(Object.keys(empty).length, 0, "no fields -> empty patch");
}

// ---- layer masks -----------------------------------------------------------
{
	const mask = makeMaskLayer([makeShape("circle", { falloff: 1 })]);
	eq(mask.passes.length, 1, "mask layer has one pass");
	eq(mask.passes[0].channels[0].kind, "geometry", "mask pass samples geometry");
	eq(mask.outputPassId, mask.passes[0].id, "mask output is its pass");
	eq(mask.shapes.length, 1, "mask seeded with a shape");

	// Migration preserves + normalizes a nested mask.
	const raw = {
		layers: [
			{
				name: "Tex",
				passes: [{ id: "p", name: "Composite", source: "// c", channels: [{ kind: "under" }, { kind: "geometry" }] }],
				outputPassId: "p",
				shapes: [],
				mask: {
					name: "Mask",
					passes: [{ id: "m", name: "Mask", source: "// m", channels: [{ kind: "geometry" }] }],
					outputPassId: "m",
					shapes: [{ kind: "circle", falloff: 1 }],
				},
			},
		],
	};
	const p = normalizeProject(raw);
	eq(p.layers.length, 1, "one stack layer after migration");
	check(!!p.layers[0].mask, "mask carried through migration");
	eq(p.layers[0].mask!.passes[0].channels[0].kind, "geometry", "mask channel preserved");
	eq(p.layers[0].mask!.shapes.length, 1, "mask shape preserved");
	near(p.layers[0].mask!.shapes[0].falloff, 1, "mask shape falloff preserved");
}

console.log(`ok - ${passed} assertions passed`);
