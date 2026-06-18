// Procedural built-in textures. These give the AI usable iChannel inputs
// (noise, checker, gradients) without the user having to upload an image.

import type { BuiltinTexture } from "../state/types.ts";

export interface PixelData {
	width: number;
	height: number;
	pixels: Uint8Array; // RGBA
}

// Deterministic PRNG so a given builtin is byte-stable across reloads.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function builtinPixels(kind: BuiltinTexture, size = 256): PixelData {
	const pixels = new Uint8Array(size * size * 4);
	const rnd = mulberry32(0x9e3779b9 ^ kind.length);
	const set = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
		const i = (y * size + x) * 4;
		pixels[i] = r;
		pixels[i + 1] = g;
		pixels[i + 2] = b;
		pixels[i + 3] = a;
	};

	switch (kind) {
		case "rgbaNoise":
			for (let i = 0; i < pixels.length; i++) pixels[i] = (rnd() * 256) | 0;
			break;
		case "grayNoise":
			for (let y = 0; y < size; y++)
				for (let x = 0; x < size; x++) {
					const v = (rnd() * 256) | 0;
					set(x, y, v, v, v);
				}
			break;
		case "blue": {
			// cheap approximate blue noise: per-pixel value pushed toward the
			// local average so low frequencies are suppressed.
			const tmp = new Float32Array(size * size);
			for (let i = 0; i < tmp.length; i++) tmp[i] = rnd();
			for (let y = 0; y < size; y++)
				for (let x = 0; x < size; x++) {
					let avg = 0;
					for (let dy = -1; dy <= 1; dy++)
						for (let dx = -1; dx <= 1; dx++) {
							avg += tmp[((y + dy + size) % size) * size + ((x + dx + size) % size)];
						}
					avg /= 9;
					const v = Math.max(0, Math.min(255, ((tmp[y * size + x] - avg) * 2 + 0.5) * 255)) | 0;
					set(x, y, v, v, v);
				}
			break;
		}
		case "checker":
			for (let y = 0; y < size; y++)
				for (let x = 0; x < size; x++) {
					const v = ((x >> 4) ^ (y >> 4)) & 1 ? 235 : 25;
					set(x, y, v, v, v);
				}
			break;
		case "gradient":
			for (let y = 0; y < size; y++)
				for (let x = 0; x < size; x++) {
					set(x, y, (x / size) * 255, (y / size) * 255, ((1 - x / size) * 255) | 0);
				}
			break;
	}
	return { width: size, height: size, pixels };
}

export const BUILTIN_LABELS: Record<BuiltinTexture, string> = {
	rgbaNoise: "RGBA noise",
	grayNoise: "Gray noise",
	blue: "Blue noise",
	checker: "Checker",
	gradient: "Gradient",
};
