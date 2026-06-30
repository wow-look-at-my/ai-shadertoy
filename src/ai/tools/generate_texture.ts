// generate_texture -- synthesize a texture image from a prompt (optional; only
// offered when image generation is configured), add it as an asset, and
// optionally bind it to a channel.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { generateImage } from "../imagegen.ts";
import { uid } from "../../util/misc.ts";
import type { ImageAsset, ImageBlock, TextBlock } from "../../state/types.ts";

registerTool({
	name: TOOL_NAMES.generateTexture,
	available: (o) => o.imageGen,
	def: {
		name: TOOL_NAMES.generateTexture,
		description: "Generate an image from a text prompt using the configured image model, add it to the asset library, and optionally bind it to a channel. Use for textures the shader should sample (noise patterns, surfaces, gradients, etc.).",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "Description of the texture to generate. Prefer seamless/tileable where relevant." },
				name: { type: "string", description: "Short name for the asset." },
				index: { type: "integer", description: "Optional channel index to bind the result to." },
				layer: { type: "string", description: "Layer ref (name/id/stack index) to bind into when index is set (default: the top layer)." },
				pass: { type: "string", description: "Pass to bind into when index is set (default: the layer's output pass)." },
			},
			required: ["prompt"],
		},
	},
	execute: async (ctx, input) => {
		if (!ctx.settings.imageGen.enabled) return { content: [text("Image generation is not enabled. Ask the user to configure it in Settings.")], isError: true };
		const prompt = String(input["prompt"] ?? "");
		if (!prompt.trim()) return { content: [text("generate_texture requires a prompt.")], isError: true };
		const gen = await generateImage(ctx.settings, prompt);
		const asset: ImageAsset = {
			id: uid("a_"),
			name: input["name"] ? String(input["name"]) : `gen-${ctx.assets.length + 1}`,
			mediaType: gen.mediaType,
			dataUrl: gen.dataUrl,
			width: gen.width,
			height: gen.height,
			source: "generated",
			prompt,
		};
		ctx.addAsset(asset);
		const blocks: Array<TextBlock | ImageBlock> = [text(`Generated texture "${asset.name}" (${asset.width}x${asset.height}).`)];
		const idx = Number(input["index"]);
		if (idx >= 0 && idx < ctx.renderer.maxInputs()) {
			const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
			const target = layer ? ctx.resolvePass(layer, input["pass"] ? String(input["pass"]) : undefined) : null;
			if (target) {
				ctx.connectPin(target.id, idx, { kind: "image", assetId: asset.id, builtin: undefined, passId: undefined, filter: "linear", wrap: "repeat" });
				blocks[0] = text(`Generated texture "${asset.name}" and bound it to ${target.name}.iChannel${idx}.`);
			}
		}
		blocks.push({ type: "image", mediaType: gen.mediaType, data: gen.dataUrl.slice(gen.dataUrl.indexOf(",") + 1) });
		return { content: blocks };
	},
});
