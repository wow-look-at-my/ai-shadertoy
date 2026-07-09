// Minimal OpenEXR writer: single-part, scanline, NO_COMPRESSION, HALF channels.
// Just enough to export an HDR (rgba16f) render losslessly; the result opens in
// Blender, Photoshop, oiiotool, and OpenEXR's own tools. File layout reference:
// https://openexr.com/en/latest/OpenEXRFileLayout.html
//
// Input is half-float RGBA — the exact bits GL hands back from readPixels on an
// RGBA16F target (GL HALF_FLOAT == IEEE 754 binary16 == EXR HALF, so no
// conversion is needed) — laid out top-down, row-major, 4 samples/pixel R,G,B,A.

const HALF = 1; // chlist pixel type: 0 = UINT, 1 = HALF, 2 = FLOAT

export function encodeHalfRGBA(width: number, height: number, rgba: Uint16Array): Uint8Array {
	if (width <= 0 || height <= 0) throw new Error("exr: bad dimensions");
	if (rgba.length !== width * height * 4) throw new Error("exr: expected width*height*4 half-floats");

	// ---- header (small; assembled into a byte list) ----
	const H: number[] = [];
	const str = (s: string) => {
		for (let i = 0; i < s.length; i++) H.push(s.charCodeAt(i) & 0xff);
		H.push(0);
	};
	const u8 = (v: number) => H.push(v & 0xff);
	const i32 = (v: number) => H.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
	const f32 = (v: number) => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setFloat32(0, v, true);
		H.push(b[0], b[1], b[2], b[3]);
	};
	const attr = (name: string, type: string, size: number, val: () => void) => {
		str(name);
		str(type);
		i32(size);
		val();
	};

	// Channels MUST be listed alphabetically: A, B, G, R.
	const chans = ["A", "B", "G", "R"];
	const chlistSize = chans.reduce((n, c) => n + c.length + 1 + 16, 0) + 1; // each: name\0 + 16, then a null terminator
	attr("channels", "chlist", chlistSize, () => {
		for (const c of chans) {
			str(c);
			i32(HALF);
			u8(0); u8(0); u8(0); u8(0); // pLinear + 3 reserved bytes
			i32(1); // xSampling
			i32(1); // ySampling
		}
		u8(0); // end of channel list
	});
	attr("compression", "compression", 1, () => u8(0)); // NO_COMPRESSION
	attr("dataWindow", "box2i", 16, () => { i32(0); i32(0); i32(width - 1); i32(height - 1); });
	attr("displayWindow", "box2i", 16, () => { i32(0); i32(0); i32(width - 1); i32(height - 1); });
	attr("lineOrder", "lineOrder", 1, () => u8(0)); // INCREASING_Y
	attr("pixelAspectRatio", "float", 4, () => f32(1));
	attr("screenWindowCenter", "v2f", 8, () => { f32(0); f32(0); });
	attr("screenWindowWidth", "float", 4, () => f32(1));
	H.push(0); // end of header

	// ---- file layout ----
	const dataSize = width * 4 * 2; // 4 HALF channels * 2 bytes * width
	const offTableStart = 8 + H.length; // after magic(4) + version(4) + header
	const firstChunk = offTableStart + height * 8; // after the per-scanline offset table
	const total = firstChunk + height * (8 + dataSize);

	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	let o = 0;

	// magic (20000630) + version: 2, single-part scanline, no flags
	out[o++] = 0x76; out[o++] = 0x2f; out[o++] = 0x31; out[o++] = 0x01;
	out[o++] = 2; out[o++] = 0; out[o++] = 0; out[o++] = 0;
	out.set(H, o);
	o += H.length;

	// offset table: one chunk per scanline, increasing y
	for (let y = 0; y < height; y++) {
		const off = firstChunk + y * (8 + dataSize);
		dv.setUint32(o, off >>> 0, true);
		dv.setUint32(o + 4, Math.floor(off / 0x100000000), true);
		o += 8;
	}

	// scanlines: y, dataSize, then channels A,B,G,R, each `width` halfs
	for (let y = 0; y < height; y++) {
		dv.setInt32(o, y, true); o += 4;
		dv.setInt32(o, dataSize, true); o += 4;
		const row = y * width * 4;
		for (const ci of [3, 2, 1, 0]) { // A,B,G,R -> source offsets 3,2,1,0
			for (let x = 0; x < width; x++) {
				dv.setUint16(o, rgba[row + x * 4 + ci], true);
				o += 2;
			}
		}
	}
	return out;
}
