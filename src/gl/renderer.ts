// WebGL2 multi-pass, multi-LAYER renderer. The document is a back-to-front stack
// of layers; each layer is its own graph of passes (each pass renders to its own
// ping-ponged offscreen texture, so passes can sample one another and their own
// previous frame for feedback). Layers render bottom-up: each layer sees the
// composite of every layer below it as its "under" input and its own rasterized
// geometry (real instanced quad/circle meshes) as its "geometry" input, and its
// output pass produces the new composite. The topmost visible layer's composite
// is blitted to the screen. Also does screenshot capture (for the user and as
// visual feedback to the AI).

import type { Channel, Layer, Pass, PassFormat, Shape, Uniform } from "../state/types.ts";
import { assembleFragment, glslType } from "./wrapper.ts";
import { builtinPixels } from "./textures.ts";
import { DynamicTexture } from "./dynamictexture.ts";
import { GeometryBatch } from "./geometry.ts";

export interface RendererShaders {
	fullscreenVert: string;
	present: string;
	shapeVert: string;
	shapeFrag: string;
}

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
	layers: number;
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
	tex: WebGLTexture | null; // owned texture for builtin/image; null for pass/none/dynamic/under/geometry/mask
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
	channels: ChannelSlot[];
	a: Target | null;
	b: Target | null;
	cur: 0 | 1; // which of a/b holds the just-written ("current") frame
	width: number;
	height: number;
	layer: RenderLayer; // back-reference so under/geometry channels resolve
}

interface RenderLayer {
	id: string;
	visible: boolean;
	opacity: number;
	passes: Map<string, RenderPass>;
	order: RenderPass[]; // topological order within the layer
	outputPassId: string;
	shapes: Shape[];
	geom: Target | null; // single (not ping-ponged) premultiplied geometry texture
	geomDirty: boolean;
	underTex: WebGLTexture; // set each frame: composite of the layers below
	mask: RenderLayer | null; // optional mask layer (rendered standalone)
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
	private transparentTex: WebGLTexture;
	private opaqueTex: WebGLTexture;
	private geometry: GeometryBatch;

	private layers: RenderLayer[] = []; // bottom -> top draw order
	private layersById = new Map<string, RenderLayer>();
	private allPasses = new Map<string, RenderPass>(); // every pass, keyed by global id
	private uniforms: Uniform[] = [];

	private floatColorBuffer = false;
	private floatLinear = false;
	private maxTextureUnits = 16;
	// The presented composite's output target, captured each renderFrame (the
	// topmost visible layer's output pass) so HDR/EXR export can read it back.
	private lastFinal: { fbo: WebGLFramebuffer; width: number; height: number; format: PassFormat } | null = null;

	private renderScale = 1;
	// "Square pixels": report a square iResolution (the short side) to user shaders
	// so the common `uv = fragCoord/iResolution.xy` has equal x/y scale (circles
	// stay round). The framebuffer is unchanged, so the image still fills the canvas.
	private squarePixels = false;
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

