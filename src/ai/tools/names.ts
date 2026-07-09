// Canonical tool names, referenced by the tool modules, the store dispatcher,
// the text-tools prompt/parser, and the UI.
//
// The surface is GENERIC and parameterized: a handful of verbs (read /
// create_object / destroy_object / edit_object) that target any layer / pass /
// shape by an EXPLICIT ref in the call, plus the kept "good general" tools. There
// is no "active" object the model must track or select first.

export const TOOL_NAMES = {
	// generic verbs
	read: "read",
	createObject: "create_object",
	destroyObject: "destroy_object",
	editObject: "edit_object",
	// kept generals
	editShader: "edit_shader",
	connectPins: "connect_pins",
	setUniforms: "set_uniforms",
	screenshot: "capture_screenshot",
	generateTexture: "generate_texture",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
