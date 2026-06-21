// set_channel_asset -- bind a user-uploaded or generated image OR video asset to
// a channel. Videos animate: their current frame is sampled every frame.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { TexFilter, TexWrap } from "../../state/types.ts";

registerTool({
	name: TOOL_NAMES.setChannelAsset,
	def: {
		name: TOOL_NAMES.setChannelAsset,
		description: "Bind a user-uploaded or generated image OR video asset (by name, see list_assets) to an input channel (iChannel0, iChannel1, ...). Videos animate: their current frame is sampled each frame. A pass can have as many inputs as it needs; an index at/above the current count adds inputs. Targets the output pass by default; set `pass` to wire a different pass's input.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "integer", description: "Channel index (0-based)." },
				asset: { type: "string", description: "Asset name from list_assets." },
				pass: { type: "string", description: "Pass whose input you are wiring (default: the output pass)." },
				filter: { type: "string", enum: ["linear", "nearest"] },
				wrap: { type: "string", enum: ["repeat", "clamp", "mirror"] },
			},
			required: ["index", "asset"],
		},
	},
	execute: (ctx, input) => {
		const index = Number(input["index"]);
		if (!(index >= 0 && index < ctx.renderer.maxInputs())) return { content: [text(`index must be 0..${ctx.renderer.maxInputs() - 1}.`)], isError: true };
		const target = ctx.resolvePass(input["pass"] ? String(input["pass"]) : undefined);
		if (!target) return { content: [text(`No pass named "${String(input["pass"])}". Use list_passes.`)], isError: true };
		const name = String(input["asset"] ?? "");
		const asset = ctx.assets.find((a) => a.name === name) ?? ctx.assets.find((a) => a.id === name);
		if (!asset) return { content: [text(`No asset named "${name}". Use list_assets.`)], isError: true };
		const isVideo = asset.kind === "video";
		ctx.setPassChannel(target.id, index, { kind: isVideo ? "video" : "image", assetId: asset.id, builtin: undefined, passId: undefined, filter: (input["filter"] as TexFilter) ?? "linear", wrap: (input["wrap"] as TexWrap) ?? "repeat" });
		return { content: [text(`${target.name}.iChannel${index} = ${isVideo ? "video" : "image"} "${asset.name}" (${asset.width}x${asset.height}).${isVideo ? " It animates: sampling this channel returns the current video frame." : ""}`)] };
	},
});
