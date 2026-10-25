// A WebGL2 texture backed by a live HTMLVideoElement -- either an uploaded video clip or the webcam.

import { stopStream } from "../util/media.ts";

export class DynamicTexture {
	readonly texture: WebGLTexture;
	width = 0;
	height = 0;

	/** Fires when a new frame is decoded while the clip is not playing (first frame ready, or a seek landed), so a paused renderer can redraw once. */
	onFrame: (() => void) | null = null;

	private gl: WebGL2RenderingContext;
	private video: HTMLVideoElement;
	private stream: MediaStream | null;
	private uploaded = false;
	private lastTime = -1;
	private notify = (): void => {
		if (this.video.paused) this.onFrame?.();
	};

	private constructor(gl: WebGL2RenderingContext, video: HTMLVideoElement, stream: MediaStream | null) {
		this.gl = gl;
		this.video = video;
		this.stream = stream;
		video.muted = true;
		video.playsInline = true;
		// Playback follows the renderer's explicit play()/pause().
		video.addEventListener("loadeddata", this.notify);
		video.addEventListener("seeked", this.notify);
		video.addEventListener("error", () => {
			const e = video.error;
			console.error(`video input failed to load: ${e ? `${e.message || "media error"} (code ${e.code})` : "unknown error"}`);
		});
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		// 1x1 black placeholder so the sampler is complete before the first frame.
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
		this.texture = tex;
	}

	/** A looping video clip from a data/object URL. */
	static fromUrl(gl: WebGL2RenderingContext, url: string): DynamicTexture {
		const v = document.createElement("video");
		v.loop = true;
		v.crossOrigin = "anonymous";
		v.src = url;
		return new DynamicTexture(gl, v, null);
	}

	/** The live webcam (or any MediaStream the caller acquired). */
	static fromStream(gl: WebGL2RenderingContext, stream: MediaStream): DynamicTexture {
		const v = document.createElement("video");
		v.srcObject = stream;
		return new DynamicTexture(gl, v, stream);
	}

	/** Whether this is a live stream (webcam) -- live sources cannot be seeked. */
	get isLive(): boolean {
		return this.stream !== null;
	}

	play(): void {
		void this.video.play().catch(() => {});
	}
	pause(): void {
		this.video.pause();
	}
	reset(): void {
		if (this.stream) return; // live: no timeline to rewind
		try {
			this.video.currentTime = 0;
		} catch {
		}
	}

	/** Upload the current frame if one is ready. No-op (keeps the last frame) until
	 * the video has decoded data and known dimensions, or while a paused clip
	 * still shows the frame already uploaded. */
	update(): void {
		const gl = this.gl;
		const v = this.video;
		if (v.readyState < 2 /* HAVE_CURRENT_DATA */ || v.videoWidth === 0) return;
		if (this.uploaded && !this.stream && v.currentTime === this.lastTime) return;
		this.lastTime = v.currentTime;
		const w = v.videoWidth;
		const h = v.videoHeight;
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		if (!this.uploaded || this.width !== w || this.height !== h) {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
			this.uploaded = true;
			this.width = w;
			this.height = h;
		} else {
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
		}
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	}

	/** Stop playback, release the stream (camera light off), and free the texture. */
	dispose(): void {
		this.video.pause();
		this.video.srcObject = null;
		this.video.removeAttribute("src");
		this.video.load();
		stopStream(this.stream);
		this.gl.deleteTexture(this.texture);
	}
}
