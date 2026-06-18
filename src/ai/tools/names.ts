// Canonical tool names, referenced by the tool modules, the store dispatcher,
// the text-tools prompt/parser, and the UI.

export const TOOL_NAMES = {
	initShader: "init_shader",
	editShader: "edit_shader",
	getShader: "get_shader",
	setUniforms: "set_uniforms",
	renameShader: "rename_shader",
	setChannel: "set_channel",
	setChannelAsset: "set_channel_asset",
	listAssets: "list_assets",
	generateTexture: "generate_texture",
	screenshot: "capture_screenshot",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
