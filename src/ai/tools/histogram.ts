// histogram -- inspect the pixel distribution of the viewport or a pass buffer.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { computeHistogram, formatHistogram, HISTOGRAM_MODES, type HistogramChannel } from "../../gl/histogram.ts";
import type { PixelReadout } from "../../gl/renderer.ts";

function modeOf(raw: unknown): HistogramChannel {
	const value = String(raw ?? "luma");
	return HISTOGRAM_MODES.includes(value as HistogramChannel) ? (value as HistogramChannel) : "luma";
}

registerTool({
	name: TOOL_NAMES.histogram,
	def: {
		name: TOOL_NAMES.histogram,
		description: "Read the brightness or colour distribution of the viewport or a pass's output as a histogram. target is 'viewport' (default) or a pass name/id; channel is luma, saturation, value, r, g, b, or rgb (three series).",
		parameters: {
			type: "object",
			properties: {
				target: { type: "string", description: "'viewport' (default), or a pass name/id to read that buffer." },
				layer: { type: "string", description: "Layer holding the pass (name/id/index; defaults to the top layer)." },
				channel: { type: "string", enum: HISTOGRAM_MODES as unknown as string[], description: "Channel to bin." },
			},
		},
	},
	execute: (ctx, input) => {
		const mode = modeOf(input["channel"]);
		const target = String(input["target"] ?? "viewport");
		let read: PixelReadout | null;
		let label: string;
		if (target === "viewport") {
			read = ctx.renderer.readViewport();
			label = "viewport";
		} else {
			const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
			if (!layer) return { content: [text(`No layer "${String(input["layer"])}".`)], isError: true };
			const pass = ctx.resolvePass(layer, target);
			if (!pass) return { content: [text(`No pass "${target}" in layer "${layer.name}".`)], isError: true };
			read = ctx.renderer.readPass(pass.id);
			label = `${layer.name} / ${pass.name}`;
		}
		if (!read) return { content: [text(`No pixels to read for ${label}.`)], isError: true };
		return { content: [text(formatHistogram(label, computeHistogram(read.data, read.width, read.height, mode)))] };
	},
});
