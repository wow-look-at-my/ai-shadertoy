// Media helpers for channel inputs: reading uploaded files, probing image/video
// dimensions, and acquiring the webcam. Keeps the store and UI free of the
// FileReader / <video> / getUserMedia plumbing.

/** Uploaded videos are stored inline (data URL) like images, so keep them small;
 * short low-resolution loops are the intended use. */
export const MAX_VIDEO_BYTES = 32 * 1024 * 1024;

// Code-point ranges dropped from asset names: C0/C1 control characters plus
// zero-width and bidirectional format marks (ZWSP..RLM, the bidi embeddings,
// word joiner, BOM). These are invisible and unreproducible by the model.
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x00, 0x1f],
	[0x7f, 0x9f],
	[0x200b, 0x200f],
	[0x202a, 0x202e],
	[0x2060, 0x2060],
	[0xfeff, 0xfeff],
];

/** Clean an uploaded asset's display name so it can be referenced by name.
 * Filenames -- macOS screenshots especially -- carry characters that look like a
 * plain space but aren't (U+202F narrow no-break space), plus zero-width and
 * bidi format marks. The model only ever sees/types the plain-looking name, so
 * if we stored the exotic original an exact-name lookup could never match. Fold
 * every run of whitespace (incl. U+202F / U+00A0) to a single ASCII space, drop
 * control and zero-width/format characters, and trim. Pure + DOM-free. */
export function sanitizeAssetName(name: string): string {
	let out = "";
	for (const ch of name) {
		const cp = ch.codePointAt(0) ?? 0;
		if (STRIP_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
		out += /\s/.test(ch) ? " " : ch;
	}
	return out.replace(/\s+/g, " ").trim();
}

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
