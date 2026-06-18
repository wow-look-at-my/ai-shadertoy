// Tool definitions exposed to the model. Schemas are provider-neutral JSON
// Schema; providers.ts adapts them to Anthropic `input_schema` / OpenAI
// `function.parameters`.

import type { ToolDef } from "./types.ts";

export const TOOL_NAMES = {
	writeShader: "write_shader",
	getShader: "get_shader",
	setUniforms: "set_uniforms",
	setChannel: "set_channel",
	setChannelAsset: "set_channel_asset",
	listAssets: "list_assets",
	generateTexture: "generate_texture",
	screenshot: "capture_screenshot",
} as const;

export function toolDefs(opts: { imageGen: boolean }): ToolDef[] {
	const defs: ToolDef[] = [
		{
			name: TOOL_NAMES.writeShader,
			description:
				"Replace the entire fragment shader. Provide the COMPLETE GLSL ES 3.00 body defining `void mainImage(out vec4 fragColor, in vec2 fragCoord)` (Shadertoy convention). Do not include #version, precision, the iChannel/iTime uniform declarations, or main() -- those are added automatically. After the shader compiles it is rendered and a screenshot plus compile log are returned to you. Call this whenever you want to change what is drawn.",
			parameters: {
				type: "object",
				properties: {
					source: { type: "string", description: "Full GLSL source containing at least mainImage()." },
					note: { type: "string", description: "Optional one-line summary of the change." },
				},
				required: ["source"],
			},
		},
		{
			name: TOOL_NAMES.getShader,
			description: "Return the current shader source, declared custom uniforms, channel (iChannel0-3) bindings, and the most recent compile error if any.",
			parameters: { type: "object", properties: {} },
		},
		{
			name: TOOL_NAMES.setUniforms,
			description:
				"Declare the custom uniforms the shader uses, exposed to the user as live UI controls. This REPLACES the full set. Each uniform becomes a `uniform <type> <name>;` declaration available in mainImage. Use a u_ prefix to avoid colliding with built-ins. value length must match the type (float=1, vec2=2, vec3/color=3, vec4=4).",
			parameters: {
				type: "object",
				properties: {
					uniforms: {
						type: "array",
						description: "Complete list of custom uniforms.",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								type: { type: "string", enum: ["float", "vec2", "vec3", "vec4", "color"] },
								value: { type: "array", items: { type: "number" } },
								min: { type: "number" },
								max: { type: "number" },
								step: { type: "number" },
								label: { type: "string" },
							},
							required: ["name", "type", "value"],
						},
					},
				},
				required: ["uniforms"],
			},
		},
		{
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
		{
			name: TOOL_NAMES.setChannelAsset,
			description: "Bind a user-uploaded or generated image asset (by name, see list_assets) to an input channel iChannel0-3.",
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
		{
			name: TOOL_NAMES.listAssets,
			description: "List image assets available to bind to channels (uploaded by the user or previously generated).",
			parameters: { type: "object", properties: {} },
		},
		{
			name: TOOL_NAMES.screenshot,
			description: "Capture and return the current rendered frame as an image so you can see the result.",
			parameters: { type: "object", properties: {} },
		},
	];

	if (opts.imageGen) {
		defs.push({
			name: TOOL_NAMES.generateTexture,
			description: "Generate an image from a text prompt using the configured image model, add it to the asset library, and optionally bind it to a channel. Use for textures the shader should sample (noise patterns, surfaces, gradients, etc.).",
			parameters: {
				type: "object",
				properties: {
					prompt: { type: "string", description: "Description of the texture to generate. Prefer seamless/tileable where relevant." },
					name: { type: "string", description: "Short name for the asset." },
					index: { type: "integer", description: "Optional channel 0-3 to bind the result to." },
				},
				required: ["prompt"],
			},
		});
	}

	return defs;
}
