// Provider-neutral conversation + project/state types.

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
/** An OpenRouter-style `reasoning_details` entry type. */
export type ReasoningDetailType = "reasoning.text" | "reasoning.summary" | "reasoning.encrypted";

export interface ThinkingBlock {
	type: "thinking";
	thinking: string; // reasoning text, or a reasoning summary (may be empty if display omitted)
	signature: string; // opaque signature; must be replayed unchanged on the same model
	encrypted?: string;
	/** Set when the block arrived as a `reasoning_details` entry; replay rebuilds that entry from these fields. */
	detailType?: ReasoningDetailType;
	detailFormat?: string;
	detailId?: string;
	detailIndex?: number;
	/** A reasoning entry or block this app does not model, kept verbatim and replayed as-is on the wire it came from. */
	raw?: Record<string, unknown>;
	rawWire?: "anthropic" | "openai";
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
	/** A UI-only remark under the message (a truncated or refused turn); never sent to the model. */
	note?: string;
	/** text-tools mode: names of tools this assistant turn invoked via XML tags */
	textTools?: string[];
	/** text-tools mode: this user message carries tool results (render as a results row) */
	toolOutput?: boolean;
	/** Conversation-compaction artifact: "request" = the synthetic summarize prompt, "summary" = the AI-written recap that replaces the older history. */
	compaction?: "request" | "summary";
}

export type UniformType = "float" | "vec2" | "vec3" | "vec4" | "color";

export interface Uniform {
	name: string;
	type: UniformType;
	value: number[];
	min: number;
	max: number;
	step: number;
	label?: string;
}

// "video"/"webcam" are DYNAMIC: a live video element whose current frame is
// uploaded to the channel texture every render tick (see
// gl/dynamictexture.ts).
export type ChannelKind = "none" | "image" | "builtin" | "pass" | "video" | "webcam" | "under" | "geometry" | "mask";
export type BuiltinTexture = "rgbaNoise" | "grayNoise" | "checker" | "gradient" | "blue";
export type TexFilter = "linear" | "nearest";
export type TexWrap = "repeat" | "clamp" | "mirror";

export interface Channel {
	kind: ChannelKind;
	assetId?: string; // when kind === "image" or "video"
	builtin?: BuiltinTexture; // when kind === "builtin"
	passId?: string; // when kind === "pass": the pass whose output feeds this channel
	filter: TexFilter;
	wrap: TexWrap;
}

// Render-target pixel format for a pass.
export type PassFormat = "rgba8" | "rgba16f";

/** Upper bound on inputs per pass. */
export const MAX_INPUTS = 16;

/** One node in the render graph: a fragment shader that renders to its own
 * offscreen texture. */
export interface Pass {
	id: string;
	name: string;
	source: string;
	channels: Channel[]; // 0..MAX_INPUTS; named iChannel0..iChannel{N-1}
	format: PassFormat;
	/** "maskComposite": the pass add_mask generated to apply the layer's mask. */
	role?: "maskComposite";
}

// ---- layers + geometry -----------------------------------------------------

/** Geometry primitive kind. */
export type ShapeKind = "quad" | "circle";

/** One drawable primitive in a layer, rasterized as a real instanced mesh (a
 * unit quad shaded by the kind's signed-distance function). */
export interface Shape {
	id: string;
	kind: ShapeKind;
	x: number;
	y: number;
	w: number; // full width, fraction of canvas width
	h: number; // full height, fraction of canvas height
	rotation: number; // radians
	color: [number, number, number, number];
	cornerRadius: number;
	feather: number; // edge softness in pixels (>= 0; on top of 1px AA)
	falloff: number;
}

/** One layer in the document's back-to-front stack. */
export interface Layer {
	id: string;
	name: string;
	visible: boolean;
	opacity: number;
	passes: Pass[]; // the layer's render graph
	outputPassId: string; // the pass whose output is this layer's composite
	shapes: Shape[];
	/** Optional layer MASK: another layer. */
	mask?: Layer;
}

