// Assembles the full WebGL2 (GLSL ES 3.00) fragment shader from the user's
// Shadertoy-style `mainImage` body plus a fixed header of built-in and custom
// uniforms. A `#line 1` directive is emitted immediately before the user code
// so the driver's compile log reports user-relative line numbers.

import type { Uniform, UniformType } from "../state/types.ts";

export function glslType(t: UniformType): string {
	switch (t) {
		case "float":
			return "float";
		case "vec2":
			return "vec2";
		case "vec3":
			return "vec3";
		case "vec4":
			return "vec4";
		case "color":
			return "vec3";
	}
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// iChannelN (any N) is a reserved input sampler name; the count is dynamic.
const CHANNEL_NAME = /^iChannel\d+$/;
// One custom-uniform declaration on its own line. Tolerates an optional precision
// qualifier (highp/mediump/lowp) and an optional `= <default>` initializer so the
// AI can bake a default value right into the declaration -- group 1 = type, group
// 2 = name, group 3 = the initializer expression (without the `=`), if any. The
// SAME regex drives both extraction and stripping, so whatever we surface as a
// control is exactly what we remove from the user body (the header re-declares it,
// without the initializer, which GLSL ES requires).
const CUSTOM_UNIFORM_RE = /^[ \t]*uniform[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?(float|vec2|vec3|vec4)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:=[ \t]*([^;\n]*?))?[ \t]*;[ \t]*$/gm;

export function isValidUniformName(name: string): boolean {
	if (!VALID_NAME.test(name)) return false;
	if (name.startsWith("gl_")) return false; // reserved
	if (CHANNEL_NAME.test(name)) return false; // reserved input samplers
	return !BUILTIN_NAMES.has(name);
}

function componentCount(type: UniformType): number {
	return type === "float" ? 1 : type === "vec2" ? 2 : type === "vec3" ? 3 : 4;
}

/** Parse a GLSL initializer expression into component values, or null if it isn't
 * a plain numeric literal / vecN(...) constructor we can evaluate. Single-argument
 * vector constructors splat (vec3(0.5) -> [0.5,0.5,0.5]); too-few args pad with 0. */
function parseInitializer(type: UniformType, expr: string | undefined): number[] | null {
	if (!expr) return null;
	const n = componentCount(type);
	const e = expr.trim();
	if (type === "float") {
		const v = Number(e);
		return Number.isFinite(v) ? [v] : null;
	}
	const m = e.match(/^vec[234][ \t]*\(([^)]*)\)$/);
	if (!m) return null;
	const args = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	if (args.length === 0) return null;
	const nums = args.map(Number);
	if (nums.some((x) => !Number.isFinite(x))) return null;
	if (nums.length === 1) return new Array(n).fill(nums[0]);
	return Array.from({ length: n }, (_, i) => nums[i] ?? 0);
}

/** Round v UP to a "nice" 1/2/5 * 10^k bound (>= 1) so a baked default lands
 * comfortably inside the slider range rather than pinned at the very end. */
function niceCeil(v: number): number {
	if (v <= 1) return 1;
	const pow = Math.pow(10, Math.floor(Math.log10(v)));
	const n = v / pow;
	const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
	return mult * pow;
}

function niceStep(range: number): number {
	const raw = range / 100;
	const pow = Math.pow(10, Math.floor(Math.log10(raw)));
	const n = raw / pow;
	const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
	return Number((mult * pow).toPrecision(2));
}

/** Pick a slider range that contains every component value. Values already inside
 * 0..1 keep the canonical 0..1 / 0.01 range (unchanged from before); a baked
 * default outside it widens the range (symmetric when any component is negative). */
function rangeForValues(values: number[]): { min: number; max: number; step: number } {
	let lo = 0;
	let hi = 1;
	for (const v of values) {
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	if (lo >= 0 && hi <= 1) return { min: 0, max: 1, step: 0.01 };
	const bound = niceCeil(Math.max(1, Math.abs(lo), Math.abs(hi)));
	const min = lo < 0 ? -bound : 0;
	return { min, max: bound, step: niceStep(bound - min) };
}

export function extractUniformDeclarations(source: string): Uniform[] {
	const out: Uniform[] = [];
	for (const m of source.matchAll(CUSTOM_UNIFORM_RE)) {
		const type = m[1] as UniformType;
		const name = m[2];
		if (!isValidUniformName(name)) continue;
		const value = parseInitializer(type, m[3]) ?? new Array(componentCount(type)).fill(0);
		out.push({ name, type, value, ...rangeForValues(value) });
	}
	return out;
}

function stripUniformDeclarations(source: string): string {
	return source.replace(CUSTOM_UNIFORM_RE, "");
}

const BUILTIN_NAMES = new Set([
	"iResolution",
	"iTime",
	"iTimeDelta",
	"iFrameRate",
	"iFrame",
	"iMouse",
	"iDate",
	"iChannelResolution",
	"mainImage",
	"main",
]);

function header(uniforms: Uniform[], channelCount: number): string {
	const customDecls = uniforms
		.filter((u) => isValidUniformName(u.name))
		.map((u) => `uniform ${glslType(u.type)} ${u.name};`)
		.join("\n");
	// Declare exactly the input samplers this pass has (iChannel0..N-1) plus a
	// matching iChannelResolution[] -- no arbitrary cap, no unused declarations.
	const channelDecls = channelCount > 0 ? Array.from({ length: channelCount }, (_, i) => `uniform sampler2D iChannel${i};`).join("\n") + `\nuniform vec3 iChannelResolution[${channelCount}];\n` : "";
	return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

out vec4 ai_fragColor;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int iFrame;
uniform vec4 iMouse;
uniform vec4 iDate;
${channelDecls}
${customDecls}
`;
}

const FOOTER = `

void main() {
	vec4 ai_color = vec4(0.0, 0.0, 0.0, 1.0);
	mainImage(ai_color, gl_FragCoord.xy);
	ai_fragColor = ai_color;
}
`;

export interface AssembledShader {
	source: string;
	headerLines: number;
}

/** Build the complete fragment shader and report how many header lines precede
 * the `#line 1` directive (for diagnostics that need the raw offset).
 * `channelCount` is the number of iChannel inputs this pass declares. */
export function assembleFragment(userSource: string, uniforms: Uniform[], channelCount: number): AssembledShader {
	const head = header(uniforms, channelCount);
	const prefix = head + "#line 1\n";
	const headerLines = prefix.split("\n").length - 1;
	return { source: prefix + stripUniformDeclarations(userSource) + FOOTER, headerLines };
}
