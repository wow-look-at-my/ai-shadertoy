// WebGL2 multi-pass renderer. Owns the canvas, the animation clock, built-in +
// custom uniforms, and a graph of render passes. Each pass renders to its own
// offscreen (ping-ponged) texture, so passes can sample one another's output
// AND their own previous frame (feedback). The designated output pass is blitted
// to the screen. Also does screenshot capture (used both for the user and as
// visual feedback to the AI).

import type { Channel, Pass, PassFormat, Uniform } from "../state/types.ts";
import { assembleFragment, glslType } from "./wrapper.ts";
import { builtinPixels } from "./textures.ts";
import { DynamicTexture } from "./dynamictexture.ts";

export interface CompileResult {
	ok: boolean;
	log: string; // combined, user-relative where possible
}

export interface Screenshot {
	dataUrl: string;
	mediaType: string;
	width: number;
	height: number;
	avgColor: [number, number, number];
	nonBlack: boolean;
}

export interface RenderStats {
	fps: number;
	frame: number;
	time: number;
	width: number;
	height: number;
	paused: boolean;
	passes: number;
}

interface Target {
	tex: WebGLTexture;
	fbo: WebGLFramebuffer;
}

interface ChannelSlot {
	kind: Channel["kind"];
	passId?: string;
	filter: Channel["filter"];
	wrap: Channel["wrap"];
	tex: WebGLTexture | null; // owned texture for builtin/image; null for pass/none/dynamic
	width: number;
	height: number;
	/** video/webcam slots: the live source (owns its own texture, updated per frame). */
	dyn: DynamicTexture | null;
	/** Identity of the dynamic source (asset id for video, "webcam") so re-applying
	 * the same binding doesn't reload the clip / re-acquire the camera. */
	dynKey?: string;
}

interface RenderPass {
	id: string;
	name: string;
	format: PassFormat;
	program: WebGLProgram | null;
	locCache: Map<string, WebGLUniformLocation | null>;
	channels: ChannelSlot[]; // length 4
	a: Target | null;
	b: Target | null;
	cur: 0 | 1; // which of a/b holds the just-written ("current") frame
	width: number;
	height: number;
}

function newSlot(): ChannelSlot {
	return { kind: "none", filter: "linear", wrap: "repeat", tex: null, width: 0, height: 0, dyn: null };
}

export class Renderer {
	readonly canvas: HTMLCanvasElement;
	private gl: WebGL2RenderingContext;
	private vao: WebGLVertexArrayObject;
	private vert: WebGLShader;
	private presentProgram: WebGLProgram;
	private fallbackTex: WebGLTexture;

	private passes = new Map<string, RenderPass>();
	private order: RenderPass[] = []; // topological render order
	private outputPassId = "";
	private uniforms: Uniform[] = [];

	private floatColorBuffer = false;
	private floatLinear = false;
	private maxTextureUnits = 16;

	private renderScale = 1;
	private startTime = performance.now();
	private pausedAt = 0;
	private paused = false;
	private frame = 0;
	private lastFrameTime = performance.now();
	private fps = 0;
	private rafId = 0;
	private allocW = 0;
	private allocH = 0;

	private mouse = { x: 0, y: 0, downX: 0, downY: 0, pressed: false, everDown: false };

	onStats: ((s: RenderStats) => void) | null = null;
	onContextLost: (() => void) | null = null;

