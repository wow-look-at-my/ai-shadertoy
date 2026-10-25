// Unit tests for the layer data model: project migration (legacy -> layers),
// the composite-layer factory, the shape registry, and shape-input parsing.
// DOM-free, so plain Node can exercise it:
//   node --experimental-strip-types test/layers.test.ts

import { makeProject, normalizeProject } from "../src/state/defaults.ts";
import { channelsForSource, ensureMaskCompositePass, isMaskCompositePass, makeCompositeLayer, makeMaskLayer, makePass, makeShape, referencedInputCount, removeMaskCompositePass } from "../src/state/types.ts";
import { assembleFragment, extractUniformDeclarations, remapChannelLookups } from "../src/gl/wrapper.ts";
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
	eq(p.layers[0].passes[0].channels.length, 0, "shader with no iChannel references has no input pins");
}

// ---- shader source owns texture/uniform inputs -----------------------------
{
	const src = `
	// iChannel7 in comments is ignored
	uniform float u_speed;
	uniform vec3 u_tint;
	void mainImage(out vec4 c, in vec2 f) {
		vec4 a = texture(iChannel0, f);
		vec4 b = texture(iChannel2, f);
		c = vec4(u_tint * u_speed, 1.0) + a + b;
	}`;
	eq(referencedInputCount(src), 3, "highest referenced iChannel determines input count");
	eq(channelsForSource(src).length, 3, "channelsForSource creates pins up to highest iChannel");
	eq(makePass("Auto", src).channels.length, 3, "makePass derives pins from shader source");
	const uniforms = extractUniformDeclarations(src);
	eq(uniforms.length, 2, "custom uniform declarations are extracted");
	eq(uniforms[0].name, "u_speed", "float uniform name extracted");
	eq(uniforms[1].type, "vec3", "vec3 uniform type extracted");
	const assembled = assembleFragment(src, uniforms, 3).source;
	eq((assembled.match(/uniform float u_speed;/g) ?? []).length, 1, "custom uniform declared once in assembled shader");
	eq((assembled.match(/uniform vec3 u_tint;/g) ?? []).length, 1, "vec3 custom uniform declared once in assembled shader");
}

<<<<<<< HEAD
// Square-pixel mode: direct lookups on a channel go through its remap so a
// pass reading another pass with fragCoord / iResolution.xy stays aligned.
{
	const body = "void mainImage(out vec4 c, in vec2 f) {\n\tvec2 uv = f / iResolution.xy;\n\tc = texture(iChannel0, uv) + textureLod( iChannel1 , uv, 0.0) + texelFetch(iChannel0, ivec2(f), 0) + texture(iChannel5, uv);\n}";
	eq(
		remapChannelLookups(body, 2),
		"void mainImage(out vec4 c, in vec2 f) {\n\tvec2 uv = f / iResolution.xy;\n\tc = ai_texture(ai_chanRemap[0], iChannel0, uv) + ai_textureLod( ai_chanRemap[1], iChannel1 , uv, 0.0) + ai_texelFetch(ai_chanFetch[0], iChannel0, ivec2(f), 0) + texture(iChannel5, uv);\n}",
		"declared channel lookups are remapped; an undeclared channel is left for the compiler to report",
	);
	const assembled = assembleFragment(body, [], 2).source;
	check(assembled.includes("uniform vec4 ai_chanRemap[2];"), "the remap uniform is declared per channel");
	check(assembled.includes("uniform ivec2 ai_chanFetch[2];"), "and the texel offset uniform");
	eq(assembled.split("#line 1\n")[1].split("\n").length, assembleFragment("void mainImage(out vec4 c, in vec2 f) {\n\tvec2 uv = f / iResolution.xy;\n\tc = vec4(0);\n}", [], 2).source.split("#line 1\n")[1].split("\n").length, "the rewrite keeps the line count, so errors map to user lines");
	check(!assembleFragment(body, [], 0).source.includes("ai_chanRemap"), "a pass with no inputs declares no remap");
}

