// Media helpers for channel inputs: reading uploaded files, probing image/video
// dimensions, and acquiring the webcam. Keeps the store and UI free of the
// FileReader / <video> / getUserMedia plumbing.

/** Uploaded videos are stored inline (data URL) like images, so keep them small;
 * short low-resolution loops are the intended use. */
export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;

export function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result as string);
		r.onerror = () => reject(new Error("read failed"));
		r.readAsDataURL(file);
	});
}

export function loadImageEl(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image decode failed"));
		img.src = src;
	});
}

/** Probe a video's intrinsic size without playing it (metadata only). */
export function loadVideoMeta(src: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const v = document.createElement("video");
		v.preload = "metadata";
		v.muted = true;
		v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight });
		v.onerror = () => reject(new Error("video decode failed"));
		v.src = src;
	});
}

/** Request the live webcam as a video-only stream (prompts for permission). */
export function requestWebcam(): Promise<MediaStream> {
	if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("getUserMedia unavailable"));
	return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
}

/** Stop every track of a stream (releases the camera). */
export function stopStream(stream: MediaStream | null | undefined): void {
	if (stream) for (const t of stream.getTracks()) t.stop();
}
