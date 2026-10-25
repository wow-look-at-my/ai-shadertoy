// Unit tests for histogram binning.

import { computeHistogram, formatHistogram } from "../src/gl/histogram.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}

const PIXELS = Uint8Array.from([
	255, 255, 255, 255,
	0, 0, 0, 255,
	255, 0, 0, 255,
	0, 0, 0, 0,
]);

{
	const h = computeHistogram(PIXELS, 4, 1, "luma");
	eq(h.pixels, 3, "transparent pixels are skipped");
	eq(h.series[0].bins[255], 1, "white lands in the top bin");
	eq(h.series[0].bins[0], 1, "black lands in the zero bin");
	eq(h.series[0].bins[54], 1, "red lands at its luma value");
	eq(h.series[0].mean, 103, "the mean is weighted by the bins");
	eq(h.series[0].peak, 255, "the peak is the tallest bin");
}

{
	const h = computeHistogram(PIXELS, 4, 1, "saturation");
	eq(h.series[0].bins[0], 2, "white and black have no saturation");
	eq(h.series[0].bins[255], 1, "red is fully saturated");
}

{
	const h = computeHistogram(PIXELS, 4, 1, "value");
	eq(h.series[0].bins[255], 2, "white and red have full value");
	eq(h.series[0].bins[0], 1, "black has zero value");
}

{
	const h = computeHistogram(PIXELS, 4, 1, "rgb");
	eq(h.series.length, 3, "rgb returns three series");
	eq(h.series[0].channel, "r", "the first series is red");
	eq(h.series[0].bins[255], 2, "red is full in white and red");
	eq(h.series[1].bins[0], 2, "green is zero in black and red");
	eq(h.series[2].bins[255], 1, "blue peaks on white");
}

{
	const h = computeHistogram(PIXELS, 4, 1, "luma");
	const text = formatHistogram("viewport", h);
	check(text.startsWith("viewport | luma | 3 px"), "the header names the source and samples");
	check(text.includes("luma mean 103.0"), "the summary carries the mean");
	check(text.includes("255:1"), "the populated bins are listed");
}

{
	const empty = computeHistogram(new Uint8Array(0), 0, 0, "luma");
	eq(empty.pixels, 0, "an empty buffer has no samples");
	eq(empty.series[0].mean, 0, "an empty mean is zero");
	check(formatHistogram("none", empty).includes("(empty)"), "an empty histogram says so");
}

console.log(`ok - ${passed} assertions passed`);