	constructor(canvas: HTMLCanvasElement, shaders: RendererShaders) {
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
		this.vert = this.compileShader(gl.VERTEX_SHADER, shaders.fullscreenVert) ?? this.fail("vertex shader failed");
		this.presentProgram = this.linkProgram(this.compileShader(gl.FRAGMENT_SHADER, shaders.present) ?? this.fail("present shader failed")) ?? this.fail("present link failed");
		this.fallbackTex = this.makeSolidTexture(0, 0, 0, 255);
		this.transparentTex = this.makeSolidTexture(0, 0, 0, 0);
		this.opaqueTex = this.makeSolidTexture(255, 255, 255, 255);
		this.geometry = new GeometryBatch(gl, shaders.shapeVert, shaders.shapeFrag);

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

	// ---- document (layers + passes) -----------------------------------------

	/** (Re)build the whole document: reconcile layers and their passes, compile
	 * every pass, (re)allocate targets + per-layer geometry, and compute each
	 * layer's topological render order. Returns a per-pass compile result keyed by
	 * pass id (across all layers). */
	setDocument(layers: Layer[], uniforms: Uniform[]): Map<string, CompileResult> {
		this.uniforms = uniforms;

		// Keep-sets cover the stack layers AND their masks (recursively).
		const keepPasses = new Set<string>();
		const keepLayers = new Set<string>();
		const walk = (l: Layer): void => {
			keepLayers.add(l.id);
			for (const p of l.passes) keepPasses.add(p.id);
			if (l.mask) walk(l.mask);
		};
		for (const l of layers) walk(l);

		// Drop passes / layers that no longer exist.
		for (const [id, p] of [...this.allPasses]) {
			if (!keepPasses.has(id)) {
				this.destroyPass(p);
				this.allPasses.delete(id);
			}
		}
		for (const [id, l] of [...this.layersById]) {
			if (!keepLayers.has(id)) {
				if (l.geom) this.freeTarget(l.geom);
				this.layersById.delete(id);
			}
		}

		const results = new Map<string, CompileResult>();
		this.layers = layers.map((spec) => this.reconcileLayer(spec, results));

		this.renderFrame();
		return results;
	}

	/** Reconcile one layer (and its mask, recursively): create/update its
	 * RenderLayer + RenderPasses, compile, (re)allocate geometry + mask targets,
	 * and compute the topological order. Returns the RenderLayer. */
	private reconcileLayer(spec: Layer, results: Map<string, CompileResult>): RenderLayer {
		let rl = this.layersById.get(spec.id);
		if (!rl) {
			rl = { id: spec.id, visible: spec.visible, opacity: spec.opacity, passes: new Map(), order: [], outputPassId: spec.outputPassId, shapes: spec.shapes, geom: null, geomDirty: true, underTex: this.transparentTex, mask: null };
			this.layersById.set(spec.id, rl);
		}
		rl.visible = spec.visible;
		rl.opacity = spec.opacity;
		rl.outputPassId = spec.outputPassId;
		rl.shapes = spec.shapes;
		rl.geomDirty = true;
		if (this.allocW > 0 && !rl.geom) rl.geom = this.allocTarget(this.allocW, this.allocH, "rgba8");

		rl.passes = new Map();
		for (const pSpec of spec.passes) {
			const count = Math.min(pSpec.channels.length, this.maxTextureUnits);
			let rp = this.allPasses.get(pSpec.id);
			if (!rp) {
				rp = { id: pSpec.id, name: pSpec.name, format: pSpec.format, program: null, locCache: new Map(), channels: Array.from({ length: count }, newSlot), a: null, b: null, cur: 0, width: 0, height: 0, layer: rl };
				this.allPasses.set(pSpec.id, rp);
				if (this.allocW > 0) this.allocPassTargets(rp, this.allocW, this.allocH);
			}
			rp.name = pSpec.name;
			rp.layer = rl;
			this.reconcileSlots(rp, count);
			if (rp.format !== pSpec.format) {
				rp.format = pSpec.format;
				if (this.allocW > 0) this.allocPassTargets(rp, this.allocW, this.allocH);
			}
			results.set(pSpec.id, this.compilePass(rp, pSpec.source));
			rl.passes.set(pSpec.id, rp);
		}
		rl.order = topoOrder(spec.passes).map((id) => rl!.passes.get(id)!).filter(Boolean);

		// Mask layer (rendered standalone). Its output is available to this layer's
		// graph as kind:"mask"; the graph decides how to apply it.
		rl.mask = spec.mask ? this.reconcileLayer(spec.mask, results) : null;
		return rl;
	}

	setUniformValues(uniforms: Uniform[]): void {
		this.uniforms = uniforms; // values only; declarations unchanged since setDocument
		this.renderFrame();
	}

	/** Recompile a single pass's source (no graph/order change). */
	setPassSource(passId: string, source: string): CompileResult {
		const p = this.allPasses.get(passId);
		if (!p) return { ok: false, log: `no such pass: ${passId}` };
		const res = this.compilePass(p, source);
		this.renderFrame();
		return res;
	}

	/** Replace a layer's geometry and re-rasterize it (no recompile). */
	setLayerShapes(layerId: string, shapes: Shape[]): void {
		const l = this.layersById.get(layerId);
		if (!l) return;
		l.shapes = shapes;
		l.geomDirty = true;
		this.renderFrame();
	}

	/** Update a layer's visibility / opacity (opacity re-rasterizes its geometry). */
	setLayerProps(layerId: string, props: { visible?: boolean; opacity?: number }): void {
		const l = this.layersById.get(layerId);
		if (!l) return;
		if (props.visible !== undefined) l.visible = props.visible;
		if (props.opacity !== undefined && props.opacity !== l.opacity) {
			l.opacity = props.opacity;
			l.geomDirty = true;
		}
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
		gl.clearColor(0, 0, 0, 0);
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

	private makeSolidTexture(r: number, g: number, b: number, a: number): WebGLTexture {
		const gl = this.gl;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		return tex;
	}

	// ---- channel inputs -----------------------------------------------------

	private slot(passId: string, index: number): ChannelSlot | null {
		const p = this.allPasses.get(passId);
		if (!p || index < 0 || index >= p.channels.length) return null;
		return p.channels[index];
	}

	connectBuiltinInput(passId: string, index: number, kind: NonNullable<Channel["builtin"]>, filter: Channel["filter"], wrap: Channel["wrap"]): void {
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

	connectImageInput(passId: string, index: number, image: TexImageSource, w: number, h: number, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		this.uploadSlot(s, w, h, image);
		s.kind = "image";
		s.passId = undefined;
		s.filter = filter;
		s.wrap = wrap;
		this.renderFrame();
	}

	connectPassInput(passId: string, index: number, sourcePassId: string, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		this.freeSlot(s);
		s.kind = "pass";
		s.passId = sourcePassId;
		s.filter = filter;
		s.wrap = wrap;
		this.renderFrame();
	}

	/** Bind a layer-ambient input: "under" (the composite of the layers below),
	 * "geometry" (this layer's rasterized shapes), or "mask" (this layer's mask
	 * output). These resolve dynamically per frame, so no texture is uploaded. */
	connectAmbientInput(passId: string, index: number, kind: "under" | "geometry" | "mask", filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const s = this.slot(passId, index);
		if (!s) return;
		this.freeSlot(s);
		s.kind = kind;
		s.passId = undefined;
		s.filter = filter;
		s.wrap = wrap;
		this.renderFrame();
	}

	/** Bind a video clip (data/object URL). `key` identifies the source so a
	 * re-apply with the same key keeps the playing clip (only updates filter/wrap). */
	connectVideoInput(passId: string, index: number, url: string, key: string, filter: Channel["filter"], wrap: Channel["wrap"]): void {
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
	connectWebcamInput(passId: string, index: number, stream: MediaStream, filter: Channel["filter"], wrap: Channel["wrap"]): void {
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
	setInputParams(passId: string, index: number, filter: Channel["filter"], wrap: Channel["wrap"]): void {
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

	disconnectInput(passId: string, index: number): void {
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
		for (const p of this.allPasses.values()) for (const s of p.channels) if (s.dyn) fn(s.dyn);
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
		for (const p of this.allPasses.values()) {
			for (const t of [p.a, p.b]) {
				if (!t) continue;
				gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
				gl.clearColor(0, 0, 0, 0);
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

	setSquarePixels(on: boolean): void {
		this.squarePixels = on;
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
		for (const p of this.allPasses.values()) this.allocPassTargets(p, w, h);
		// Geometry targets for every layer, including masks, depend on resolution.
		for (const l of this.layersById.values()) {
			if (l.geom) this.freeTarget(l.geom);
			l.geom = this.allocTarget(w, h, "rgba8");
			l.geomDirty = true;
		}
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

		gl.bindVertexArray(this.vao);
		const rendered = new Set<string>();
		let finalTex: WebGLTexture | null = null;
		let underTex = this.transparentTex;
		this.lastFinal = null;

		for (const layer of this.layers) {
			if (!layer.visible) continue;
			layer.underTex = underTex;
			this.rasterizeGeom(layer, W, H);
			if (layer.mask) {
				layer.mask.underTex = this.transparentTex;
				this.rasterizeGeom(layer.mask, W, H);
				this.renderLayerPasses(layer.mask, t, H, rendered);
			}
			this.renderLayerPasses(layer, t, H, rendered);
			const out = this.layerOutput(layer);
			if (!out) continue; // layer produced nothing this frame
			finalTex = out.tex;
			this.lastFinal = { fbo: out.fbo, width: out.width, height: out.height, format: out.format };
			underTex = out.tex; // becomes the next layer's "under"
		}

		// Present the topmost visible layer's composite (or clear if nothing drew).
		if (finalTex) {
			this.present(W, H, finalTex);
		} else {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, W, H);
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}

		// Advance ping-pong for every pass that drew this frame.
		for (const p of this.allPasses.values()) if (rendered.has(p.id)) p.cur = (p.cur === 0 ? 1 : 0) as 0 | 1;

		if (fromLoop && this.onStats) this.onStats(this.stats());
	}

	/** Re-rasterize a layer's geometry into its geom target if dirty. */
	private rasterizeGeom(layer: RenderLayer, W: number, H: number): void {
		if (layer.geomDirty && layer.geom) {
			this.geometry.draw(layer.shapes, layer.geom.fbo, W, H, layer.opacity);
			layer.geomDirty = false;
			this.gl.bindVertexArray(this.vao); // geometry batch rebinds VAO/program
		}
	}

	/** Draw a layer's passes in topological order. */
	private renderLayerPasses(layer: RenderLayer, t: number, H: number, rendered: Set<string>): void {
		for (const p of layer.order) {
			if (!p.program || !p.a) continue;
			this.drawPass(p, t, H, rendered);
			rendered.add(p.id);
		}
	}

	/** The current-frame output Target of a layer (its output pass's texture + fbo
	 * + dims + format), or null when the layer produced nothing this frame. */
	private layerOutput(layer: RenderLayer): { tex: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number; format: PassFormat } | null {
		const out = layer.passes.get(layer.outputPassId) ?? layer.order[layer.order.length - 1] ?? null;
		if (!out || !out.a) return null;
		const t = this.curr(out);
		return { tex: t.tex, fbo: t.fbo, width: out.width, height: out.height, format: out.format };
	}

	/** The current-frame texture of a layer's output pass (or null if it has none). */
	private layerOutputTex(layer: RenderLayer): WebGLTexture | null {
		return this.layerOutput(layer)?.tex ?? null;
	}

	private drawPass(p: RenderPass, t: number, H: number, rendered: Set<string>): void {
		const gl = this.gl;
		gl.useProgram(p.program);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.curr(p).fbo);
		gl.viewport(0, 0, p.width, p.height);

		// Square-pixels mode feeds a square iResolution (the short side) so the usual
		// uv = fragCoord/iResolution.xy is isotropic (circles stay round). To keep the
		// content CENTERED (not anchored bottom-left) when it tiles past the short
		// side, we also shift the fragCoord the shader sees by ai_fragOffset =
		// (target - side)/2, so uv = 0.5 lands at the true canvas centre. iMouse is
		// shifted by the same offset so it stays consistent with fragCoord.
		const resSide = this.squarePixels ? Math.min(p.width, p.height) : 0;
		const offX = resSide > 0 ? (p.width - resSide) / 2 : 0;
		const offY = resSide > 0 ? (p.height - resSide) / 2 : 0;
		if (resSide > 0) this.setFloat3(p, "iResolution", resSide, resSide, 1);
		else this.setFloat3(p, "iResolution", p.width, p.height, 1);
		this.setFloat2(p, "ai_fragOffset", offX, offY);
		this.setFloat1(p, "iTime", t);
		this.setFloat1(p, "iTimeDelta", 1 / 60);
		this.setFloat1(p, "iFrameRate", this.fps || 60);
		this.setInt1(p, "iFrame", this.frame);
		const mx = this.mouse.x - offX;
		const my = H - this.mouse.y - offY;
		const dx = this.mouse.downX - offX;
		const dy = H - this.mouse.downY - offY;
		this.setFloat4(p, "iMouse", mx, my, (this.mouse.pressed ? 1 : -1) * dx, (this.mouse.everDown ? 1 : -1) * dy);
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
		for (const p of this.allPasses.values()) {
			for (const s of p.channels) {
				if (!s.dyn) continue;
				s.dyn.update();
				s.width = s.dyn.width;
				s.height = s.dyn.height;
			}
		}
	}

	/** Resolve a channel's bound texture. "under"/"geometry" read the pass's layer
	 * (the composite below / this layer's rasterized shapes). Pass references read
	 * the source's current-frame output if it was already rendered this frame (a
	 * forward edge), otherwise its previous frame (feedback / self-reference). */
	private resolveChannel(slot: ChannelSlot, self: RenderPass, rendered: Set<string>): { tex: WebGLTexture; width: number; height: number; float: boolean } {
		if (slot.kind === "under") {
			return { tex: self.layer.underTex, width: self.width || this.allocW, height: self.height || this.allocH, float: false };
		} else if (slot.kind === "geometry") {
			const g = self.layer.geom;
			return { tex: g ? g.tex : this.transparentTex, width: self.width || this.allocW, height: self.height || this.allocH, float: false };
		} else if (slot.kind === "mask") {
			const mask = self.layer.mask ? this.layerOutputTex(self.layer.mask) : null;
			return { tex: mask ?? this.opaqueTex, width: self.width || this.allocW, height: self.height || this.allocH, float: false };
		} else if (slot.kind === "pass" && slot.passId) {
			const src = this.allPasses.get(slot.passId);
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

	private present(W: number, H: number, tex: WebGLTexture): void {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, W, H);
		gl.useProgram(this.presentProgram);
		gl.bindVertexArray(this.vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, tex);
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
	private setFloat2(p: RenderPass, n: string, x: number, y: number): void {
		const l = this.loc(p, n);
		if (l) this.gl.uniform2f(l, x, y);
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
			passes: this.allPasses.size,
			layers: this.layers.length,
		};
	}

	// ---- screenshot ---------------------------------------------------------

	screenshot(maxDim = 512, mime = "image/webp", quality = 0.85): Screenshot {
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
		// toDataURL silently falls back to PNG on browsers that can't encode the
		// requested type, so derive mediaType from the bytes actually produced —
		// a mediaType/payload mismatch would make the vision API reject the image.
		const mediaType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? mime;

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
			mediaType,
			width: w,
			height: h,
			avgColor: avg,
			nonBlack: avg[0] + avg[1] + avg[2] > 6,
		};
	}

	/** True when the presented composite is backed by a real HDR (rgba16f) target,
	 * so an EXR export would carry genuine float data (a "rgba16f" pass silently
	 * falls back to rgba8 when the GPU lacks EXT_color_buffer_float). */
	hasFloatOutput(): boolean {
		this.renderFrame();
		return !!this.lastFinal && this.lastFinal.format === "rgba16f" && this.floatColorBuffer;
	}

	/** Read the presented HDR composite back as half-float RGBA (top-down, the
	 * exact rgba16f bits), for a lossless EXR export. Null when the output is not
	 * a float target — gate on hasFloatOutput() first. */
	captureFloat(): { width: number; height: number; data: Uint16Array } | null {
		this.renderFrame();
		const f = this.lastFinal;
		if (!f || f.format !== "rgba16f" || !this.floatColorBuffer) return null;
		const gl = this.gl;
		const { fbo, width: w, height: h } = f;
		const raw = new Uint16Array(w * h * 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.readPixels(0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, raw);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		// GL reads bottom-up; flip to top-down so the EXR matches the on-screen image.
		const data = new Uint16Array(w * h * 4);
		const row = w * 4;
		for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
		return { width: w, height: h, data };
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
		for (const p of this.allPasses.values()) this.destroyPass(p);
		for (const l of this.layersById.values()) {
			if (l.geom) this.freeTarget(l.geom);
		}
		this.geometry.dispose();
		this.allPasses.clear();
		this.layersById.clear();
		this.layers = [];
	}
}

/** Topological render order over a layer's pass dependency graph (a pass depends
 * on every OTHER pass it samples via kind:"pass"). under/geometry/mask channels are
 * layer-ambient, not edges, so they're ignored here. Cycles (feedback) are broken
 * by the input order; those back-edges read the previous frame at draw time.
 * Exported for unit testing. */
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
