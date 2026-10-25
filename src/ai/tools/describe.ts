// Shared read-only formatters for the `read` tool: render a channel binding, a pass line.

import type { Channel, ImageAsset, Layer, Pass } from "../../state/types.ts";

/** Human-readable description of one channel binding. */
export function describeChannel(c: Channel, assets: ImageAsset[], passes: Pass[]): string {
	if (c.kind === "none") return "empty";
	if (c.kind === "under") return "under (layers below)";
	if (c.kind === "geometry") return "geometry (this layer's shapes)";
	if (c.kind === "mask") return "mask (this layer's mask output)";
	if (c.kind === "builtin") return `builtin:${c.builtin}`;
	if (c.kind === "pass") return `pass:${passes.find((p) => p.id === c.passId)?.name ?? c.passId}`;
	if (c.kind === "webcam") return "webcam";
	const a = assets.find((x) => x.id === c.assetId);
	return `${c.kind === "video" ? "video" : "image"}:${a?.name ?? c.assetId}`;
}

/** One line per pass: name, output marker, format, line count, and input wiring. */
export function passLine(pass: Pass, layer: Layer, assets: ImageAsset[]): string {
	const ins = pass.channels
		.map((c, i) => (c.kind === "none" ? null : `iChannel${i}=${describeChannel(c, assets, layer.passes)}`))
		.filter(Boolean)
		.join(", ");
	const tag = pass.id === layer.outputPassId ? " (OUTPUT -> layer composite)" : "";
	return `- ${pass.name}${tag} [${pass.format}, ${pass.source.split("\n").length} lines]${ins ? `\n    inputs: ${ins}` : "\n    inputs: (none)"}`;
}

/** A layer's whole render graph as text (every pass + its wiring). */
export function graphSummary(layer: Layer, assets: ImageAsset[]): string {
	return layer.passes.map((p) => passLine(p, layer, assets)).join("\n");
}
