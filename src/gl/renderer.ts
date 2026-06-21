// WebGL2 renderer for Shadertoy-style fragment shaders. Owns the canvas, the
// animation clock, built-in + custom uniforms, the four iChannel textures, and
// screenshot capture (used both for the user and as visual feedback to the AI).

import type { Channel, Uniform } from "../state/types.ts";
import { VERTEX_SHADER, assembleFragment, glslType } from "./wrapper.ts";
import { builtinPixels } from "./textures.ts";

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
}

interface ChannelState {
	tex: WebGLTexture | null;
	width: number;
	height: number;
	/** Dynamic sources (video file / webcam) re-upload their current frame each
	 * render tick; `video` is the backing element and `stream` (webcam) is stopped
	 * on teardown. `uploaded` tracks whether the first full texImage2D has run so
	 * subsequent frames can use the cheaper texSubImage2D. */
	video: HTMLVideoElement | null;
	stream: MediaStream | null;
	dynamic: boolean;
	uploaded: boolean;
}

function emptyChannel(): ChannelState {
	return { tex: null, width: 0, height: 0, video: null, stream: null, dynamic: false, uploaded: false };
}

export class Renderer {
	readonly canvas: HTMLCanvasElement;
	private gl: WebGL2RenderingContext;
	private vao: WebGLVertexArrayObject;
	private vert: WebGLShader;
	private program: WebGLProgram | null = null;
	private uniforms: Uniform[] = [];
	private locCache = new Map<string, WebGLUniformLocation | null>();

	private renderScale = 1;
	private startTime = performance.now();
	private pausedAt = 0;
	private paused = false;
	private frame = 0;
	private lastFrameTime = performance.now();
	private fps = 0;
	private rafId = 0;

	private mouse = { x: 0, y: 0, downX: 0, downY: 0, pressed: false, everDown: false };
	private channels: ChannelState[] = [emptyChannel(), emptyChannel(), emptyChannel(), emptyChannel()];

