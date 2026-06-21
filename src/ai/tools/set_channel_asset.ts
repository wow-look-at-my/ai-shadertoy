// set_channel_asset -- bind a user-uploaded or generated image asset to a channel.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { TexFilter, TexWrap } from "../../state/types.ts";

registerTool({
	name: TOOL_NAMES.setChannelAsset,
	def: {
		name: TOOL_NAMES.setChannelAsset,
		description: "Bind a user-uploaded or generated image OR video asset (by name, see list_assets) to an input channel iChannel0-3. Videos animate: their current frame is sampled each frame.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "integer", description: "Channel index 0-3." },
				asset: { type: "string", description: "Asset name from list_assets." },
				filter: { type: "string", enum: ["linear", "nearest"] },
				wrap: { type: "string", enum: ["repeat", "clamp", "mirror"] },
			},
			required: ["index", "asset"],
		},
	},
	execute: (ctx, input) => {
		const index = Number(input["index"]);
		if (!(index >= 0 && index <= 3)) return { content: [text("index must be 0-3.")], isError: true };
		const name = String(input["asset"] ?? "");
		const asset = ctx.assets.find((a) => a.name === name) ?? ctx.assets.find((a) => a.id === name);
		if (!asset) return { content: [text(`No asset named "${name}". Use list_assets.`)], isError: true };
		const isVideo = asset.kind === "video";
		ctx.setChannel(index, { kind: isVideo ? "video" : "image", assetId: asset.id, builtin: undefined, filter: (input["filter"] as TexFilter) ?? "linear", wrap: (input["wrap"] as TexWrap) ?? "repeat" });
		return { content: [text(`iChannel${index} = ${isVideo ? "video" : "image"} "${asset.name}" (${asset.width}x${asset.height}).${isVideo ? " It animates: sampling iChannel" + index + " returns the current video frame." : ""}`)] };
	},
});
