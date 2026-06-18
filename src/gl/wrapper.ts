// Assembles the full WebGL2 (GLSL ES 3.00) fragment shader from the user's
// Shadertoy-style `mainImage` body plus a fixed header of built-in and custom
// uniforms. A `#line 1` directive is emitted immediately before the user code
// so the driver's compile log reports user-relative line numbers.

import type { Uniform, UniformType } from "../state/types.ts";

export const VERTEX_SHADER = `#version 300 es
// Full-screen triangle; no attributes needed.
void main() {
	vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

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

export function isValidUniformName(name: string): boolean {
	if (!VALID_NAME.test(name)) return false;
	if (name.startsWith("gl_")) return false; // reserved
	return !BUILTIN_NAMES.has(name);
}

const BUILTIN_NAMES = new Set([
	"iResolution",
	"iTime",
	"iTimeDelta",
	"iFrameRate",
	"iFrame",
	"iMouse",
	"iDate",
	"iChannel0",
	"iChannel1",
	"iChannel2",
	"iChannel3",
	"iChannelResolution",
	"mainImage",
	"main",
]);

function header(uniforms: Uniform[]): string {
	const customDecls = uniforms
		.filter((u) => isValidUniformName(u.name))
		.map((u) => `uniform ${glslType(u.type)} ${u.name};`)
		.join("\n");
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
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3 iChannelResolution[4];

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
 * the `#line 1` directive (for diagnostics that need the raw offset). */
export function assembleFragment(userSource: string, uniforms: Uniform[]): AssembledShader {
	const head = header(uniforms);
	const prefix = head + "#line 1\n";
	const headerLines = prefix.split("\n").length - 1;
	return { source: prefix + userSource + FOOTER, headerLines };
}
