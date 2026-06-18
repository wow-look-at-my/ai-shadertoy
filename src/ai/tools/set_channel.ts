// set_channel -- bind a built-in procedural texture (or clear it) to iChannel0-3.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { BUILTIN_LABELS } from "../../gl/textures.ts";
import type { BuiltinTexture, TexFilter, TexWrap } from "../../state/types.ts";

registerTool({
	name: TOOL_NAMES.setChannel,
	def: {
		name: TOOL_NAMES.setChannel,
		description: "Bind a built-in procedural texture (or clear it) to an input channel iChannel0-3.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "integer", description: "Channel index 0-3." },
				kind: { type: "string", enum: ["none", "builtin"] },
				builtin: { type: "string", enum: ["rgbaNoise", "grayNoise", "blue", "checker", "gradient"], description: "Required when kind=builtin." },
				filter: { type: "string", enum: ["linear", "nearest"] },
				wrap: { type: "string", enum: ["repeat", "clamp", "mirror"] },
			},
			required: ["index", "kind"],
		},
	},
	execute: (ctx, input) => {
		const index = Number(input["index"]);
		if (!(index >= 0 && index <= 3)) return { content: [text("index must be 0-3.")], isError: true };
		const filter = (input["filter"] as TexFilter) ?? "linear";
		const wrap = (input["wrap"] as TexWrap) ?? "repeat";
		if (String(input["kind"] ?? "none") === "none") {
			ctx.setChannel(index, { kind: "none", assetId: undefined, builtin: undefined });
			return { content: [text(`iChannel${index} cleared.`)] };
		}
		const builtin = String(input["builtin"] ?? "") as BuiltinTexture;
		if (!(builtin in BUILTIN_LABELS)) return { content: [text(`builtin must be one of: ${Object.keys(BUILTIN_LABELS).join(", ")}`)], isError: true };
		ctx.setChannel(index, { kind: "builtin", builtin, filter, wrap, assetId: undefined });
		return { content: [text(`iChannel${index} = builtin ${builtin} (${BUILTIN_LABELS[builtin]}).`)] };
	},
});
