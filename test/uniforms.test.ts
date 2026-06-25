// Unit tests for custom-uniform extraction from shader source. Covers the forms
// the AI actually writes -- in particular `uniform float u = 1.5;` style baked
// defaults and precision qualifiers, which used to be silently dropped (declared
// inline, rendered, but never surfaced as a control -> the editor showed "(none)"),
// plus trailing `//` / `/* */` comments and de-duplicated header declarations.
// DOM-free, so plain Node can exercise it:
//   node --experimental-strip-types test/uniforms.test.ts

import { assembleFragment, extractUniformDeclarations, formatUniformDeclarations, reconcileUniforms } from "../src/gl/wrapper.ts";
import type { Uniform } from "../src/state/types.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function eq(a: unknown, b: unknown, msg: string): void {
	check(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);
}
function near(a: number, b: number, msg: string): void {
	check(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);
}
function byName(us: Uniform[], name: string): Uniform {
	const u = us.find((x) => x.name === name);
	if (!u) throw new Error(`FAIL: no uniform named ${name} (have: ${us.map((x) => x.name).join(", ") || "none"})`);
	return u;
}

// ---- the bare form still works exactly as before ---------------------------
{
	const us = extractUniformDeclarations("uniform float u_speed;\nuniform vec3 u_tint;");
	eq(us.length, 2, "bare declarations extracted");
	const s = byName(us, "u_speed");
	eq(s.type, "float", "float type");
	eq(s.value.length, 1, "float has one component");
	near(s.value[0], 0, "bare uniform defaults to 0");
	near(s.min, 0, "bare min 0");
	near(s.max, 1, "bare max 1");
	near(s.step, 0.01, "bare step 0.01");
	eq(byName(us, "u_tint").value.length, 3, "vec3 has three components");
}

// ---- baked defaults via `= <value>` initializers ---------------------------
{
	const src = `
uniform float u_speed = 1.5;
uniform vec3 u_tint = vec3(1.0, 0.5, 0.2);
uniform vec3 u_grey = vec3(0.5);
uniform vec2 u_off = vec2(-3.0, 4.0);
uniform float u_unit = 1.0;
void mainImage(out vec4 c, in vec2 f){ c = vec4(u_tint * u_speed, 1.0); }`;
	const us = extractUniformDeclarations(src);
	eq(us.length, 5, "all five initialized uniforms extracted");

	const speed = byName(us, "u_speed");
	near(speed.value[0], 1.5, "float initializer value parsed");
	near(speed.max, 2, "max widened above the baked default");
	check(speed.max >= speed.value[0], "baked default fits inside the slider range");

	const tint = byName(us, "u_tint");
	near(tint.value[0], 1.0, "vec3 component 0");
	near(tint.value[1], 0.5, "vec3 component 1");
	near(tint.value[2], 0.2, "vec3 component 2");
	near(tint.min, 0, "in-range vec keeps min 0");
	near(tint.max, 1, "in-range vec keeps max 1");

	const grey = byName(us, "u_grey");
	near(grey.value[0], 0.5, "single-arg vec constructor splats (x)");
	near(grey.value[1], 0.5, "single-arg vec constructor splats (y)");
	near(grey.value[2], 0.5, "single-arg vec constructor splats (z)");

	const off = byName(us, "u_off");
	near(off.value[0], -3, "negative vec component parsed");
	near(off.value[1], 4, "positive vec component parsed");
	check(off.min < 0, "negative default makes the range symmetric (min < 0)");
	check(off.min <= -3 && off.max >= 4, "range contains both components");

	near(byName(us, "u_unit").value[0], 1.0, "value of exactly 1.0 keeps the canonical 0..1 range");
	near(byName(us, "u_unit").max, 1, "1.0 default does not widen the range");
}

