// Histogram overlay: the viewport or any pass buffer, by channel.

import { el } from "../util/dom.ts";
import { icon } from "../util/icons.ts";
import { computeHistogram, HISTOGRAM_MODES, type Histogram, type HistogramChannel } from "../gl/histogram.ts";
import type { Layer } from "../state/types.ts";
import type { Store } from "../state/store.ts";

export interface HistogramModal {
	root: HTMLElement;
	open: () => void;
}

interface Source {
	value: string;
	label: string;
}

const COLORS: Record<string, string> = {
	r: "#ff7b72",
	g: "#56d364",
	b: "#79a8ff",
	luma: "#e6edf3",
	saturation: "#ffb757",
	value: "#9aa4b2",
};

function collectSources(layers: Layer[], out: { value: string; label: string }[]): void {
	for (const layer of layers) {
		for (const pass of layer.passes) out.push({ value: pass.id, label: `${layer.name} / ${pass.name}` });
		if (layer.mask) collectSources([layer.mask], out);
	}
}

function drawHistogram(canvas: HTMLCanvasElement, histogram: Histogram): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const width = canvas.width;
	const height = canvas.height;
	const pad = 10;
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#141925";
	ctx.fillRect(0, 0, width, height);
	ctx.strokeStyle = "rgba(255,255,255,0.08)";
	for (let i = 1; i < 4; i++) {
		const x = pad + ((width - pad * 2) * i) / 4;
		ctx.beginPath();
		ctx.moveTo(x, pad);
		ctx.lineTo(x, height - pad);
		ctx.stroke();
	}
	const max = Math.max(1, ...histogram.series.flatMap((s) => s.bins));
	ctx.globalCompositeOperation = histogram.mode === "rgb" ? "lighter" : "source-over";
	const bar = (width - pad * 2) / 256;
	for (const series of histogram.series) {
		ctx.fillStyle = COLORS[series.channel] ?? "#e8edf4";
		for (let i = 0; i < 256; i++) {
			const bars = Math.sqrt(series.bins[i] / max) * (height - pad * 2);
			ctx.fillRect(pad + i * bar, height - pad - bars, Math.max(1, bar), bars);
		}
	}
	ctx.globalCompositeOperation = "source-over";
}

export function createHistogram(store: Store): HistogramModal {
	const source = el("select", {});
	const channel = el("select", {}, ...HISTOGRAM_MODES.map((mode) => el("option", { value: mode }, mode)));
	const canvas = el("canvas", { class: "histogram-canvas", attrs: { width: "512", height: "220" } });
	const meta = el("div", { class: "hint histogram-meta" });

	const redraw = (): void => {
		const read = source.value ? store.renderer.readPass(source.value) : store.renderer.readViewport();
		if (!read) {
			const ctx = canvas.getContext("2d");
			ctx?.clearRect(0, 0, canvas.width, canvas.height);
			meta.textContent = "Nothing rendered for this source.";
			return;
		}
		const histogram = computeHistogram(read.data, read.width, read.height, channel.value as HistogramChannel);
		meta.textContent = `${read.width}x${read.height} · ${histogram.pixels} px counted`;
		drawHistogram(canvas, histogram);
	};

	const refreshSources = (): void => {
		const options: Source[] = [{ value: "", label: "Viewport" }];
		collectSources(store.project.layers, options);
		const current = source.value;
		source.replaceChildren(...options.map((option) => el("option", { value: option.value }, option.label)));
		source.value = options.some((option) => option.value === current) ? current : "";
	};

	const overlay = el(
		"div",
		{ class: "modal-overlay" },
		el(
			"div",
			{ class: "modal" },
			el("div", { class: "modal-head" }, el("h2", {}, "Histogram"), el("button", { class: "btn icon", title: "Close", on: { click: () => close() } }, icon("close"))),
			el(
				"div",
				{ class: "modal-body" },
				el(
					"div",
					{ class: "row2" },
					el("label", { class: "field" }, el("span", { class: "field-label" }, "Source"), source),
					el("label", { class: "field" }, el("span", { class: "field-label" }, "Channel"), channel),
				),
				canvas,
				meta,
			),
		),
	);
	overlay.hidden = true;
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) close();
	});
	overlay.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
		}
	});
	source.addEventListener("change", redraw);
	channel.addEventListener("change", redraw);

	function close(): void {
		overlay.hidden = true;
	}
	function open(): void {
		refreshSources();
		overlay.hidden = false;
		redraw();
		source.focus();
	}
	return { root: overlay, open };
}
