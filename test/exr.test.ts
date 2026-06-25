// Unit test for the minimal OpenEXR writer (src/util/exr.ts). Run with:
//   node --experimental-strip-types test/exr.test.ts
// Encodes a small half-float RGBA image and parses the bytes back, asserting the
// header (magic / version / compression / data window / channel list) and that
// every half sample round-trips through the A,B,G,R channel layout. (The GL
// bottom-up -> top-down flip lives in the renderer, not the encoder, so the
// encoder is a straight top-down passthrough here.)

import { encodeHalfRGBA } from "../src/util/exr.ts";

let passed = 0;
function ok(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}

// 3x2 image, every sample a distinct half bit-pattern so any layout/order error shows.
const W = 3, H = 2;
const src = new Uint16Array(W * H * 4);
for (let i = 0; i < src.length; i++) src[i] = (i * 37 + 11) & 0xffff;

const buf = encodeHalfRGBA(W, H, src);
const dv = new DataView(buf.buffer);

// magic (20000630) + version (2, no flags)
eq(buf[0], 0x76, "magic 0"); eq(buf[1], 0x2f, "magic 1"); eq(buf[2], 0x31, "magic 2"); eq(buf[3], 0x01, "magic 3");
eq(buf[4], 2, "version number 2");
eq(buf[5] | buf[6] | buf[7], 0, "version flags 0");

// ---- header attributes ----
let o = 8;
const readStr = (): string => {
	let s = "";
	while (buf[o] !== 0) s += String.fromCharCode(buf[o++]);
	o++; // skip null terminator
	return s;
};
const attrs: Record<string, { type: string; start: number; size: number }> = {};
for (;;) {
	const name = readStr();
	if (name === "") break; // single null byte terminates the header
	const type = readStr();
	const size = dv.getInt32(o, true); o += 4;
	attrs[name] = { type, start: o, size };
	o += size;
}

ok("channels" in attrs, "has channels attr");
ok("compression" in attrs, "has compression attr");
ok("dataWindow" in attrs, "has dataWindow attr");
ok("displayWindow" in attrs, "has displayWindow attr");
ok("lineOrder" in attrs, "has lineOrder attr");
eq(buf[attrs.compression.start], 0, "compression = NO_COMPRESSION");
eq(buf[attrs.lineOrder.start], 0, "lineOrder = INCREASING_Y");

// dataWindow: xMin, yMin, xMax, yMax
{
	const s = attrs.dataWindow.start;
	eq(dv.getInt32(s, true), 0, "dataWindow xMin");
	eq(dv.getInt32(s + 4, true), 0, "dataWindow yMin");
	eq(dv.getInt32(s + 8, true), W - 1, "dataWindow xMax");
	eq(dv.getInt32(s + 12, true), H - 1, "dataWindow yMax");
}

// channel list: alphabetical A,B,G,R, all HALF, sampling 1/1
const channels: string[] = [];
{
	let p = attrs.channels.start;
	const end = attrs.channels.start + attrs.channels.size;
	while (p < end && buf[p] !== 0) {
		let name = "";
		while (buf[p] !== 0) name += String.fromCharCode(buf[p++]);
		p++; // null
		eq(dv.getInt32(p, true), 1, `channel ${name} pixelType HALF`); p += 4;
		p += 4; // pLinear + 3 reserved
		eq(dv.getInt32(p, true), 1, `channel ${name} xSampling`); p += 4;
		eq(dv.getInt32(p, true), 1, `channel ${name} ySampling`); p += 4;
		channels.push(name);
	}
}
eq(channels.join(","), "A,B,G,R", "channels alphabetical A,B,G,R");

// ---- offset table + scanlines ----
const offTable = o; // header loop left o at the first byte after the header
const offsets: number[] = [];
for (let y = 0; y < H; y++) offsets.push(Number(dv.getBigUint64(offTable + y * 8, true)));
eq(offsets.length, H, "one offset per scanline");

// Reconstruct RGBA from the EXR scanlines and compare to the source.
const recon = new Uint16Array(W * H * 4);
const chanToRgba: Record<string, number> = { A: 3, B: 2, G: 1, R: 0 };
for (let y = 0; y < H; y++) {
	let p = offsets[y];
	eq(dv.getInt32(p, true), y, `scanline ${y} y-coord`); p += 4;
	eq(dv.getInt32(p, true), W * 4 * 2, `scanline ${y} dataSize`); p += 4;
	for (const ch of channels) {
		const ci = chanToRgba[ch];
		for (let x = 0; x < W; x++) {
			recon[(y * W + x) * 4 + ci] = dv.getUint16(p, true); p += 2;
		}
	}
}

let allMatch = true;
for (let i = 0; i < src.length; i++) if (src[i] !== recon[i]) allMatch = false;
ok(allMatch, "every half sample round-trips through channel layout + orientation");

// Dimension guards.
let threw = false;
try { encodeHalfRGBA(2, 2, new Uint16Array(3)); } catch { threw = true; }
ok(threw, "wrong data length throws");

console.log(`ok - ${passed} assertions passed`);
