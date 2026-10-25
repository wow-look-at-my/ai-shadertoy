
// iChannelN (any N) is a reserved input sampler name; the count is dynamic.

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
// One custom-uniform declaration on its own line.
const CUSTOM_UNIFORM_RE = /^[ \t]*uniform[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?(float|vec2|vec3|vec4)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:=[ \t]*([^;\n]*?))?[ \t]*;[ \t]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/[ \t]*)?\r?$/gm;

// Comments blanked to spaces (newlines kept), so a declaration inside a block
// comment matches nothing while every match index still maps onto the source.
function maskComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Every custom-uniform declaration outside a comment, as regex matches whose
 * indices address the ORIGINAL source. */
function declarationMatches(source: string): RegExpMatchArray[] {
	return [...maskComments(source).matchAll(CUSTOM_UNIFORM_RE)];
}

export function isValidUniformName(name: string): boolean {
	if (!VALID_NAME.test(name)) return false;
	if (name.startsWith("gl_")) return false; // reserved
	if (CHANNEL_NAME.test(name)) return false; // reserved input samplers
	return !BUILTIN_NAMES.has(name);
}

/** Parse one GLSL numeric literal to a JS number. */
function glslLiteralToNumber(s: string): number {
	const t = s.trim();
	return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?$/.test(t) ? Number(t.replace(/[fF]$/, "")) : Number(t);
}

/** Parse a GLSL initializer expression into component values, or null if it isn't a
 * plain numeric literal / vecN(...) constructor we can evaluate. */
function parseInitializer(type: UniformType, expr: string | undefined): number[] | null {
	if (!expr) return null;
	const n = uniformLength(type);
	const e = expr.trim();
	if (type === "float") {
		const v = glslLiteralToNumber(e);
		return Number.isFinite(v) ? [v] : null;
	}
	const m = e.match(/^vec[234][ \t]*\(([^)]*)\)$/);
	if (!m) return null;
	const args = m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	if (args.length === 0) return null;
	const nums = args.map(glslLiteralToNumber);
	if (nums.some((x) => !Number.isFinite(x))) return null;
	if (nums.length === 1) return new Array(n).fill(nums[0]);
	return Array.from({ length: n }, (_, i) => nums[i] ?? 0);
}

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

/** Pick a slider range that contains every component value. */
export function rangeForValues(values: number[]): { min: number; max: number; step: number } {
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
	for (const m of declarationMatches(source)) {
		const type = m[1] as UniformType;
		const name = m[2];
		if (!isValidUniformName(name)) continue;
		const value = parseInitializer(type, m[3]) ?? new Array(uniformLength(type)).fill(0);
		out.push({ name, type, value, ...rangeForValues(value) });
	}
	return out;
}

/** Number of value components a uniform of this type carries (color is a vec3). */
export function uniformLength(type: UniformType): number {
	return type === "float" ? 1 : type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
}

