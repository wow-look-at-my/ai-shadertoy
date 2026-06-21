// A WebGL2 texture backed by a live HTMLVideoElement -- either an uploaded video
// clip or the webcam. The current video frame is uploaded every render tick
// (texImage2D to allocate on the first frame / a size change, texSubImage2D
// after) so a channel sampling it animates on its own. Playback follows the
// renderer's clock (play/pause/reset). The renderer owns one of these per
// dynamic channel slot and disposes it to release the camera.

import { stopStream } from "../util/media.ts";

export class DynamicTexture {
	readonly texture: WebGLTexture;
	width = 0;
	height = 0;

	private gl: WebGL2RenderingContext;
	private video: HTMLVideoElement;
	private stream: MediaStream | null;
	private uploaded = false;

	private constructor(gl: WebGL2RenderingContext, video: HTMLVideoElement, stream: MediaStream | null) {
		this.gl = gl;
		this.video = video;
		this.stream = stream;
		video.muted = true;
		video.playsInline = true;
		video.autoplay = true;
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
			/* not seekable yet */
		}
	}

	/** Upload the current frame if one is ready. No-op (keeps the last frame) until
	 * the video has decoded data and known dimensions. */
	update(): void {
		const gl = this.gl;
		const v = this.video;
		if (v.readyState < 2 /* HAVE_CURRENT_DATA */ || v.videoWidth === 0) return;
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
