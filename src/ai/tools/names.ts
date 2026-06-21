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
	addPass: "add_pass",
	removePass: "remove_pass",
	listPasses: "list_passes",
	setOutputPass: "set_output_pass",
	addLayer: "add_layer",
	removeLayer: "remove_layer",
	listLayers: "list_layers",
	reorderLayer: "reorder_layer",
	setLayer: "set_layer",
	selectLayer: "select_layer",
	addMask: "add_mask",
	removeMask: "remove_mask",
	addShape: "add_shape",
	editShape: "edit_shape",
	removeShape: "remove_shape",
	listShapes: "list_shapes",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
