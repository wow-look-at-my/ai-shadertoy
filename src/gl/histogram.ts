// Histogram binning over RGBA pixel data.

export type HistogramChannel = "luma" | "saturation" | "value" | "r" | "g" | "b" | "rgb";

export const HISTOGRAM_MODES: HistogramChannel[] = ["luma", "saturation", "value", "r", "g", "b", "rgb"];

export type ChannelName = "luma" | "saturation" | "value" | "r" | "g" | "b";

export interface HistogramSeries {
	channel: ChannelName;
	bins: number[];
	mean: number;
	peak: number;
}

export interface Histogram {
	mode: HistogramChannel;
	pixels: number;
	series: HistogramSeries[];
}

const BINS = 256;

function emptyBins(): number[] {
	return new Array<number>(BINS).fill(0);
}

function series(channel: ChannelName, bins: number[], samples: number): HistogramSeries {
	let total = 0;
	let peak = 0;
	for (let i = 0; i < bins.length; i++) {
		total += i * bins[i];
		if (bins[i] >= bins[peak]) peak = i;
	}
	return { channel, bins, mean: samples ? total / samples : 0, peak };
}

function luma(r: number, g: number, b: number): number {
	return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

function saturation(r: number, g: number, b: number): number {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	return max === 0 ? 0 : Math.round(((max - min) / max) * 255);
}

/** Bin an RGBA buffer. Fully transparent pixels are skipped. */
export function computeHistogram(pixels: Uint8Array, width: number, height: number, mode: HistogramChannel): Histogram {
	const bins: Record<ChannelName, number[]> = {
		luma: emptyBins(),
		saturation: emptyBins(),
		value: emptyBins(),
		r: emptyBins(),
		g: emptyBins(),
		b: emptyBins(),
	};
	let samples = 0;
	const count = Math.min(width * height, Math.floor(pixels.length / 4));
	for (let i = 0; i < count; i++) {
		const o = i * 4;
		if (pixels[o + 3] === 0) continue;
		const r = pixels[o];
		const g = pixels[o + 1];
		const b = pixels[o + 2];
		samples++;
		if (mode === "rgb") {
			bins.r[r]++;
			bins.g[g]++;
			bins.b[b]++;
		} else if (mode === "r" || mode === "g" || mode === "b") {
			bins[mode][pixels[o + (mode === "r" ? 0 : mode === "g" ? 1 : 2)]]++;
		} else if (mode === "saturation") {
			bins.saturation[saturation(r, g, b)]++;
		} else if (mode === "value") {
			bins.value[Math.max(r, g, b)]++;
		} else {
			bins.luma[luma(r, g, b)]++;
		}
	}
	const channels: ChannelName[] = mode === "rgb" ? ["r", "g", "b"] : [mode];
	return { mode, pixels: samples, series: channels.map((channel) => series(channel, bins[channel], samples)) };
}

/** A compact text form for the model: the mean, peak, and non-empty bins. */
export function formatHistogram(label: string, histogram: Histogram): string {
	const lines = histogram.series.map((s) => {
		const populated = s.bins.map((n, i) => (n ? `${i}:${n}` : "")).filter(Boolean).join(" ");
		return `${s.channel} mean ${s.mean.toFixed(1)} peak ${s.peak} (${s.bins[s.peak]})\n${populated || "(empty)"}`;
	});
	return `${label} | ${histogram.mode} | ${histogram.pixels} px\n${lines.join("\n")}`;
}
