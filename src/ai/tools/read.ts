// read -- the inspection tool. Reads a pass's source + bindings + uniforms
// + compile error, a layer's render graph, or lists layers / passes / shapes /
// assets / uniforms. Replaces get_shader + every list_* tool. Targets are explicit
// (layer ref = name|id|index; pass ref = name|id), never an "active" object.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import type { ToolContext } from "./types.ts";
import { describeChannel, graphSummary } from "./describe.ts";
import { describeShape } from "./geometry_util.ts";
import type { Layer } from "../../state/types.ts";

const WHAT = ["pass", "graph", "layers", "passes", "shapes", "assets", "uniforms"] as const;
type What = (typeof WHAT)[number];

function uniformsBlock(ctx: ToolContext): string {
	const us = ctx.project.uniforms;
	return us.length ? us.map((u) => `${u.type} ${u.name} = [${u.value.join(", ")}] (min ${u.min}, max ${u.max})`).join("\n") : "(none)";
}

function readPass(ctx: ToolContext, layer: Layer, passRef?: string) {
	const pass = ctx.resolvePass(layer, passRef);
	if (!pass) return { content: [text(`No pass named "${passRef}" in layer "${layer.name}". read what:passes to list them.`)], isError: true };
	const channels = pass.channels.map((c, i) => `iChannel${i}: ${describeChannel(c, ctx.assets, layer.passes)}`).join("\n") || "(no inputs)";
	const err = ctx.compileError();
	return {
		content: [
			text(
				`Layer "${layer.name}", pass "${pass.name}"${pass.id === layer.outputPassId ? " (OUTPUT)" : ""} [${pass.format}]:\n\`\`\`glsl\n${pass.source}\n\`\`\`\n\nChannels:\n${channels}\n\nCustom uniforms (shared by all passes in all layers):\n${uniformsBlock(ctx)}${err ? `\n\nLast compile error:\n${err}` : ""}`,
			),
		],
	};
}

registerTool({
	name: TOOL_NAMES.read,
	def: {
		name: TOOL_NAMES.read,
		description:
			"Inspect the project. `what` selects what to read: 'pass' = a pass's GLSL source + channel bindings + declared uniforms + latest compile error (needs `layer`, optional `pass` = a pass name/id; defaults to that layer's output pass); 'graph' = a layer's whole render graph (needs `layer`); 'passes' = list a layer's passes (needs `layer`); 'shapes' = list a layer's shapes by index (needs `layer`); 'layers' = the whole layer stack (back to front); 'assets' = the media library; 'uniforms' = the shared custom uniforms. A `layer` ref is a layer name, id, or stack index (0 = bottom/back); it defaults to the top layer when omitted.",
		parameters: {
			type: "object",
			properties: {
				what: { type: "string", enum: WHAT as unknown as string[], description: "What to read." },
				layer: { type: "string", description: "Layer ref (name, id, or stack index). Required for pass/graph/passes/shapes; defaults to the top layer." },
				pass: { type: "string", description: "Pass name or id (for what:pass; default = the layer's output pass)." },
			},
			required: ["what"],
		},
	},
	execute: (ctx: ToolContext, input) => {
		const what = String(input["what"] ?? "") as What;
		const layerRef = input["layer"] !== undefined ? String(input["layer"]) : undefined;

		if (what === "assets") {
			if (!ctx.assets.length) return { content: [text("No media assets. The user can upload an image or video in the Assets tab, or use generate_texture if image generation is enabled.")] };
			const list = ctx.assets.map((a) => `- ${a.name} (${a.kind === "video" ? "video, " : ""}${a.width}x${a.height}, ${a.source})`).join("\n");
			return { content: [text(`Available media assets:\n${list}`)] };
		}
		if (what === "uniforms") {
			return { content: [text(`Custom uniforms (shared by all passes in all layers):\n${uniformsBlock(ctx)}`)] };
		}
		if (what === "layers") {
			const layers = ctx.layers();
			const lines = layers.map((l, i) => {
				const flags = [l.visible ? null : "hidden", l.opacity < 1 ? `opacity ${l.opacity.toFixed(2)}` : null, l.mask ? "masked" : null].filter(Boolean).join(", ");
				return `[${i}] ${l.name} -- ${l.passes.length} pass${l.passes.length === 1 ? "" : "es"}, ${l.shapes.length} shape${l.shapes.length === 1 ? "" : "s"}${flags ? ` (${flags})` : ""}`;
			});
			return { content: [text(`Layer stack, back (0) to front (${layers.length - 1}):\n${lines.join("\n")}`)] };
		}

		// The remaining kinds are layer-scoped.
		const layer = ctx.resolveLayer(layerRef);
		if (!layer) return { content: [text(`No layer "${layerRef}". read what:layers to list them.`)], isError: true };

		if (what === "pass") return readPass(ctx, layer, input["pass"] ? String(input["pass"]) : undefined);
		if (what === "graph") {
			return { content: [text(`Layer "${layer.name}" render graph (${layer.passes.length} pass${layer.passes.length === 1 ? "" : "es"}):\n${graphSummary(layer, ctx.assets)}`)] };
		}
		if (what === "passes") {
			return { content: [text(`Layer "${layer.name}" passes (${layer.passes.length}):\n${graphSummary(layer, ctx.assets)}`)] };
		}
		if (what === "shapes") {
			if (!layer.shapes.length) return { content: [text(`Layer "${layer.name}" has no shapes. Add one with create_object type:shape.`)] };
			const lines = layer.shapes.map((s, i) => describeShape(s, i));
			return { content: [text(`Shapes in layer "${layer.name}" (paint order):\n${lines.join("\n")}`)] };
		}
		return { content: [text(`Unknown 'what': ${what}. One of: ${WHAT.join(", ")}.`)], isError: true };
	},
});
