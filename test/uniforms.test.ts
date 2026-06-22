// Unit tests for custom-uniform declaration handling in the shader wrapper.
// Run with: node --experimental-strip-types test/uniforms.test.ts
//
// Motivated by a chat session where the AI declared uniforms WITH trailing
// comments (`uniform float u_blur; // radius`). The old line-anchored regex
// required the line to end right after the `;`, so those declarations were:
//   - never extracted -> the control never appeared (project state "(none)"),
//     and set_uniforms metadata was dropped on the next edit; and
//   - never stripped from the body -> re-declaring the name (or letting
//     set_uniforms hoist it into the header) produced a GLSL "redefinition".

import { extractUniformDeclarations, assembleFragment } from "../src/gl/wrapper.ts";
import type { Uniform } from "../src/state/types.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
	passed++;
}
function ok(cond: boolean, msg: string): void {
	eq(cond, true, msg);
}

// --- Extraction tolerates trailing comments; ignores dead/sampler lines. ---
{
	const src = [
		'uniform vec3  u_bgColor;     // the "background black" shade',
		"uniform float u_bgBlur;      // frosted background blur radius (px)",
		"uniform float u_plain;",
		"uniform float u_block; /* radius */",
		"\tuniform vec4 u_indented;\t// rgba",
		"// uniform float u_dead;     // commented-out: must be ignored",
		"uniform sampler2D iChannel0; // sampler: handled separately, ignored",
		"void mainImage(out vec4 o, in vec2 c) { o = vec4(0); }",
	].join("\n");
	const decls = extractUniformDeclarations(src);
	eq(decls.map((u) => u.name).join(","), "u_bgColor,u_bgBlur,u_plain,u_block,u_indented", "commented decls extracted, dead/sampler ignored");
	eq(decls.find((u) => u.name === "u_bgColor")?.type, "vec3", "type parsed across the double space");
}

// --- assembleFragment: a commented decl is stripped from the body (no
//     redefinition) and hoisted into the header exactly once. ---
{
	const userSrc = ["uniform float u_blur; // blur radius", "void mainImage(out vec4 o, in vec2 c) { o = vec4(u_blur); }"].join("\n");
	const uniforms: Uniform[] = [{ name: "u_blur", type: "float", value: [0], min: 0, max: 1, step: 0.01 }];
	const { source } = assembleFragment(userSrc, uniforms, 0);
	const decls = source.split("\n").filter((l) => l.trim() === "uniform float u_blur;");
	eq(decls.length, 1, "exactly one `uniform float u_blur;` (header only, body stripped)");
	ok(!/uniform float u_blur;\s*\/\//.test(source), "the commented body declaration was removed");
}

// --- Header dedupe: a duplicated uniform never emits a redefinition. ---
{
	const dup: Uniform[] = [
		{ name: "u_x", type: "float", value: [0], min: 0, max: 1, step: 0.01 },
		{ name: "u_x", type: "float", value: [0], min: 0, max: 1, step: 0.01 },
	];
	const { source } = assembleFragment("void mainImage(out vec4 o, in vec2 c){o=vec4(u_x);}", dup, 0);
	const count = source.split("\n").filter((l) => l.trim() === "uniform float u_x;").length;
	eq(count, 1, "duplicate uniform collapsed to a single header declaration");
}

console.log(`ok - ${passed} assertions passed`);
