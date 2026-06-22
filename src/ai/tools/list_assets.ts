// list_assets -- enumerate image assets the model can bind to channels.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.listAssets,
	def: {
		name: TOOL_NAMES.listAssets,
		description: "List image and video assets available to bind to channels (uploaded by the user or previously generated).",
		parameters: { type: "object", properties: {} },
	},
	execute: (ctx) => {
		if (!ctx.assets.length) return { content: [text("No media assets. The user can upload an image or video in the Assets tab, or use generate_texture if image generation is enabled.")] };
		const list = ctx.assets.map((a) => `- ${a.name} (${a.kind === "video" ? "video, " : ""}${a.width}x${a.height}, ${a.source})`).join("\n");
		return { content: [text(`Available media assets:\n${list}`)] };
	},
});
