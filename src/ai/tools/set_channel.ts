// set_channel -- wire one of a pass's input channels (iChannel0-3): bind a
// built-in procedural texture, the OUTPUT of another pass (the graph edges), or
// clear it. Use set_channel_asset for image assets.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { BUILTIN_LABELS } from "../../gl/textures.ts";
import type { BuiltinTexture, TexFilter, TexWrap } from "../../state/types.ts";

registerTool({
	name: TOOL_NAMES.setChannel,
	def: {
		name: TOOL_NAMES.setChannel,
		description:
			"Wire one input channel (iChannel0-3) of a pass. kind=builtin binds a procedural texture; kind=pass feeds the OUTPUT texture of another pass into this channel (this is how you build the graph, e.g. a blur pass sampling the effect pass); kind=none clears it. Targets the output pass by default; set `pass` to wire a different pass's input. A channel may reference a pass's own previous frame for feedback. Use set_channel_asset for uploaded/generated images.",
		parameters: {
			type: "object",
			properties: {
				index: { type: "integer", description: "Channel index 0-3." },
				kind: { type: "string", enum: ["none", "builtin", "pass"] },
				builtin: { type: "string", enum: ["rgbaNoise", "grayNoise", "blue", "checker", "gradient"], description: "Required when kind=builtin." },
				source: { type: "string", description: "Source pass name whose output feeds this channel. Required when kind=pass (may be the same pass for feedback)." },
				pass: { type: "string", description: "Pass whose input you are wiring (default: the output pass)." },
				filter: { type: "string", enum: ["linear", "nearest"] },
				wrap: { type: "string", enum: ["repeat", "clamp", "mirror"] },
			},
			required: ["index", "kind"],
		},
	},
	execute: (ctx, input) => {
		const index = Number(input["index"]);
		if (!(index >= 0 && index <= 3)) return { content: [text("index must be 0-3.")], isError: true };
		const target = ctx.resolvePass(input["pass"] ? String(input["pass"]) : undefined);
		if (!target) return { content: [text(`No pass named "${String(input["pass"])}". Use list_passes.`)], isError: true };
		const filter = (input["filter"] as TexFilter) ?? "linear";
		const wrap = (input["wrap"] as TexWrap) ?? "repeat";
		const kind = String(input["kind"] ?? "none");

		if (kind === "none") {
			ctx.setPassChannel(target.id, index, { kind: "none", assetId: undefined, builtin: undefined, passId: undefined });
			return { content: [text(`${target.name}.iChannel${index} cleared.`)] };
		}
		if (kind === "pass") {
			const srcName = String(input["source"] ?? "");
			const src = ctx.resolvePass(srcName);
			if (!src) return { content: [text(`kind=pass needs a valid 'source' pass name. No pass named "${srcName}". Use list_passes.`)], isError: true };
			ctx.setPassChannel(target.id, index, { kind: "pass", passId: src.id, builtin: undefined, assetId: undefined, filter, wrap });
			const fb = src.id === target.id ? " (feedback: previous frame)" : "";
			return { content: [text(`${target.name}.iChannel${index} = pass "${src.name}"${fb}.`)] };
		}
		const builtin = String(input["builtin"] ?? "") as BuiltinTexture;
		if (!(builtin in BUILTIN_LABELS)) return { content: [text(`builtin must be one of: ${Object.keys(BUILTIN_LABELS).join(", ")}`)], isError: true };
		ctx.setPassChannel(target.id, index, { kind: "builtin", builtin, filter, wrap, assetId: undefined, passId: undefined });
		return { content: [text(`${target.name}.iChannel${index} = builtin ${builtin} (${BUILTIN_LABELS[builtin]}).`)] };
	},
});