	onStats: ((s: RenderStats) => void) | null = null;
	onContextLost: (() => void) | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		const gl = canvas.getContext("webgl2", {
			preserveDrawingBuffer: true,
			antialias: false,
			premultipliedAlpha: false,
			alpha: false,
		});
		if (!gl) throw new Error("WebGL2 is not available in this browser.");
		this.gl = gl;
		this.vao = gl.createVertexArray()!;
		this.vert = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER) ?? this.fail("vertex shader failed");

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

	// ---- shader compilation -------------------------------------------------

	private compileShader(type: number, source: string): WebGLShader | null {
		const gl = this.gl;
		const sh = gl.createShader(type)!;
		gl.shaderSource(sh, source);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
			return null;
		}
		return sh;
	}

	/** Compile + link a new fragment program. On failure the previous working
	 * program is kept so the canvas keeps showing the last good render. */
	setShader(userSource: string, uniforms: Uniform[]): CompileResult {
		const gl = this.gl;
		const { source } = assembleFragment(userSource, uniforms);
		const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
		gl.shaderSource(frag, source);
		gl.compileShader(frag);
		if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
			const raw = gl.getShaderInfoLog(frag) ?? "unknown compile error";
			gl.deleteShader(frag);
			return { ok: false, log: cleanLog(raw) };
		}

		const program = gl.createProgram()!;
		gl.attachShader(program, this.vert);
		gl.attachShader(program, frag);
		gl.linkProgram(program);
		gl.deleteShader(frag);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const raw = gl.getProgramInfoLog(program) ?? "unknown link error";
			gl.deleteProgram(program);
			return { ok: false, log: cleanLog(raw) };
		}

		if (this.program) gl.deleteProgram(this.program);
		this.program = program;
		this.uniforms = uniforms;
		this.locCache.clear();
		this.renderFrame();
		return { ok: true, log: "" };
	}

	setUniformValues(uniforms: Uniform[]): void {
		// values only; assumes declarations unchanged since setShader
		this.uniforms = uniforms;
		this.renderFrame();
	}

	private loc(name: string): WebGLUniformLocation | null {
		if (!this.program) return null;
		if (this.locCache.has(name)) return this.locCache.get(name) ?? null;
		const l = this.gl.getUniformLocation(this.program, name);
		this.locCache.set(name, l);
		return l;
	}

	// ---- textures -----------------------------------------------------------

	setChannelBuiltin(index: number, kind: Channel["builtin"], filter: Channel["filter"], wrap: Channel["wrap"]): void {
		if (!kind) return;
		const { width, height, pixels } = builtinPixels(kind);
		this.uploadChannel(index, width, height, pixels, filter, wrap);
	}

	setChannelImage(index: number, image: TexImageSource, w: number, h: number, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		this.uploadChannel(index, w, h, image, filter, wrap);
	}

	/** Bind a video clip (data/object URL). The element is created here so the
	 * renderer owns playback (kept in sync with the animation clock) and the
	 * per-frame texture upload. */
	setChannelVideo(index: number, url: string, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const v = document.createElement("video");
		v.loop = true;
		v.crossOrigin = "anonymous";
		v.src = url;
		this.attachVideo(index, v, null, filter, wrap);
	}

	/** Bind the live webcam (a MediaStream acquired by the caller). */
	setChannelWebcam(index: number, stream: MediaStream, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const v = document.createElement("video");
		v.srcObject = stream;
		this.attachVideo(index, v, stream, filter, wrap);
	}

	private attachVideo(index: number, video: HTMLVideoElement, stream: MediaStream | null, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const gl = this.gl;
		const ch = this.channels[index];
		this.stopDynamic(ch);
		video.muted = true;
		video.playsInline = true;
		video.autoplay = true;
		if (!ch.tex) ch.tex = gl.createTexture();
		// 1x1 black placeholder so the sampler is complete before the first frame.
		gl.bindTexture(gl.TEXTURE_2D, ch.tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
		this.setTexParams(ch, filter, wrap);
		ch.video = video;
		ch.stream = stream;
		ch.dynamic = true;
		ch.uploaded = false;
		ch.width = 0;
		ch.height = 0;
		if (!this.paused) void video.play().catch(() => {});
		this.renderFrame();
	}

	/** Cheap filter/wrap update for an already-bound channel (no re-upload, so a
	 * playing video keeps going and the webcam is not re-acquired). */
	setChannelParams(index: number, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const ch = this.channels[index];
		if (!ch.tex) return;
		this.setTexParams(ch, filter, wrap);
		this.renderFrame();
	}

	clearChannel(index: number): void {
		const ch = this.channels[index];
		this.stopDynamic(ch);
		if (ch.tex) this.gl.deleteTexture(ch.tex);
		this.channels[index] = emptyChannel();
	}

	/** Pause + detach any dynamic source on a channel and stop a webcam stream. */
	private stopDynamic(ch: ChannelState): void {
		if (ch.video) {
			ch.video.pause();
			ch.video.srcObject = null;
			ch.video.removeAttribute("src");
			ch.video.load();
		}
		if (ch.stream) for (const t of ch.stream.getTracks()) t.stop();
		ch.video = null;
		ch.stream = null;
		ch.dynamic = false;
		ch.uploaded = false;
	}

	private setTexParams(ch: ChannelState, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, ch.tex);
		const f = filter === "nearest" ? gl.NEAREST : gl.LINEAR;
		const wr = wrap === "clamp" ? gl.CLAMP_TO_EDGE : wrap === "mirror" ? gl.MIRRORED_REPEAT : gl.REPEAT;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
	}

	private uploadChannel(index: number, w: number, h: number, data: Uint8Array | TexImageSource, filter: Channel["filter"], wrap: Channel["wrap"]): void {
		const gl = this.gl;
		const ch = this.channels[index];
		this.stopDynamic(ch);
		if (!ch.tex) ch.tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, ch.tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		if (data instanceof Uint8Array) {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		} else {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
		}
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		this.setTexParams(ch, filter, wrap);
		ch.width = w;
		ch.height = h;
		this.renderFrame();
	}

	/** Upload the current frame of a dynamic (video/webcam) channel. Allocates GPU
	 * storage on the first frame / a size change, then updates in place. */
	private updateVideoTexture(ch: ChannelState): void {
		const gl = this.gl;
		const v = ch.video;
		if (!v || v.readyState < 2 /* HAVE_CURRENT_DATA */ || v.videoWidth === 0) return;
		const w = v.videoWidth;
		const h = v.videoHeight;
		gl.bindTexture(gl.TEXTURE_2D, ch.tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		if (!ch.uploaded || ch.width !== w || ch.height !== h) {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
			ch.uploaded = true;
			ch.width = w;
			ch.height = h;
		} else {
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
		}
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	}

	// ---- playback -----------------------------------------------------------

	play(): void {
		if (!this.paused) return;
		this.paused = false;
		this.startTime += performance.now() - this.pausedAt;
		for (const ch of this.channels) if (ch.video) void ch.video.play().catch(() => {});
	}
	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.pausedAt = performance.now();
		for (const ch of this.channels) if (ch.video) ch.video.pause();
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
		// Rewind seekable clips (webcam streams have no timeline to reset).
		for (const ch of this.channels) {
			if (ch.video && !ch.stream) {
				try {
					ch.video.currentTime = 0;
				} catch {
					/* not seekable yet */
				}
			}
		}
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

	private loop = (): void => {
		this.rafId = requestAnimationFrame(this.loop);
		if (!this.paused) this.renderFrame(true);
	};

	renderFrame(fromLoop = false): void {
		const gl = this.gl;
		this.resize();
		const W = this.canvas.width;
		const H = this.canvas.height;
		gl.viewport(0, 0, W, H);

		if (!this.program) {
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			return;
		}

		const now = performance.now();
		if (fromLoop) {
			const dt = now - this.lastFrameTime;
			if (dt > 0) this.fps = this.fps * 0.9 + (1000 / dt) * 0.1;
			this.lastFrameTime = now;
			this.frame++;
		}
		const t = this.currentTime();

		gl.useProgram(this.program);
		gl.bindVertexArray(this.vao);

		this.setFloat3("iResolution", W, H, 1);
		this.setFloat1("iTime", t);
		this.setFloat1("iTimeDelta", 1 / 60);
		this.setFloat1("iFrameRate", this.fps || 60);
		this.setInt1("iFrame", this.frame);
		const my = H - this.mouse.y;
		this.setFloat4("iMouse", this.mouse.x, my, (this.mouse.pressed ? 1 : -1) * this.mouse.downX, (this.mouse.everDown ? 1 : -1) * (H - this.mouse.downY));
		const d = new Date();
		this.setFloat4("iDate", d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());

		const chRes: number[] = [];
		for (let i = 0; i < 4; i++) {
			const ch = this.channels[i];
			gl.activeTexture(gl.TEXTURE0 + i);
			if (ch.dynamic) this.updateVideoTexture(ch);
			gl.bindTexture(gl.TEXTURE_2D, ch.tex);
			const l = this.loc(`iChannel${i}`);
			if (l) gl.uniform1i(l, i);
			chRes.push(ch.width, ch.height, 1);
		}
		const lcr = this.loc("iChannelResolution[0]");
		if (lcr) gl.uniform3fv(lcr, chRes);

		for (const u of this.uniforms) {
			const l = this.loc(u.name);
			if (!l) continue;
			const v = u.value;
			const gt = glslType(u.type);
			if (gt === "float") gl.uniform1f(l, v[0] ?? 0);
			else if (gt === "vec2") gl.uniform2f(l, v[0] ?? 0, v[1] ?? 0);
			else if (gt === "vec3") gl.uniform3f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
			else if (gt === "vec4") gl.uniform4f(l, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
		}

		gl.drawArrays(gl.TRIANGLES, 0, 3);

		if (fromLoop && this.onStats) {
			this.onStats(this.stats());
		}
	}

	private setFloat1(n: string, x: number): void {
		const l = this.loc(n);
		if (l) this.gl.uniform1f(l, x);
	}
	private setInt1(n: string, x: number): void {
		const l = this.loc(n);
		if (l) this.gl.uniform1i(l, x);
	}
	private setFloat3(n: string, x: number, y: number, z: number): void {
		const l = this.loc(n);
		if (l) this.gl.uniform3f(l, x, y, z);
	}
	private setFloat4(n: string, x: number, y: number, z: number, w: number): void {
		const l = this.loc(n);
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
		// Release any video elements / webcam streams so the camera light goes off.
		for (let i = 0; i < this.channels.length; i++) this.clearChannel(i);
	}
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
