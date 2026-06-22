// list_passes -- report the render graph: every pass, its format, its input
// wiring (the edges), and which pass is the visible output.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext } from "./types.ts";
import type { Channel } from "../../state/types.ts";

function chan(c: Channel, ctx: ToolContext): string | null {
	if (c.kind === "none") return null;
	if (c.kind === "under") return "under";
	if (c.kind === "geometry") return "geometry";
	if (c.kind === "mask") return "mask";
	if (c.kind === "builtin") return `builtin:${c.builtin}`;
	if (c.kind === "pass") return `pass:${ctx.passes().find((p) => p.id === c.passId)?.name ?? c.passId}`;
	if (c.kind === "webcam") return "webcam";
	return `${c.kind === "video" ? "video" : "image"}:${ctx.assets.find((a) => a.id === c.assetId)?.name ?? c.assetId}`;
}

registerTool({
	name: TOOL_NAMES.listPasses,
	def: {
		name: TOOL_NAMES.listPasses,
		description: "List the ACTIVE layer's render graph: every pass, its format, its iChannel input wiring, and which pass is the layer's output (its composite). Passes render in dependency order (a pass that samples another renders after it); a channel sampling its own pass reads the previous frame (feedback). Use list_layers to see the whole document, select_layer to switch.",
		parameters: { type: "object", properties: {} },
	},
	execute: (ctx: ToolContext) => {
		const out = ctx.outputPassId();
		const layer = ctx.resolveLayer();
		const lines = ctx.passes().map((p) => {
			const ins = p.channels.map((c, i) => (chan(c, ctx) ? `iChannel${i}=${chan(c, ctx)}` : null)).filter(Boolean).join(", ");
			return `- ${p.name}${p.id === out ? " (OUTPUT -> layer composite)" : ""} [${p.format}, ${p.source.split("\n").length} lines]${ins ? `\n    inputs: ${ins}` : "\n    inputs: (none)"}`;
		});
		return { content: [text(`Active layer "${layer?.name ?? "?"}" render graph (${ctx.passes().length} pass${ctx.passes().length === 1 ? "" : "es"}):\n${lines.join("\n")}`)] };
	},
});