=======
>>>>>>> origin/master
// migration: old single shaderSource -> Base layer
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

	const owner = makeCompositeLayer("Tex");
	const unmaskedOutput = owner.outputPassId;
	owner.mask = mask;
	const wrapper = ensureMaskCompositePass(owner);
	eq(owner.outputPassId, wrapper.id, "masked owner output becomes the mask wrapper");
	eq(owner.passes.length, 2, "mask wrapper is a visible graph pass");
	check(isMaskCompositePass(wrapper), "mask wrapper recognized");
	eq(wrapper.channels[0].kind, "under", "mask wrapper iChannel0 = under");
	eq(wrapper.channels[1].kind, "pass", "mask wrapper iChannel1 = unmasked layer output");
	eq(wrapper.channels[1].passId, unmaskedOutput, "mask wrapper samples previous output pass");
	eq(wrapper.channels[2].kind, "mask", "mask wrapper iChannel2 = mask");
	check(wrapper.source.includes("mix(under, comp, m)"), "mask wrapper shader applies mask in graph");

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
	eq(p.layers[0].passes.length, 2, "migration adds visible mask composite pass");
	const out = p.layers[0].passes.find((pass) => pass.id === p.layers[0].outputPassId);
	check(!!out && isMaskCompositePass(out), "migrated masked layer outputs graph mask wrapper");
	eq(out!.channels[1].passId, "p", "migrated mask wrapper samples prior output");
	eq(out!.channels[2].kind, "mask", "migrated mask wrapper samples mask input");
	eq(p.layers[0].mask!.passes[0].channels[0].kind, "geometry", "mask channel preserved");
	eq(p.layers[0].mask!.shapes.length, 1, "mask shape preserved");
	near(p.layers[0].mask!.shapes[0].falloff, 1, "mask shape falloff preserved");

	// An EDITED wrapper (source and name changed, saved without `role`) is still the wrapper: reloading must not wrap it again.
	const edited = structuredClone(raw) as { layers: Array<{ passes: Array<Record<string, unknown>>; outputPassId: string }> };
	edited.layers[0].passes.push({ id: "w", name: "My blend", source: "// tweaked", channels: [{ kind: "under" }, { kind: "pass", passId: "p" }, { kind: "mask" }] });
	edited.layers[0].outputPassId = "w";
	const once = normalizeProject(edited);
	eq(once.layers[0].passes.length, 2, "an edited wrapper is recognised by its wiring (no extra pass)");
	eq(once.layers[0].outputPassId, "w", "the edited wrapper stays the output");
	eq(once.layers[0].passes[1].role, "maskComposite", "the wrapper is tagged with its role");
	const twice = normalizeProject(JSON.parse(JSON.stringify(once)));
	eq(twice.layers[0].passes.length, 2, "a second load adds nothing");
	// removeMask on the edited wrapper restores the pass it wrapped.
	removeMaskCompositePass(twice.layers[0]);
	eq(twice.layers[0].passes.length, 1, "removing the mask drops the edited wrapper");
	eq(twice.layers[0].outputPassId, "p", "the unmasked pass is the output again");
}

// ---- uniforms are validated on load ------------------------------------------
{
	const p = normalizeProject({ layers: [{ passes: [{ name: "Image", source: "" }] }], uniforms: [{ name: "u_a" }, { name: "u_c", type: "color", value: [0.5] }, { type: "float", value: [1] }, { name: "u_b", type: "bogus", value: ["x", 2], min: "no", max: 3 }] });
	eq(p.uniforms.length, 3, "a uniform without a name is dropped");
	const a = p.uniforms.find((u) => u.name === "u_a")!;
	eq(a.type, "float", "a missing type defaults to float");
	eq(a.value.length, 1, "a missing value is padded to the type's length");
	eq(a.max, 1, "a missing range gets the canonical 0..1");
	const c = p.uniforms.find((u) => u.name === "u_c")!;
	eq(c.value.join(","), "0.5,0,0", "a short colour value is padded to three components");
	const b = p.uniforms.find((u) => u.name === "u_b")!;
	eq(b.type, "float", "an unknown type falls back to float");
	eq(b.value.join(","), "0", "a non-numeric component becomes 0 and the value is trimmed to the type");
	eq(b.min, 0, "a non-numeric min falls back to 0");
	eq(b.max, 3, "a numeric max is kept");
}

console.log(`ok - ${passed} assertions passed`);