// ---- GLSL single-precision `f`/`F` suffix on float literals ----------------
// GLSL ES 3.00 permits `1.5f` / `40.0F` / `1e3f`; `Number()` rejects the suffix,
// so an idiomatic baked default like `uniform float u_r = 40.0f;` used to parse
// to NaN and the control silently fell back to 0 (the "0 placeholder" symptom).
{
	const src = [
		"uniform float u_blur = 40.0f;",
		"uniform float u_gain = 1.5F;",
		"uniform float u_exp = 2e3f;",
		"uniform vec3 u_tint = vec3(1.0f, 0.5f, 0.25f);",
		"void mainImage(out vec4 o, in vec2 c){ o = vec4(u_tint * u_gain, u_blur + u_exp); }",
	].join("\n");
	const us = extractUniformDeclarations(src);
	near(byName(us, "u_blur").value[0], 40, "float `40.0f` suffix parsed (not 0)");
	near(byName(us, "u_gain").value[0], 1.5, "float `1.5F` suffix parsed");
	near(byName(us, "u_exp").value[0], 2000, "float `2e3f` exponent+suffix parsed");
	const tint = byName(us, "u_tint");
	near(tint.value[0], 1.0, "vec component `1.0f` suffix parsed");
	near(tint.value[1], 0.5, "vec component `0.5f` suffix parsed");
	near(tint.value[2], 0.25, "vec component `0.25f` suffix parsed");
}

// ---- precision qualifiers are tolerated ------------------------------------
{
	const us = extractUniformDeclarations("uniform highp float u_gain = 2.0;\nuniform mediump vec2 u_res;\nuniform lowp vec3 u_c;");
	eq(us.length, 3, "qualified declarations extracted");
	near(byName(us, "u_gain").value[0], 2.0, "qualified + initialized value parsed");
	eq(byName(us, "u_res").type, "vec2", "qualified vec2 type");
}

// ---- unparseable initializers fall back to zero (never crash) --------------
{
	const us = extractUniformDeclarations("uniform float u_expr = 0.5 * SCALE;\nuniform vec3 u_bad = someFunc();");
	eq(us.length, 2, "declarations with non-literal initializers still extracted");
	near(byName(us, "u_expr").value[0], 0, "non-literal float initializer falls back to 0");
	near(byName(us, "u_bad").value[0], 0, "non-constructor vec initializer falls back to 0");
}

// ---- reserved / built-in names are skipped ---------------------------------
{
	const us = extractUniformDeclarations("uniform float iTime;\nuniform vec3 iResolution = vec3(1.0);\nuniform float u_ok;");
	eq(us.length, 1, "built-in names are not surfaced as custom controls");
	eq(us[0].name, "u_ok", "only the genuine custom uniform survives");
}

// ---- assembled shader: initializer is stripped, declared once, no `=` -------
{
	const src = `uniform float u_speed = 1.5;
uniform highp vec3 u_tint = vec3(1.0, 0.5, 0.2);
void mainImage(out vec4 c, in vec2 f){ c = vec4(u_tint * u_speed, 1.0); }`;
	const uniforms = extractUniformDeclarations(src);
	const assembled = assembleFragment(src, uniforms, 0).source;
	eq((assembled.match(/uniform float u_speed;/g) ?? []).length, 1, "u_speed declared exactly once");
	eq((assembled.match(/uniform vec3 u_tint;/g) ?? []).length, 1, "u_tint declared exactly once (qualifier dropped in header)");
	check(!assembled.includes("= 1.5"), "the float initializer is stripped from the assembled source");
	check(!assembled.includes("vec3(1.0, 0.5, 0.2)"), "the vec initializer is stripped from the assembled source");
	check(!/uniform[ \t]+highp/.test(assembled), "no leftover qualified declaration from the user body");
}