// A bindable media asset: a still image or (kind === "video") a clip sampled per frame. Both are stored inline as a data URL so they persist/export with the project. The
// webcam is a live channel with no asset.
export interface ImageAsset {
	id: string;
	name: string;
	mediaType: string;
	dataUrl: string; // data:...;base64,...
	width: number;
	height: number;
	source: "upload" | "generated";
	/** Absent (legacy) or "image" for stills; "video" for clips sampled per frame. */
	kind?: "image" | "video";
	prompt?: string;
}

export interface Project {
	id: string;
	name: string;
	/** The document: an ordered stack of layers drawn BACK TO FRONT. */
	layers: Layer[];
	/** Custom uniforms are shared across every pass in every layer. */
	uniforms: Uniform[];
	messages: Message[];
	createdAt: number;
	updatedAt: number;
}

export type ProviderId = "anthropic" | "openai" | "openrouter" | "ollama-cloud";

/** Chat keys by provider, so switching providers keeps each one's key. */
export type ApiKeys = Partial<Record<ProviderId, string>>;

export type ToolMode = "native" | "text";

export interface ChatConfig {
	provider: ProviderId;
	baseUrl: string; // override endpoint (OpenAI-compatible) or anthropic base
	apiKeys: ApiKeys;
	model: string;
	/** Undefined means the provider's default. */
	maxTokens?: number;
	/** Undefined means the provider's default. */
	temperature?: number;
	useProxy: boolean;
	/** "native" = function/tool calling via the API. */
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
	/** CORS proxy TEMPLATE. */
	proxyUrl: string;
	renderScale: number;
	squarePixels: boolean; // report iResolution as the short side so UVs are isotropic (circles stay round)
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

/** `n` empty texture inputs. */
export function defaultChannels(n: number): Channel[] {
	return Array.from({ length: n }, emptyChannel);
}

export function referencedInputCount(source: string): number {
	const clean = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	let max = -1;
	for (const m of clean.matchAll(/\biChannel(\d+)\b/g)) max = Math.max(max, Number(m[1]));
	return max + 1;
}

export function channelsForSource(source: string): Channel[] {
	return defaultChannels(referencedInputCount(source));
}

let passCounter = 0;
/** Build a fresh pass. `id` is unique within a session; pass ids are persisted.
 * Graph-editor positions are NOT stored -- the Passes view auto-lays the DAG out
 * from its dependency edges (see ui/graphlayout.ts). */
export function makePass(name: string, source: string, channels?: Channel[]): Pass {
	passCounter++;
	return {
		id: `pass_${Date.now().toString(36)}_${passCounter}`,
		name,
		source,
		channels: channels ?? channelsForSource(source),
		format: "rgba8",
	};
}

let shapeCounter = 0;
/** Build a fresh shape. Per-kind defaults (size, corner radius, ...) are filled
 * in by the caller from the shape registry; this just centers a medium primitive. */
export function makeShape(kind: ShapeKind, patch: Partial<Shape> = {}): Shape {
	shapeCounter++;
	return {
		id: `shape_${Date.now().toString(36)}_${shapeCounter}`,
		kind,
		x: 0.5,
		y: 0.5,
		w: 0.4,
		h: 0.4,
		rotation: 0,
		color: [0.9, 0.3, 0.4, 1],
		cornerRadius: 0,
		feather: 0,
		falloff: 0,
		...patch,
	};
}

// The default graph for a NEW layer: one pass that composites this layer's
// geometry over the layers below ("source-over", premultiplied alpha). Both
// inputs are premultiplied, so a single mad does the blend. Rewrite this shader
// (or add passes) to get any other blend mode -- that is the whole point: the
// node graph controls the blending.
export const LAYER_COMPOSITE_SOURCE = `// Composite this layer's geometry over the layers below it.
// iChannel0 = under (everything below, premultiplied); iChannel1 = this layer's geometry.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;
	vec4 under = texture(iChannel0, uv);
	vec4 geo = texture(iChannel1, uv);
	// "over": premultiplied src + dst * (1 - src.a).
	fragColor = geo + under * (1.0 - geo.a);
}
`;

let layerCounter = 0;
/** Build a fresh layer wrapping an explicit set of passes (its render graph). */
export function makeLayer(name: string, passes: Pass[], outputPassId: string, shapes: Shape[] = [], opts: Partial<Pick<Layer, "visible" | "opacity">> = {}): Layer {
	layerCounter++;
	return {
		id: `layer_${Date.now().toString(36)}_${layerCounter}`,
		name,
		visible: opts.visible ?? true,
		opacity: opts.opacity ?? 1,
		passes,
		outputPassId,
		shapes,
	};
}

/** A ready-to-use geometry layer: one "Composite" pass wired under->iChannel0,
 * geometry->iChannel1, doing source-over. Used when the AI/UI adds a new layer. */
export function makeCompositeLayer(name: string, shapes: Shape[] = []): Layer {
	const channels: Channel[] = [
		{ kind: "under", filter: "linear", wrap: "clamp" },
		{ kind: "geometry", filter: "linear", wrap: "clamp" },
	];
	const pass = makePass("Composite", LAYER_COMPOSITE_SOURCE, channels);
	return makeLayer(name, [pass], pass.id, shapes);
}

// A mask layer's default graph: output its own geometry directly (so the
// mask's alpha = the shapes' coverage / radial gradient).
export const MASK_SOURCE = `// Mask: output this layer's geometry; its alpha is the mask coverage.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	fragColor = texture(iChannel0, fragCoord / iResolution.xy);
}
`;

export const MASK_COMPOSITE_SOURCE = `// Masked Composite: apply this layer's mask in the graph.
// iChannel0 = under (everything below); iChannel1 = this layer's unmasked composite; iChannel2 = mask.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;
	vec4 under = texture(iChannel0, uv);
	vec4 comp = texture(iChannel1, uv);
	float m = clamp(texture(iChannel2, uv).a, 0.0, 1.0);
	fragColor = mix(under, comp, m);
}
`;

/** A ready-to-use mask layer: one "Mask" pass that outputs its geometry. Seed it
 * with shapes (e.g. an ellipse with falloff) to get a soft mask. */
export function makeMaskLayer(shapes: Shape[] = []): Layer {
	const channels: Channel[] = [{ kind: "geometry", filter: "linear", wrap: "clamp" }];
	const pass = makePass("Mask", MASK_SOURCE, channels);
	return makeLayer("Mask", [pass], pass.id, shapes);
}

/** The wiring add_mask generates: iChannel0=under, iChannel1=the unmasked
 * output, iChannel2=mask. */
export function hasMaskCompositeWiring(pass: Pass): boolean {
	return pass.channels[0]?.kind === "under" && pass.channels[1]?.kind === "pass" && pass.channels[2]?.kind === "mask";
}

export function isMaskCompositePass(pass: Pass): boolean {
	return pass.role === "maskComposite";
}

export function ensureMaskCompositePass(layer: Layer): Pass {
	const out = layer.passes.find((p) => p.id === layer.outputPassId);
	if (out && isMaskCompositePass(out)) return out;
	const channels: Channel[] = [
		{ kind: "under", filter: "linear", wrap: "clamp" },
		{ kind: "pass", passId: layer.outputPassId, filter: "linear", wrap: "clamp" },
		{ kind: "mask", filter: "linear", wrap: "clamp" },
	];
	const pass = makePass("Masked Composite", MASK_COMPOSITE_SOURCE, channels);
	pass.role = "maskComposite";
	layer.passes.push(pass);
	layer.outputPassId = pass.id;
	return pass;
}

export function removeMaskCompositePass(layer: Layer): void {
	const out = layer.passes.find((p) => p.id === layer.outputPassId);
	if (!out || !isMaskCompositePass(out)) return;
	const unmaskedId = out.channels[1]?.passId;
	layer.passes = layer.passes.filter((p) => p.id !== out.id);
	if (unmaskedId && layer.passes.some((p) => p.id === unmaskedId)) layer.outputPassId = unmaskedId;
	else layer.outputPassId = layer.passes[layer.passes.length - 1]?.id ?? layer.outputPassId;
}
