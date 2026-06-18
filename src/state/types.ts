// Provider-neutral conversation + project/state types. The conversation model
// mirrors Anthropic's content-block shape (it is the richest of the two
// providers we target); the OpenAI serializer down-converts it.

export type Role = "user" | "assistant" | "tool";

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ImageBlock {
	type: "image";
	mediaType: string; // e.g. "image/jpeg"
	data: string; // base64, no data: prefix
}
export interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}
export interface ToolResultBlock {
	type: "tool_result";
	toolUseId: string;
	content: Array<TextBlock | ImageBlock>;
	isError?: boolean;
}
export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
	id: string;
	role: Role;
	blocks: Block[];
	ts: number;
	/** transient UI hints, not sent to the model */
	pending?: boolean;
	error?: string;
	/** text-tools mode: names of tools this assistant turn invoked via XML tags */
	textTools?: string[];
	/** text-tools mode: this user message carries tool results (render as a results row) */
	toolOutput?: boolean;
}

export type UniformType = "float" | "vec2" | "vec3" | "vec4" | "color";

export interface Uniform {
	name: string;
	type: UniformType;
	value: number[]; // length 1 (float), 2, 3, 4; color is rgb 0..1
	min: number;
	max: number;
	step: number;
	label?: string;
}

export type ChannelKind = "none" | "image" | "builtin";
export type BuiltinTexture = "rgbaNoise" | "grayNoise" | "checker" | "gradient" | "blue";
export type TexFilter = "linear" | "nearest";
export type TexWrap = "repeat" | "clamp" | "mirror";

export interface Channel {
	kind: ChannelKind;
	assetId?: string; // when kind === "image"
	builtin?: BuiltinTexture; // when kind === "builtin"
	filter: TexFilter;
	wrap: TexWrap;
}

export interface ImageAsset {
	id: string;
	name: string;
	mediaType: string;
	dataUrl: string; // data:...;base64,...
	width: number;
	height: number;
	source: "upload" | "generated";
	prompt?: string;
}

export interface Project {
	id: string;
	name: string;
	shaderSource: string;
	uniforms: Uniform[];
	channels: [Channel, Channel, Channel, Channel];
	messages: Message[];
	createdAt: number;
	updatedAt: number;
}

export type ProviderId = "anthropic" | "openai";

export type ToolMode = "native" | "text";

export interface ChatConfig {
	provider: ProviderId;
	baseUrl: string; // override endpoint (OpenAI-compatible) or anthropic base
	apiKey: string;
	model: string;
	maxTokens: number;
	temperature: number;
	useProxy: boolean;
	/** "native" = function/tool calling via the API; "text" = forgiving XML tags
	 * in the response text, for models/endpoints without tool-calling support. */
	toolMode: ToolMode;
}

export interface ImageGenConfig {
	enabled: boolean;
	baseUrl: string; // OpenAI-compatible images endpoint base
	apiKey: string; // blank = reuse chat key
	model: string;
	size: string; // e.g. "512x512"
	useProxy: boolean;
}

export interface Settings {
	chat: ChatConfig;
	imageGen: ImageGenConfig;
	proxyUrl: string; // CORS proxy base; requests become `${proxyUrl}${targetUrl}`
	renderScale: number; // 0.25 .. 1
	autoScreenshot: boolean; // attach a render to the model after each shader change
	screenshotMaxDim: number; // longest edge fed to the model
	persistRequested: boolean;
}

export interface ExportBundle {
	kind: "ai-shadertoy-export";
	version: 1;
	exportedAt: number;
	projects: Project[];
	assets: ImageAsset[];
	settings?: Settings; // optional; API keys excluded unless includeKeys
}

export function defaultChannels(): [Channel, Channel, Channel, Channel] {
	const none = (): Channel => ({ kind: "none", filter: "linear", wrap: "repeat" });
	return [none(), none(), none(), none()];
}