// ---- trailing line / block comments on a declaration are tolerated ---------
// The natural `uniform float u_blur; // radius` used to break the regex, so the
// control never appeared AND the line stayed inline (a later re-declare clashed).
{
	const src = [
		'uniform vec3  u_bgColor;     // the "background black" shade',
		"uniform float u_bgBlur;      // frosted blur radius (px)",
		"uniform float u_block; /* radius */",
		"// uniform float u_dead;     // commented-out: must be ignored",
		"uniform sampler2D iChannel0; // sampler: handled separately, ignored",
		"void mainImage(out vec4 o, in vec2 c){ o = vec4(u_bgColor, u_bgBlur + u_block, 1.0); }",
	].join("\n");
	const us = extractUniformDeclarations(src);
	eq(us.map((u) => u.name).join(","), "u_bgColor,u_bgBlur,u_block", "commented decls extracted; dead/sampler ignored");
	const assembled = assembleFragment(src, us, 0).source;
	check(!/u_bgColor;[ \t]*\/\//.test(assembled), "commented declaration stripped from the body");
	eq((assembled.match(/uniform float u_bgBlur;/g) ?? []).length, 1, "u_bgBlur declared exactly once");
}

// ---- an initializer AND a trailing comment together (the merge case) -------
{
	const us = extractUniformDeclarations("uniform float u_x = 1.5; // speed\nuniform vec3 u_t = vec3(0.5); /* tint */");
	eq(us.length, 2, "decls with both an initializer and a trailing comment are extracted");
	near(byName(us, "u_x").value[0], 1.5, "initializer parsed despite the trailing // comment");
	near(byName(us, "u_t").value[0], 0.5, "vec initializer parsed despite the trailing /* */ comment");
	const assembled = assembleFragment("uniform float u_x = 1.5; // speed\nvoid mainImage(out vec4 o,in vec2 c){o=vec4(u_x);}", us, 0).source;
	check(!assembled.includes("= 1.5"), "initializer stripped even with a trailing comment");
	check(!assembled.includes("// speed"), "trailing comment stripped from the body");
}

// ---- duplicate uniforms never produce a GLSL redefinition ------------------
{
	const dup: Uniform[] = [
		{ name: "u_x", type: "float", value: [0], min: 0, max: 1, step: 0.01 },
		{ name: "u_x", type: "float", value: [0], min: 0, max: 1, step: 0.01 },
	];
	const assembled = assembleFragment("void mainImage(out vec4 o,in vec2 c){o=vec4(u_x);}", dup, 0).source;
	eq((assembled.match(/uniform float u_x;/g) ?? []).length, 1, "duplicate uniform collapsed to a single header declaration");
}

// ---- formatUniformDeclarations: the inverse of extraction (round-trips) -----
// Powers the Uniforms tab "Copy uniforms" button: serialize current values as
// GLSL declarations that paste straight back into a shader and re-extract identically.
{
	const original: Uniform[] = [
		{ name: "u_speed", type: "float", value: [1.5], min: 0, max: 2, step: 0.01 },
		{ name: "u_tint", type: "vec3", value: [1, 0.5, 0.2], min: 0, max: 1, step: 0.01 },
		{ name: "u_off", type: "vec2", value: [-3, 4], min: -4, max: 4, step: 0.1 },
		{ name: "u_quad", type: "vec4", value: [0.1, 0.2, 0.3, 0.4], min: 0, max: 1, step: 0.01 },
		{ name: "u_col", type: "color", value: [0.25, 0.5, 0.75], min: 0, max: 1, step: 0.01 },
	];
	const text = formatUniformDeclarations(original);
	check(text.split("\n").every((l) => /^uniform (float|vec[234]) u_\w+ = .+;$/.test(l)), "every line is a uniform declaration with a baked initializer");
	check(text.includes("uniform float u_speed = 1.5;"), "float value baked into the declaration");
	check(text.includes("uniform vec3 u_tint = vec3(1.0, 0.5, 0.2);"), "vec3 components serialized as a constructor (integers get a decimal point)");
	check(text.includes("uniform vec3 u_col = vec3(0.25, 0.5, 0.75);"), "color is serialized as a vec3 with its rgb value");

	// Re-extracting the copied text yields the same names, values, and GLSL types.
	const back = extractUniformDeclarations(text);
	eq(back.length, original.length, "every uniform round-trips back out");
	near(byName(back, "u_speed").value[0], 1.5, "float value preserved through a round-trip");
	near(byName(back, "u_tint").value[0], 1, "vec3 component preserved (x)");
	near(byName(back, "u_tint").value[2], 0.2, "vec3 component preserved (z)");
	near(byName(back, "u_off").value[0], -3, "negative component preserved");
	near(byName(back, "u_off").value[1], 4, "positive component preserved");
	near(byName(back, "u_quad").value[3], 0.4, "vec4 fourth component preserved");
	eq(byName(back, "u_col").type, "vec3", "a color comes back as a vec3 (GLSL has no color type)");
	near(byName(back, "u_col").value[1], 0.5, "color green channel preserved");
}

// ---- formatting trims float noise and never emits a bare integer literal ----
{
	const noisy: Uniform[] = [{ name: "u_n", type: "vec2", value: [0.1 + 0.2, 2], min: 0, max: 1, step: 0.01 }];
	const text = formatUniformDeclarations(noisy);
	check(!text.includes("0.30000000000000004"), "float noise is trimmed (0.1 + 0.2)");
	check(text.includes("vec2(0.3, 2.0)"), "integer component gets a decimal point so it stays a GLSL float");
}

// ---- reconcileUniforms: control list <- shader declarations -----------------
// Reconciles the live control list against the uniforms declared in source. The
// store calls this on every recompile; it must preserve slider / set_uniforms
// values across UNRELATED edits, yet adopt a deliberately CHANGED initializer.
{
	const decl = (name: string, value: number[]): Uniform => ({ name, type: value.length === 1 ? "float" : value.length === 2 ? "vec2" : value.length === 4 ? "vec4" : "vec3", value, min: 0, max: 1, step: 0.01 });

	// New uniform (not previously present) takes its declared default as-is.
	{
		const next = reconcileUniforms([decl("u_a", [0.5])], [], {});
		near(byName(next, "u_a").value[0], 0.5, "new uniform adopts its declared default");
	}

	// Unchanged initializer + a live value (slider / set_uniforms) -> value preserved.
	{
		const previous = [decl("u_a", [0.7])]; // user dragged it to 0.7
		const next = reconcileUniforms([decl("u_a", [0.5])], previous, { u_a: [0.5] });
		near(byName(next, "u_a").value[0], 0.7, "unchanged initializer keeps the live value");
	}

	// GOTCHA 2: the initializer was edited (0.5 -> 1.5) -> adopt the new default.
	{
		const previous = [decl("u_speed", [0])]; // was bare (0)
		const next = reconcileUniforms([decl("u_speed", [1.5])], previous, { u_speed: [0] });
		near(byName(next, "u_speed").value[0], 1.5, "a changed initializer takes effect (not silently ignored)");
	}

	// No record of a prior default (fresh load / undo restore) -> preserve, never
	// re-adopt the initializer over the persisted value.
	{
		const previous = [decl("u_a", [0.9])]; // persisted slider value
		const next = reconcileUniforms([decl("u_a", [0.2])], previous, {}); // empty lastDefaults
		near(byName(next, "u_a").value[0], 0.9, "with no remembered default, the persisted value is preserved");
	}

	// A color control stays a color when its vec3 declaration is unchanged.
	{
		const previous: Uniform[] = [{ name: "u_col", type: "color", value: [0.2, 0.4, 0.6], min: 0, max: 1, step: 0.01 }];
		const next = reconcileUniforms([decl("u_col", [0, 0, 0])], previous, { u_col: [0, 0, 0] });
		eq(byName(next, "u_col").type, "color", "a color control survives reconciliation as a color");
		near(byName(next, "u_col").value[1], 0.4, "color value preserved");
	}

	// A declaration removed from source drops out of the control list.
	{
		const next = reconcileUniforms([decl("u_a", [0.5])], [decl("u_a", [0.5]), decl("u_gone", [0.3])], { u_a: [0.5], u_gone: [0.3] });
		eq(next.length, 1, "a uniform whose declaration was removed drops out");
		eq(next[0].name, "u_a", "only the still-declared uniform remains");
	}
}

console.log(`uniforms.test.ts: ${passed} checks passed`);
