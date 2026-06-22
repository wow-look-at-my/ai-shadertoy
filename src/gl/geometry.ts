// Real instanced vertex geometry for layer shapes. One unit quad mesh is drawn
// once per shape via instancing (gl.drawArraysInstanced); the per-shape transform
// + style ride in a per-instance attribute buffer, and the actual outline is cut
// out in the fragment shader by the kind's signed-distance function. Shapes are
// rasterized into a layer's "geometry" texture with premultiplied "over"
// blending, in array order (painter's order within the layer).

import type { Shape } from "../state/types.ts";
import { shapeKindIndex } from "./shapes.ts";

// Per-instance layout: a_box(4) + a_color(4) + a_misc(4) + a_extra(4) = 16 floats.
const FLOATS_PER_INSTANCE = 16;

// Unit quad corners in [-0.5, 0.5], drawn as a triangle strip.
const QUAD_CORNERS = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);

export class GeometryBatch {
	private gl: WebGL2RenderingContext;
	private program: WebGLProgram;
	private vao: WebGLVertexArrayObject;
	private cornerBuf: WebGLBuffer;
	private instanceBuf: WebGLBuffer;
	private instanceData = new Float32Array(0);
	private locResolution: WebGLUniformLocation | null;
	private locOpacity: WebGLUniformLocation | null;

	constructor(gl: WebGL2RenderingContext, vertSource: string, fragSource: string) {
		this.gl = gl;
		this.program = this.link(vertSource, fragSource);
		this.locResolution = gl.getUniformLocation(this.program, "uResolution");
		this.locOpacity = gl.getUniformLocation(this.program, "uOpacity");

		this.vao = gl.createVertexArray()!;
		gl.bindVertexArray(this.vao);

		this.cornerBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
		gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

		this.instanceBuf = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
		const stride = FLOATS_PER_INSTANCE * 4;
		for (let i = 0; i < 4; i++) {
			const loc = 1 + i;
			gl.enableVertexAttribArray(loc);
			gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, i * 16);
			gl.vertexAttribDivisor(loc, 1);
		}
		gl.bindVertexArray(null);
	}

	private link(vertSource: string, fragSource: string): WebGLProgram {
		const gl = this.gl;
		const vs = this.compile(gl.VERTEX_SHADER, vertSource);
		const fs = this.compile(gl.FRAGMENT_SHADER, fragSource);
		const program = gl.createProgram()!;
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(program) ?? "shape program link failed";
			gl.deleteProgram(program);
			throw new Error(log);
		}
		return program;
	}

	private compile(type: number, source: string): WebGLShader {
		const gl = this.gl;
		const sh = gl.createShader(type)!;
		gl.shaderSource(sh, source);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(sh) ?? "shape shader compile failed";
			gl.deleteShader(sh);
			throw new Error(log);
		}
		return sh;
	}

	private pack(shapes: Shape[]): void {
		const n = shapes.length;
		if (this.instanceData.length < n * FLOATS_PER_INSTANCE) this.instanceData = new Float32Array(n * FLOATS_PER_INSTANCE);
		const d = this.instanceData;
		for (let i = 0; i < n; i++) {
			const s = shapes[i];
			const o = i * FLOATS_PER_INSTANCE;
			d[o + 0] = s.x;
			d[o + 1] = s.y;
			d[o + 2] = s.w;
			d[o + 3] = s.h;
			d[o + 4] = s.color[0];
			d[o + 5] = s.color[1];
			d[o + 6] = s.color[2];
			d[o + 7] = s.color[3];
			d[o + 8] = s.rotation;
			d[o + 9] = shapeKindIndex(s.kind);
			d[o + 10] = s.cornerRadius;
			d[o + 11] = s.feather;
			d[o + 12] = s.falloff;
			d[o + 13] = 0;
			d[o + 14] = 0;
			d[o + 15] = 0;
		}
	}

	/** Rasterize `shapes` into the bound-to FBO, clearing it to transparent first.
	 * `opacity` (0..1) scales the whole layer's geometry. */
	draw(shapes: Shape[], fbo: WebGLFramebuffer, w: number, h: number, opacity: number): void {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.viewport(0, 0, w, h);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		if (shapes.length === 0 || opacity <= 0) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			return;
		}

		this.pack(shapes);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
		gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.subarray(0, shapes.length * FLOATS_PER_INSTANCE), gl.DYNAMIC_DRAW);

		gl.useProgram(this.program);
		gl.bindVertexArray(this.vao);
		if (this.locResolution) gl.uniform2f(this.locResolution, w, h);
		if (this.locOpacity) gl.uniform1f(this.locOpacity, opacity);

		gl.enable(gl.BLEND);
		// Premultiplied "over": src is already premultiplied in the fragment shader.
		gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, shapes.length);
		gl.disable(gl.BLEND);

		gl.bindVertexArray(null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	dispose(): void {
		const gl = this.gl;
		gl.deleteBuffer(this.cornerBuf);
		gl.deleteBuffer(this.instanceBuf);
		gl.deleteVertexArray(this.vao);
		gl.deleteProgram(this.program);
	}
}
