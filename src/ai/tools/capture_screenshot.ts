// capture_screenshot -- return the current rendered frame to the model.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { imageBlock, text } from "./types.ts";

registerTool({
	name: TOOL_NAMES.screenshot,
	def: {
		name: TOOL_NAMES.screenshot,
		description: "Capture and return the current rendered frame as an image so you can see the result.",
		parameters: { type: "object", properties: {} },
	},
	execute: (ctx) => {
		const shot = ctx.screenshotBlock();
		const stats = ctx.renderer.stats();
		return { content: [text(`Frame at t=${stats.time.toFixed(2)}s, ${stats.width}x${stats.height}. ${shot._avg}.`), imageBlock(shot)] };
	},
});