function valuesEqual(a: number[], b: number[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Reconcile the live control list against the uniforms DECLARED in shader source.
 * `previous` is the current control list, whose values may have been moved by a
 * slider drag or a set_uniforms call. `lastDefaults` records, per name, the declared
 * default seen on the LAST reconcile, so a deliberately CHANGED initializer can be
 * told apart from an unchanged one. */
export function reconcileUniforms(declared: Uniform[], previous: Uniform[], lastDefaults: Record<string, number[]>): Uniform[] {
	const prevByName = new Map(previous.map((u) => [u.name, u]));
	return declared.map((decl) => {
		const prev = prevByName.get(decl.name);
		if (!prev) return decl;
		const last = lastDefaults[decl.name];
		if (last !== undefined && !valuesEqual(last, decl.value)) return decl; // initializer rewritten -> adopt it
		const type = prev.type === "color" && decl.type === "vec3" ? "color" : decl.type;
		const length = uniformLength(type);
		const value = prev.value.slice(0, length);
		while (value.length < length) value.push(0);
		return { ...decl, type, value, min: prev.min, max: prev.max, step: prev.step, label: prev.label };
	});
}

// Removes the matched declarations only (never a newline), so `#line 1` keeps
// mapping compile errors onto the user's line numbers.
function stripUniformDeclarations(source: string): string {
	let out = "";
	let at = 0;
	for (const m of declarationMatches(source)) {
		out += source.slice(at, m.index);
		at = m.index! + m[0].length;
	}
	return out + source.slice(at);
}

/** The inverse of parseInitializer's Number(). */
function formatGlslNumber(v: number): string {
	if (!Number.isFinite(v)) return "0.0";
	const s = String(Number(v.toPrecision(6)));
	return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Serialize one uniform as a GLSL declaration with its CURRENT value baked in as an
 * `= <default>` initializer -- exactly the form extractUniformDeclarations reads
 * back. Do this so the output round-trips (a `color` becomes a `vec3`, matching
 * glslType). */
export function formatUniformDeclaration(u: Uniform): string {
	const type = glslType(u.type);
	const n = uniformLength(u.type);
	const comps = Array.from({ length: n }, (_, i) => formatGlslNumber(u.value[i] ?? 0));
	const init = n === 1 ? comps[0] : `${type}(${comps.join(", ")})`;
	return `uniform ${type} ${u.name} = ${init};`;
}

/** Serialize every uniform as newline-separated GLSL declarations (current
 * values baked in) -- powers the Uniforms tab "Copy" button. */
export function formatUniformDeclarations(uniforms: Uniform[]): string {
	return uniforms.map(formatUniformDeclaration).join("\n");
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
	"ai_fragOffset",
	"mainImage",
	"main",
]);

// Square-pixel mode hands mainImage a centred fragCoord and a square
// iResolution, so `fragCoord / iResolution.xy` is a square-space uv. A channel
// that is a canvas render target (pass, under, geometry, mask) is stored in
// texture space. ai_chanRemap[i] (scale.xy, offset.zw) maps a square-space uv
// onto it and ai_chanFetch[i] shifts a texel coordinate the same way. Both are
// identity for every other channel and whenever square pixels are off.
function channelRemapDecls(channelCount: number): string {
	return `uniform vec4 ai_chanRemap[${channelCount}];
uniform ivec2 ai_chanFetch[${channelCount}];
vec4 ai_texture(vec4 r, sampler2D s, vec2 uv) { return texture(s, uv * r.xy + r.zw); }
vec4 ai_texture(vec4 r, sampler2D s, vec2 uv, float bias) { return texture(s, uv * r.xy + r.zw, bias); }
vec4 ai_textureLod(vec4 r, sampler2D s, vec2 uv, float lod) { return textureLod(s, uv * r.xy + r.zw, lod); }
vec4 ai_texelFetch(ivec2 o, sampler2D s, ivec2 p, int lod) { return texelFetch(s, p + o, lod); }
`;
}

/** Route every direct `texture`/`textureLod`/`texelFetch` on a declared iChannel
 * through its remap. Line breaks are untouched, so `#line 1` still maps errors. */
export function remapChannelLookups(source: string, channelCount: number): string {
	return source.replace(/\b(texture|textureLod|texelFetch)(\s*\(\s*)iChannel(\d+)(\s*,)/g, (match, fn: string, open: string, idx: string, comma: string) => {
		const i = Number(idx);
		if (i >= channelCount) return match;
		const remap = fn === "texelFetch" ? `ai_chanFetch[${i}]` : `ai_chanRemap[${i}]`;
		return `ai_${fn}${open}${remap}, iChannel${i}${comma}`;
	});
}

function header(uniforms: Uniform[], channelCount: number): string {
	// Dedupe by name: emitting the same `uniform` twice is a GLSL redefinition.
	const seen = new Set<string>();
	const customDecls = uniforms
		.filter((u) => {
			if (!isValidUniformName(u.name) || seen.has(u.name)) return false;
			seen.add(u.name);
			return true;
		})
		.map((u) => `uniform ${glslType(u.type)} ${u.name};`)
		.join("\n");
	// Declare exactly the input samplers this pass has (iChannel0..N-1) plus a matching iChannelResolution[] -- no arbitrary cap, no unused declarations.
<<<<<<< HEAD
	const channelDecls = channelCount > 0 ? Array.from({ length: channelCount }, (_, i) => `uniform sampler2D iChannel${i};`).join("\n") + `\nuniform vec3 iChannelResolution[${channelCount}];\n` + channelRemapDecls(channelCount) : "";
=======
	const channelDecls = channelCount > 0 ? Array.from({ length: channelCount }, (_, i) => `uniform sampler2D iChannel${i};`).join("\n") + `\nuniform vec3 iChannelResolution[${channelCount}];\n` : "";
>>>>>>> origin/master
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
uniform vec2 ai_fragOffset;
${channelDecls}
${customDecls}
`;
}

const FOOTER = `

void main() {
	vec4 ai_color = vec4(0.0, 0.0, 0.0, 1.0);
	// ai_fragOffset centres "square pixels" tiling (0 otherwise), so the shader sees
	// a fragCoord whose origin is shifted to keep uv = fragCoord/iResolution centred.
	mainImage(ai_color, gl_FragCoord.xy - ai_fragOffset);
	ai_fragColor = ai_color;
}
`;

export interface AssembledShader {
	source: string;
}

/** Build the complete fragment shader. `channelCount` is the number of iChannel
 * inputs this pass declares. Errors inside FOOTER (a missing or mistyped
 * `mainImage`) report a line just past the end of the user source. */
export function assembleFragment(userSource: string, uniforms: Uniform[], channelCount: number): AssembledShader {
	return { source: header(uniforms, channelCount) + "#line 1\n" + remapChannelLookups(stripUniformDeclarations(userSource), channelCount) + FOOTER };
}
