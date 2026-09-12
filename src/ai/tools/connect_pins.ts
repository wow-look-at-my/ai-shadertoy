// connect_pins -- wire a graph source pin into a pass input pin.

import { BUILTIN_LABELS } from "../../gl/textures.ts";
import type { BuiltinTexture, ImageAsset, TexFilter, TexWrap } from "../../state/types.ts";
import { sanitizeAssetName } from "../../util/media.ts";
import { TOOL_NAMES } from "./names.ts";
import { registerTool } from "./registry.ts";
import { text } from "./types.ts";

// Match an asset by id or by name. New uploads are sanitized at import time, but
// match through the same cleaner so assets stored before that fix -- carrying
// exotic spaces like U+202F (narrow no-break space) that the model can't
// reproduce from the plain-looking name it sees in list_assets -- still resolve.
export function normalizeName(s: string): string {
	return sanitizeAssetName(s).toLowerCase();
}

export function findAsset(assets: ImageAsset[], nameOrId: string): ImageAsset | undefined {
	const n = normalizeName(nameOrId);
	return assets.find((a) => a.id === nameOrId || normalizeName(a.name) === n);
}

registerTool({
	name: TOOL_NAMES.connectPins,
	def: {
		name: TOOL_NAMES.connectPins,
		description:
			"Connect a graph source pin to a pass input pin within a layer. `from` can be none, under, geometry, mask, webcam, pass:<pass name>, builtin:<texture>, or asset:<asset name>. `to` is the target pass name (defaults to the layer's output pass) and `input` is the target input index. `layer` (name/id/stack index) defaults to the top layer. This is the graph wiring tool; masks are just a mask source pin sampled by graph shader math.",
		parameters: {
			type: "object",
			properties: {
				from: { type: "string", description: "Source pin: none, under, geometry, mask, webcam, pass:<name>, builtin:<name>, or asset:<name>." },
				to: { type: "string", description: "Target pass name; defaults to the layer's output pass." },
				layer: { type: "string", description: "Layer ref (name/id/stack index; default: the top layer)." },
				input: { type: "integer", description: "Target input index, e.g. 0 for iChannel0." },
				filter: { type: "string", enum: ["linear", "nearest"] },
				wrap: { type: "string", enum: ["repeat", "clamp", "mirror"] },
			},
			required: ["from", "input"],
		},
	},
	execute: (ctx, input) => {
		const index = Number(input["input"]);
		if (!(index >= 0 && index < ctx.renderer.maxInputs())) return { content: [text(`input must be 0..${ctx.renderer.maxInputs() - 1}.`)], isError: true };
		const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true };
		const target = ctx.resolvePass(layer, input["to"] ? String(input["to"]) : undefined);
		if (!target) return { content: [text(`No target pass named "${String(input["to"])}" in layer "${layer.name}". read what:passes to list them.`)], isError: true };
		if (index >= target.channels.length) return { content: [text(`${target.name} has no iChannel${index} input. Reference iChannel${index} in its shader first, then connect_pins can wire it.`)], isError: true };

		const filterIn = input["filter"] ?? "linear";
		if (filterIn !== "linear" && filterIn !== "nearest") return { content: [text("filter must be linear or nearest.")], isError: true };
		const filter: TexFilter = filterIn;
		const wrapIn = input["wrap"] ?? "repeat";
		if (wrapIn !== "repeat" && wrapIn !== "clamp" && wrapIn !== "mirror") return { content: [text("wrap must be repeat, clamp, or mirror.")], isError: true };
		const wrap: TexWrap = wrapIn;
		const from = String(input["from"] ?? "").trim();

		if (from === "none") {
			ctx.connectPin(target.id, index, { kind: "none", assetId: undefined, builtin: undefined, passId: undefined });
			return { content: [text(`Disconnected ${target.name} input ${index}.`)] };
		}
		if (from === "under" || from === "geometry" || from === "mask") {
			ctx.connectPin(target.id, index, { kind: from, assetId: undefined, builtin: undefined, passId: undefined, filter, wrap });
			return { content: [text(`Connected ${from} -> ${target.name} input ${index}.`)] };
		}
		if (from === "webcam") {
			ctx.connectPin(target.id, index, { kind: "webcam", assetId: undefined, builtin: undefined, passId: undefined, filter, wrap });
			return { content: [text(`Connected webcam -> ${target.name} input ${index}.`)] };
		}
		if (from.startsWith("pass:")) {
			const srcName = from.slice(5).trim();
			const src = ctx.resolvePass(layer, srcName);
			if (!src) return { content: [text(`No source pass named "${srcName}" in layer "${layer.name}". read what:passes to list them.`)], isError: true };
			ctx.connectPin(target.id, index, { kind: "pass", passId: src.id, builtin: undefined, assetId: undefined, filter, wrap });
			const fb = src.id === target.id ? " (feedback: previous frame)" : "";
			return { content: [text(`Connected pass "${src.name}"${fb} -> ${target.name} input ${index}.`)] };
		}
		if (from.startsWith("builtin:")) {
			const builtin = from.slice(8).trim() as BuiltinTexture;
			if (!(builtin in BUILTIN_LABELS)) return { content: [text(`builtin must be one of: ${Object.keys(BUILTIN_LABELS).join(", ")}`)], isError: true };
			ctx.connectPin(target.id, index, { kind: "builtin", builtin, filter, wrap, assetId: undefined, passId: undefined });
			return { content: [text(`Connected builtin ${builtin} -> ${target.name} input ${index}.`)] };
		}
		if (from.startsWith("asset:")) {
			const assetName = from.slice(6).trim();
			const asset = findAsset(ctx.assets, assetName);
			if (!asset) return { content: [text(`No asset named "${assetName}". read what:assets to list them.`)], isError: true };
			const isVideo = asset.kind === "video";
			ctx.connectPin(target.id, index, { kind: isVideo ? "video" : "image", assetId: asset.id, builtin: undefined, passId: undefined, filter, wrap });
			return { content: [text(`Connected ${isVideo ? "video" : "image"} asset "${asset.name}" -> ${target.name} input ${index}.`)] };
		}
		return { content: [text("from must be: none, under, geometry, mask, webcam, pass:<name>, builtin:<name>, or asset:<name>.")], isError: true };
	},
});