	constructor(canvas: HTMLCanvasElement, vertSource: string, presentSource: string) {
		this.canvas = canvas;
		const gl = canvas.getContext("webgl2", {
			preserveDrawingBuffer: true,
			antialias: false,
			premultipliedAlpha: false,
			alpha: false,
		});
		if (!gl) throw new Error("WebGL2 is not available in this browser.");
		this.gl = gl;
		// Float render targets (HDR passes) + linear filtering of them, when available.
		this.floatColorBuffer = !!gl.getExtension("EXT_color_buffer_float");
		this.floatLinear = !!gl.getExtension("OES_texture_float_linear");
		// Max input samplers per pass (WebGL2 guarantees >= 16). The data model
		// also clamps to MAX_INPUTS; this is the hardware ceiling.
		this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;

		this.vao = gl.createVertexArray()!;
		this.vert = this.compileShader(gl.VERTEX_SHADER, vertSource) ?? this.fail("vertex shader failed");
		this.presentProgram = this.linkProgram(this.compileShader(gl.FRAGMENT_SHADER, presentSource) ?? this.fail("present shader failed")) ?? this.fail("present link failed");
		this.fallbackTex = this.makeFallbackTexture();

		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointermove", this.onPointerMove);
		window.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("webglcontextlost", (e) => {
			e.preventDefault();
			this.onContextLost?.();
		});

		this.loop();
	}

	private fail(msg: string): never {
		throw new Error(msg);
	}

	supportsFloat(): boolean {
		return this.floatColorBuffer;
	}

	/** Hardware ceiling on input samplers per pass (>= 16 on WebGL2). */
	maxInputs(): number {
		return this.maxTextureUnits;
	}

	// ---- shader compilation -------------------------------------------------

	private compileShader(type: number, source: string): WebGLShader | null {
		const gl = this.gl;
		const sh = gl.createShader(type)!;
		gl.shaderSource(sh, source);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
		return sh;
	}

