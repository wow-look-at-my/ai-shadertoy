// get_shader -- report a pass's source, custom uniforms, its channel bindings,
// a summary of the whole render graph, and the latest compile error (if any).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext } from "./types.ts";
import type { Channel, ImageAsset, Pass } from "../../state/types.ts";

function describeChannel(c: Channel, assets: ImageAsset[], passes: Pass[]): string {
	if (c.kind === "none") return "empty";
	if (c.kind === "under") return "under (layers below)";
	if (c.kind === "geometry") return "geometry (this layer's shapes)";
	if (c.kind === "builtin") return `builtin:${c.builtin}`;
	if (c.kind === "pass") return `pass:${passes.find((p) => p.id === c.passId)?.name ?? c.passId}`;
	if (c.kind === "webcam") return "webcam";
	const a = assets.find((x) => x.id === c.assetId);
	return `${c.kind === "video" ? "video" : "image"}:${a?.name ?? c.assetId}`;
}

function graphSummary(ctx: ToolContext): string {
	const passes = ctx.passes();
	const out = ctx.outputPassId();
	return passes
		.map((p) => {
			const ins = p.channels.map((c, i) => (c.kind === "none" ? null : `iChannel${i}=${describeChannel(c, ctx.assets, passes)}`)).filter(Boolean).join(", ");
			return `- ${p.name}${p.id === out ? " (OUTPUT->layer composite)" : ""} [${p.format}]${ins ? `  inputs: ${ins}` : ""}`;
		})
		.join("\n");
}

registerTool({
	name: TOOL_NAMES.getShader,
	def: {
		name: TOOL_NAMES.getShader,
		description: "Return a pass's shader source and channel bindings, the declared custom uniforms, a summary of the ACTIVE layer's render graph, and the most recent compile error if any. Targets the active layer's output pass by default; set `pass` to inspect another pass in that layer. Use select_layer / list_layers to work on a different layer.",
		parameters: { type: "object", properties: { pass: { type: "string", description: "Pass name to read (default: the active layer's output pass)." } } },
	},
	execute: (ctx: ToolContext, input) => {
		const p = ctx.project;
		const passArg = input["pass"] ? String(input["pass"]) : undefined;
		const pass = ctx.resolvePass(passArg);
		if (!pass) return { content: [text(`No pass named "${passArg}" in the active layer. Use list_passes.`)], isError: true };
		const layer = ctx.resolveLayer();
		const uniforms = p.uniforms.length ? p.uniforms.map((u) => `${u.type} ${u.name} = [${u.value.join(", ")}]`).join("\n") : "(none)";
		const channels = pass.channels.map((c, i) => `iChannel${i}: ${describeChannel(c, ctx.assets, ctx.passes())}`).join("\n");
		const err = ctx.compileError();
		return {
			content: [
				text(
					`Active layer: "${layer?.name ?? "?"}".\nPass "${pass.name}" source:\n\`\`\`glsl\n${pass.source}\n\`\`\`\n\nChannels (pass "${pass.name}"):\n${channels}\n\nCustom uniforms (shared by all passes in all layers):\n${uniforms}\n\nActive layer render graph:\n${graphSummary(ctx)}${err ? `\n\nLast compile error:\n${err}` : ""}`,
				),
			],
		};
	},
});
