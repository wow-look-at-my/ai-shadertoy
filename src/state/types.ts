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
export interface ThinkingBlock {
	type: "thinking";
	thinking: string; // summarized reasoning text (may be empty if display omitted)
	signature: string; // opaque signature; must be replayed unchanged on the same model
}
export interface ToolResultBlock {
	type: "tool_result";
	toolUseId: string;
	content: Array<TextBlock | ImageBlock>;
	isError?: boolean;
}
export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

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

export type ChannelKind = "none" | "image" | "builtin" | "pass";
export type BuiltinTexture = "rgbaNoise" | "grayNoise" | "checker" | "gradient" | "blue";
export type TexFilter = "linear" | "nearest";
export type TexWrap = "repeat" | "clamp" | "mirror";

export interface Channel {
	kind: ChannelKind;
	assetId?: string; // when kind === "image"
	builtin?: BuiltinTexture; // when kind === "builtin"
	passId?: string; // when kind === "pass": the pass whose output feeds this channel
	filter: TexFilter;
	wrap: TexWrap;
}

// Render-target pixel format for a pass. rgba8 is universal; rgba16f keeps HDR
// values (needed for bloom/blur of bright sources) when the GPU supports
// EXT_color_buffer_float, falling back to rgba8 otherwise.
export type PassFormat = "rgba8" | "rgba16f";

/** Upper bound on inputs per pass. WebGL2 guarantees at least 16 fragment
 * texture units (MAX_TEXTURE_IMAGE_UNITS); the renderer clamps to the actual
 * device limit, which is >= this. (Shadertoy's fixed 4 is not a limit we keep.) */
export const MAX_INPUTS = 16;

/** One node in the render graph: a fragment shader that renders to its own
 * offscreen texture, with a variable-length list of input channels that can
 * each sample a built-in texture, an image asset, or the output of ANOTHER pass
 * (the graph edges) -- including this pass's own previous frame (feedback).
 * Inputs are addressed as iChannel0..iChannel{N-1} in the shader. The project's
 * `outputPassId` pass is the one shown on screen. */
export interface Pass {
	id: string;
	name: string;
	source: string; // GLSL ES 3.00 body defining mainImage()
	channels: Channel[]; // 0..MAX_INPUTS; named iChannel0..iChannel{N-1}
	format: PassFormat;
	x: number; // node position in the graph editor
	y: number;
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
	/** The render graph: one or more passes. Single-pass projects have exactly
	 * one pass (the output). Custom uniforms are shared across all passes. */
	passes: Pass[];
	/** Which pass is composited to the screen (the visible result). */
	outputPassId: string;
	uniforms: Uniform[];
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

export function emptyChannel(): Channel {
	return { kind: "none", filter: "linear", wrap: "repeat" };
}

/** A default input list. New passes start with 4 (the familiar iChannel0..3),
 * but inputs can be added/removed freely up to MAX_INPUTS. */
export function defaultChannels(n = 4): Channel[] {
	return Array.from({ length: n }, emptyChannel);
}

let passCounter = 0;
/** Build a fresh pass. `id` is unique within a session; pass ids are persisted. */
export function makePass(name: string, source: string, channels?: Channel[], x = 40, y = 40): Pass {
	passCounter++;
	return {
		id: `pass_${Date.now().toString(36)}_${passCounter}`,
		name,
		source,
		channels: channels ?? defaultChannels(),
		format: "rgba8",
		x,
		y,
	};
}