	private linkProgram(frag: WebGLShader): WebGLProgram | null {
		const gl = this.gl;
		const program = gl.createProgram()!;
		gl.attachShader(program, this.vert);
		gl.attachShader(program, frag);
		gl.linkProgram(program);
		gl.deleteShader(frag);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			gl.deleteProgram(program);
			return null;
		}
		return program;
	}

	/** Compile a pass's fragment program. On failure the previous working program
	 * is kept so the pass keeps showing its last good render. */
	private compilePass(p: RenderPass, userSource: string): CompileResult {
		const gl = this.gl;
		const { source } = assembleFragment(userSource, this.uniforms, p.channels.length);
		const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
		gl.shaderSource(frag, source);
		gl.compileShader(frag);
		if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
			const raw = gl.getShaderInfoLog(frag) ?? "unknown compile error";
			gl.deleteShader(frag);
			return { ok: false, log: cleanLog(raw) };
		}
		const program = this.linkProgram(frag);
		if (!program) return { ok: false, log: "shader link error" };
		if (p.program) gl.deleteProgram(p.program);
		p.program = program;
		p.locCache.clear();
		return { ok: true, log: "" };
	}

	// ---- pass graph ---------------------------------------------------------

	/** (Re)build the render graph: compile every pass, (re)allocate targets, and
	 * compute the topological render order. Channel textures (builtin/image) are
	 * uploaded separately via setPassChannel*; pass/none channels need none.
	 * Returns a per-pass compile result keyed by pass id. */
	setPasses(passes: Pass[], outputPassId: string, uniforms: Uniform[]): Map<string, CompileResult> {
		this.uniforms = uniforms;
		this.outputPassId = outputPassId;

		// Drop passes that no longer exist.
		for (const [id, p] of [...this.passes]) {
			if (!passes.some((x) => x.id === id)) {
				this.destroyPass(p);
				this.passes.delete(id);
			}
		}

		const results = new Map<string, CompileResult>();
		for (const spec of passes) {
			const count = Math.min(spec.channels.length, this.maxTextureUnits);
			let rp = this.passes.get(spec.id);
			if (!rp) {
				rp = { id: spec.id, name: spec.name, format: spec.format, program: null, locCache: new Map(), channels: Array.from({ length: count }, newSlot), a: null, b: null, cur: 0, width: 0, height: 0 };
				this.passes.set(spec.id, rp);
				if (this.allocW > 0) this.allocPassTargets(rp, this.allocW, this.allocH);
			}
			rp.name = spec.name;
			this.reconcileSlots(rp, count);
			if (rp.format !== spec.format) {
				rp.format = spec.format;
				if (this.allocW > 0) this.allocPassTargets(rp, this.allocW, this.allocH);
			}
			results.set(spec.id, this.compilePass(rp, spec.source));
		}

		this.order = topoOrder(passes).map((id) => this.passes.get(id)!).filter(Boolean);
		this.renderFrame();
		return results;
	}

	setUniformValues(uniforms: Uniform[]): void {
		this.uniforms = uniforms; // values only; declarations unchanged since setPasses
		this.renderFrame();
	}

	/** Recompile a single pass's source (no graph/order change). */
	setPassSource(passId: string, source: string): CompileResult {
		const p = this.passes.get(passId);
		if (!p) return { ok: false, log: `no such pass: ${passId}` };
		const res = this.compilePass(p, source);
		this.renderFrame();
		return res;
	}

	/** Choose which pass is composited to the screen. */
	setOutputPass(passId: string): void {
		this.outputPassId = passId;
		this.renderFrame();
	}

	private destroyPass(p: RenderPass): void {
		const gl = this.gl;
		if (p.program) gl.deleteProgram(p.program);
		if (p.a) this.freeTarget(p.a);
		if (p.b) this.freeTarget(p.b);
		for (const c of p.channels) this.freeSlot(c);
	}

	/** Grow/shrink a pass's input slots to `count`, freeing dropped resources. */
	private reconcileSlots(p: RenderPass, count: number): void {
		while (p.channels.length < count) p.channels.push(newSlot());
		while (p.channels.length > count) this.freeSlot(p.channels.pop()!);
	}

	/** Release a slot's owned GPU/media resources (static texture and/or live
	 * video source). Leaves the slot object reusable. */
	private freeSlot(s: ChannelSlot): void {
		this.detachDynamic(s);
		if (s.tex) {
			this.gl.deleteTexture(s.tex);
			s.tex = null;
		}
	}

	/** Dispose any dynamic (video/webcam) source on a slot, stopping its stream. */
	private detachDynamic(s: ChannelSlot): void {
		if (s.dyn) {
			s.dyn.dispose();
			s.dyn = null;
		}
		s.dynKey = undefined;
	}

	private loc(p: RenderPass, name: string): WebGLUniformLocation | null {
		if (!p.program) return null;
		if (p.locCache.has(name)) return p.locCache.get(name) ?? null;
		const l = this.gl.getUniformLocation(p.program, name);
		p.locCache.set(name, l);
		return l;
	}

	// ---- render targets -----------------------------------------------------

	private allocTarget(w: number, h: number, format: PassFormat): Target {
		const gl = this.gl;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		const useFloat = format === "rgba16f" && this.floatColorBuffer;
		if (useFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		gl.clearColor(0, 0, 0, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return { tex, fbo };
	}

	private freeTarget(t: Target): void {
		this.gl.deleteTexture(t.tex);
		this.gl.deleteFramebuffer(t.fbo);
	}

	private allocPassTargets(p: RenderPass, w: number, h: number): void {
		if (p.a) this.freeTarget(p.a);
		if (p.b) this.freeTarget(p.b);
		p.a = this.allocTarget(w, h, p.format);
		p.b = this.allocTarget(w, h, p.format);
		p.cur = 0;
		p.width = w;
		p.height = h;
	}

	private curr(p: RenderPass): Target {
		return (p.cur === 0 ? p.a : p.b)!;
	}
	private prev(p: RenderPass): Target {
		return (p.cur === 0 ? p.b : p.a)!;
	}

	private makeFallbackTexture(): WebGLTexture {
		const gl = this.gl;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		return tex;
	}

	// ---- channel inputs -----------------------------------------------------

	private slot(passId: string, index: number): ChannelSlot | null {
		const p = this.passes.get(passId);
		if (!p || index < 0 || index >= p.channels.length) return null;
		return p.channels[index];
	}

	setPassChannelBuiltin(passId: string, index: number, kind: NonNullable<Channel["builtin"]>, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		const { width, height, pixels } = builtinPixels(kind);
		this.uploadSlot(s, width, height, pixels);
		s.kind = "builtin";
		s.passId = undefined;
		s.filter = filter;
		s.wrap = wrap;
		this.renderFrame();
	}

	setPassChannelImage(passId: string, index: number, image: TexImageSource, w: number, h: number, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		this.uploadSlot(s, w, h, image);
		s.kind = "image";
		s.passId = undefined;
		s.filter = filter;
		s.wrap = wrap;
		this.renderFrame();
	}

	setPassChannelPass(passId: string, index: number, sourcePassId: string, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		this.freeSlot(s);
		s.kind = "pass";
		s.passId = sourcePassId;
		s.filter = filter;
		s.wrap = wrap;
		this.renderFrame();
	}

	/** Bind a video clip (data/object URL). `key` identifies the source so a
	 * re-apply with the same key keeps the playing clip (only updates filter/wrap). */
	setPassChannelVideo(passId: string, index: number, url: string, key: string, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		if (s.kind === "video" && s.dyn && s.dynKey === key) {
			s.filter = filter;
			s.wrap = wrap;
			this.renderFrame();
			return;
		}
		this.freeSlot(s);
		s.dyn = DynamicTexture.fromUrl(this.gl, url);
		s.dynKey = key;
		s.kind = "video";
		s.passId = undefined;
		s.filter = filter;
		s.wrap = wrap;
		s.width = 0;
		s.height = 0;
		if (!this.paused) s.dyn.play();
		this.renderFrame();
	}

	/** Bind the live webcam (a MediaStream acquired by the caller). */
	setPassChannelWebcam(passId: string, index: number, stream: MediaStream, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		this.freeSlot(s);
		s.dyn = DynamicTexture.fromStream(this.gl, stream);
		s.dynKey = "webcam";
		s.kind = "webcam";
		s.passId = undefined;
		s.filter = filter;
		s.wrap = wrap;
		s.width = 0;
		s.height = 0;
		if (!this.paused) s.dyn.play();
		this.renderFrame();
	}

	/** Cheap filter/wrap update for an existing binding (applied per-draw, so no
	 * re-upload, no clip reload, no webcam re-acquire). */
	setPassChannelParams(passId: string, index: number, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		s.filter = filter;
		s.wrap = wrap;
		this.renderFrame();
	}

	/** Identity of a slot's live source (asset id for video, "webcam"), or null if
	 * it isn't currently a dynamic source. Lets the store skip a redundant reload. */
	dynamicKey(passId: string, index: number): string | null {
		const s = this.slot(passId, index);
		return s && s.dyn ? (s.dynKey ?? null) : null;
	}

	clearPassChannel(passId: string, index: number): void {
		const s = this.slot(passId, index);
		if (!s) return;
		this.freeSlot(s);
		s.kind = "none";
		s.passId = undefined;
		this.renderFrame();
	}

	private uploadSlot(s: ChannelSlot, w: number, h: number, data: Uint8Array | TexImageSource): void {
		const gl = this.gl;
		this.detachDynamic(s); // switching from a video/webcam source to a static one
		if (!s.tex) s.tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, s.tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		if (data instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		s.width = w;
		s.height = h;
	}

	// ---- playback -----------------------------------------------------------

	private forEachDynamic(fn: (d: DynamicTexture) => void): void {
		for (const p of this.passes.values()) for (const s of p.channels) if (s.dyn) fn(s.dyn);
	}

	play(): void {
		if (!this.paused) return;
		this.paused = false;
		this.startTime += performance.now() - this.pausedAt;
		this.forEachDynamic((d) => d.play());
	}
	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.pausedAt = performance.now();
		this.forEachDynamic((d) => d.pause());
	}
	togglePlay(): void {
		this.paused ? this.play() : this.pause();
	}
	isPaused(): boolean {
		return this.paused;
	}
	reset(): void {
		this.startTime = performance.now();
		this.pausedAt = this.startTime;
		this.frame = 0;
		// Clear pass targets so feedback trails restart cleanly.
		const gl = this.gl;
		for (const p of this.passes.values()) {
			for (const t of [p.a, p.b]) {
				if (!t) continue;
				gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
				gl.clearColor(0, 0, 0, 1);
				gl.clear(gl.COLOR_BUFFER_BIT);
			}
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.forEachDynamic((d) => d.reset());
		this.renderFrame();
	}

	private currentTime(): number {
		const now = this.paused ? this.pausedAt : performance.now();
		return (now - this.startTime) / 1000;
	}

	// ---- render -------------------------------------------------------------

	setRenderScale(scale: number): void {
		this.renderScale = scale;
		this.renderFrame();
	}

	private resize(): void {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const cssW = this.canvas.clientWidth || 640;
		const cssH = this.canvas.clientHeight || 360;
		const w = Math.max(1, Math.floor(cssW * dpr * this.renderScale));
		const h = Math.max(1, Math.floor(cssH * dpr * this.renderScale));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
	}

	private ensureTargets(): void {
		const w = this.canvas.width;
		const h = this.canvas.height;
		if (w === this.allocW && h === this.allocH) return;
		this.allocW = w;
		this.allocH = h;
		for (const p of this.passes.values()) this.allocPassTargets(p, w, h);
	}

	private loop = (): void => {
		this.rafId = requestAnimationFrame(this.loop);
		if (!this.paused) this.renderFrame(true);
	};

	renderFrame(fromLoop = false): void {
		const gl = this.gl;
		this.resize();
		this.ensureTargets();
		this.updateDynamicChannels();
		const W = this.canvas.width;
		const H = this.canvas.height;

		const now = performance.now();
		if (fromLoop) {
			const dt = now - this.lastFrameTime;
			if (dt > 0) this.fps = this.fps * 0.9 + (1000 / dt) * 0.1;
			this.lastFrameTime = now;
			this.frame++;
		}
		const t = this.currentTime();

		if (this.order.length === 0) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, W, H);
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			if (fromLoop && this.onStats) this.onStats(this.stats());
			return;
		}

		gl.bindVertexArray(this.vao);
		const rendered = new Set<string>();
		for (const p of this.order) {
			if (!p.program || !p.a) continue;
			this.drawPass(p, t, H, rendered);
			rendered.add(p.id);
		}

		// Present the chosen output pass to the screen.
		this.present(W, H);

		// Advance ping-pong for every pass that drew this frame.
		for (const p of this.order) if (rendered.has(p.id)) p.cur = (p.cur === 0 ? 1 : 0) as 0 | 1;

		if (fromLoop && this.onStats) this.onStats(this.stats());
	}

	private drawPass(p: RenderPass, t: number, H: number, rendered: Set<string>): void {
		const gl = this.gl;
		gl.useProgram(p.program);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.curr(p).fbo);
		gl.viewport(0, 0, p.width, p.height);

		this.setFloat3(p, "iResolution", p.width, p.height, 1);
		this.setFloat1(p, "iTime", t);
		this.setFloat1(p, "iTimeDelta", 1 / 60);
		this.setFloat1(p, "iFrameRate", this.fps || 60);
		this.setInt1(p, "iFrame", this.frame);
		const my = H - this.mouse.y;
		this.setFloat4(p, "iMouse", this.mouse.x, my, (this.mouse.pressed ? 1 : -1) * this.mouse.downX, (this.mouse.everDown ? 1 : -1) * (H - this.mouse.downY));
		const d = new Date();
		this.setFloat4(p, "iDate", d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());

		const chRes: number[] = [];
		for (let i = 0; i < p.channels.length; i++) {
			const slot = p.channels[i];
			const r = this.resolveChannel(slot, p, rendered);
			gl.activeTexture(gl.TEXTURE0 + i);
			gl.bindTexture(gl.TEXTURE_2D, r.tex);
			const wantLinear = slot.filter === "linear" && !(r.float && !this.floatLinear);
			const f = wantLinear ? gl.LINEAR : gl.NEAREST;
			const wr = slot.wrap === "clamp" ? gl.CLAMP_TO_EDGE : slot.wrap === "mirror" ? gl.MIRRORED_REPEAT : gl.REPEAT;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
			const l = this.loc(p, `iChannel${i}`);
			if (l) gl.uniform1i(l, i);
			chRes.push(r.width, r.height, 1);
		}
		const lcr = this.loc(p, "iChannelResolution[0]");
		if (lcr) gl.uniform3fv(lcr, chRes);

		for (const u of this.uniforms) {
			const l = this.loc(p, u.name);
			if (!l) continue;
			const v = u.value;
			const gt = glslType(u.type);
			if (gt === "float") gl.uniform1f(l, v[0] ?? 0);
			else if (gt === "vec2") gl.uniform2f(l, v[0] ?? 0, v[1] ?? 0);
			else if (gt === "vec3") gl.uniform3f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
			else if (gt === "vec4") gl.uniform4f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
		}

		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	/** Upload the current frame of every video/webcam channel once per render
	 * tick, before any pass samples them. */
	private updateDynamicChannels(): void {
		for (const p of this.passes.values()) {
			for (const s of p.channels) {
				if (!s.dyn) continue;
				s.dyn.update();
				s.width = s.dyn.width;
				s.height = s.dyn.height;
			}
		}
	}

	/** Resolve a channel's bound texture. Pass references read the source's
	 * current-frame output if it was already rendered this frame (a forward edge),
	 * otherwise its previous frame (feedback / self-reference). */
	private resolveChannel(slot: ChannelSlot, self: RenderPass, rendered: Set<string>): { tex: WebGLTexture; width: number; height: number; float: boolean } {
		if (slot.kind === "pass" && slot.passId) {
			const src = this.passes.get(slot.passId);
			if (src && src.a) {
				const useCurr = src.id !== self.id && rendered.has(src.id);
				const tgt = useCurr ? this.curr(src) : this.prev(src);
				return { tex: tgt.tex, width: src.width, height: src.height, float: src.format === "rgba16f" && this.floatColorBuffer };
			}
		} else if ((slot.kind === "video" || slot.kind === "webcam") && slot.dyn) {
			return { tex: slot.dyn.texture, width: slot.dyn.width, height: slot.dyn.height, float: false };
		} else if ((slot.kind === "builtin" || slot.kind === "image") && slot.tex) {
			return { tex: slot.tex, width: slot.width, height: slot.height, float: false };
		}
		return { tex: this.fallbackTex, width: 0, height: 0, float: false };
	}

	private present(W: number, H: number): void {
		const gl = this.gl;
		const out = this.passes.get(this.outputPassId) ?? this.order[this.order.length - 1];
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, W, H);
		gl.useProgram(this.presentProgram);
		gl.bindVertexArray(this.vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, out && out.a ? this.curr(out).tex : this.fallbackTex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		const lt = gl.getUniformLocation(this.presentProgram, "uTex");
		if (lt) gl.uniform1i(lt, 0);
		const lr = gl.getUniformLocation(this.presentProgram, "uResolution");
		if (lr) gl.uniform2f(lr, W, H);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	private setFloat1(p: RenderPass, n: string, x: number): void {
		const l = this.loc(p, n);
		if (l) this.gl.uniform1f(l, x);
	}
	private setInt1(p: RenderPass, n: string, x: number): void {
		const l = this.loc(p, n);
		if (l) this.gl.uniform1i(l, x);
	}
	private setFloat3(p: RenderPass, n: string, x: number, y: number, z: number): void {
		const l = this.loc(p, n);
		if (l) this.gl.uniform3f(l, x, y, z);
	}
	private setFloat4(p: RenderPass, n: string, x: number, y: number, z: number, w: number): void {
		const l = this.loc(p, n);
		if (l) this.gl.uniform4f(l, x, y, z, w);
	}

	stats(): RenderStats {
		return {
			fps: Math.round(this.fps),
			frame: this.frame,
			time: this.currentTime(),
			width: this.canvas.width,
			height: this.canvas.height,
			paused: this.paused,
			passes: this.passes.size,
		};
	}

	// ---- screenshot ---------------------------------------------------------

	screenshot(maxDim = 512, mime = "image/jpeg", quality = 0.85): Screenshot {
		this.renderFrame();
		const sw = this.canvas.width;
		const sh = this.canvas.height;
		const scale = Math.min(1, maxDim / Math.max(sw, sh));
		const w = Math.max(1, Math.round(sw * scale));
		const h = Math.max(1, Math.round(sh * scale));
		const off = document.createElement("canvas");
		off.width = w;
		off.height = h;
		const ctx = off.getContext("2d")!;
		ctx.drawImage(this.canvas, 0, 0, w, h);
		const dataUrl = off.toDataURL(mime, quality);

		const img = ctx.getImageData(0, 0, w, h).data;
		let r = 0,
			g = 0,
			b = 0;
		const n = w * h;
		for (let i = 0; i < img.length; i += 4) {
			r += img[i];
			g += img[i + 1];
			b += img[i + 2];
		}
		const avg: [number, number, number] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
		return {
			dataUrl,
			mediaType: mime,
			width: w,
			height: h,
			avgColor: avg,
			nonBlack: avg[0] + avg[1] + avg[2] > 6,
		};
	}

	// ---- input --------------------------------------------------------------

	private localPos(e: PointerEvent): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		const sx = this.canvas.width / rect.width;
		const sy = this.canvas.height / rect.height;
		return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
	}
	private onPointerDown = (e: PointerEvent): void => {
		const p = this.localPos(e);
		this.mouse.pressed = true;
		this.mouse.everDown = true;
		this.mouse.x = p.x;
		this.mouse.y = p.y;
		this.mouse.downX = p.x;
		this.mouse.downY = p.y;
	};
	private onPointerMove = (e: PointerEvent): void => {
		if (!this.mouse.pressed) return;
		const p = this.localPos(e);
		this.mouse.x = p.x;
		this.mouse.y = p.y;
	};
	private onPointerUp = (): void => {
		this.mouse.pressed = false;
	};

	destroy(): void {
		cancelAnimationFrame(this.rafId);
		window.removeEventListener("pointerup", this.onPointerUp);
		// Release video elements / webcam streams so the camera light goes off.
		for (const p of this.passes.values()) this.destroyPass(p);
		this.passes.clear();
	}
}

