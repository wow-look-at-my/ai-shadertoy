// get_shader -- report the current source, custom uniforms, channel bindings,
// and the latest compile error (if any).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext } from "./types.ts";
import type { Channel, ImageAsset } from "../../state/types.ts";

function describeChannel(c: Channel, assets: ImageAsset[]): string {
	if (c.kind === "none") return "empty";
	if (c.kind === "builtin") return `builtin:${c.builtin}`;
	const a = assets.find((x) => x.id === c.assetId);
	return `image:${a?.name ?? c.assetId}`;
}

registerTool({
	name: TOOL_NAMES.getShader,
	def: {
		name: TOOL_NAMES.getShader,
		description: "Return the current shader source, declared custom uniforms, channel (iChannel0-3) bindings, and the most recent compile error if any.",
		parameters: { type: "object", properties: {} },
	},
	execute: (ctx: ToolContext) => {
		const p = ctx.project;
		const uniforms = p.uniforms.length ? p.uniforms.map((u) => `${u.type} ${u.name} = [${u.value.join(", ")}]`).join("\n") : "(none)";
		const channels = p.channels.map((c, i) => `iChannel${i}: ${describeChannel(c, ctx.assets)}`).join("\n");
		const err = ctx.compileError();
		return { content: [text(`Current shader source:\n\`\`\`glsl\n${p.shaderSource}\n\`\`\`\n\nCustom uniforms:\n${uniforms}\n\nChannels:\n${channels}${err ? `\n\nLast compile error:\n${err}` : ""}`)] };
	},
});