/** Topological render order over the pass dependency graph (a pass depends on
 * every pass it samples). Cycles (feedback) are broken by the input order; those
 * back-edges read the previous frame at draw time. Exported for unit testing. */
export function topoOrder(passes: Pass[]): string[] {
	const ids = new Set(passes.map((p) => p.id));
	const deps = new Map<string, Set<string>>();
	for (const p of passes) {
		const set = new Set<string>();
		for (const c of p.channels) {
			if (c.kind === "pass" && c.passId && c.passId !== p.id && ids.has(c.passId)) set.add(c.passId);
		}
		deps.set(p.id, set);
	}
	const order: string[] = [];
	const placed = new Set<string>();
	const remaining = passes.map((p) => p.id);
	while (remaining.length) {
		let progressed = false;
		for (let i = 0; i < remaining.length; i++) {
			const id = remaining[i];
			const d = deps.get(id)!;
			let ready = true;
			for (const dep of d) if (!placed.has(dep)) ready = false;
			if (ready) {
				order.push(id);
				placed.add(id);
				remaining.splice(i, 1);
				i--;
				progressed = true;
			}
		}
		if (!progressed) {
			// Cycle: emit the first remaining pass; its unmet deps become feedback edges.
			const id = remaining.shift()!;
			order.push(id);
			placed.add(id);
		}
	}
	return order;
}

/** Normalize a GLSL info log: trim trailing NULs and collapse blank lines. */
function cleanLog(raw: string): string {
	return raw
		.replace(/\0/g, "")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0)
		.join("\n");
}
