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

// "video"/"webcam" are DYNAMIC: a live video element whose current frame is
// uploaded to the channel texture every render tick (see gl/dynamictexture.ts).
// "under"/"geometry" are LAYER-AMBIENT inputs the renderer provides per layer:
// "under" = the composite of every layer below this one (transparent for the
// bottom layer); "geometry" = this layer's shapes rasterized (premultiplied
// rgba). Neither needs an asset/builtin/pass reference.
export type ChannelKind = "none" | "image" | "builtin" | "pass" | "video" | "webcam" | "under" | "geometry";
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

// ---- layers + geometry -----------------------------------------------------

/** Geometry primitive kind. This is a plain string union so a new shape is one
 * entry here plus one entry in the shape registry (gl/shapes.ts) -- the geometry
 * shader, the UI pickers, and the AI tools all enumerate from that registry. */
export type ShapeKind = "quad" | "circle";

/** One drawable primitive in a layer, rasterized as a real instanced mesh (a
 * unit quad shaded by the kind's signed-distance function). Coordinates are
 * normalized to the canvas: center (x,y) in 0..1 (x right, y UP -- origin
 * bottom-left, matching fragCoord), size (w,h) as a fraction of canvas width and
 * height. Rotation is rigid (applied in pixel space so aspect never shears it).
 * Shapes within a layer paint back-to-front in array order. */
export interface Shape {
	id: string;
	kind: ShapeKind;
	x: number; // center X, 0..1 of width
	y: number; // center Y, 0..1 of height (origin bottom-left)
	w: number; // full width, fraction of canvas width
	h: number; // full height, fraction of canvas height
	rotation: number; // radians
	color: [number, number, number, number]; // RGBA 0..1 (straight; rasterized premultiplied)
	cornerRadius: number; // 0..1 of the smaller half-extent (rounded corners; quad)
	feather: number; // edge softness in pixels (>= 0; on top of 1px AA)
	/** Radial falloff, 0..1. 0 = solid fill (crisp/feathered edge). >0 ramps alpha
	 * from 1 at the centre to 0 at the edge over this fraction of the half-extent
	 * (1 = full centre->edge gradient) -- turns the shape into a radial-gradient mask. */
	falloff: number;
}

/** One layer in the document's back-to-front stack. A layer is its own node
 * graph (`passes` + `outputPassId`, exactly like the old top-level project) plus
 * a list of geometry `shapes`. Its passes can wire two layer-ambient inputs:
 * kind:"under" (the composite of the layers below) and kind:"geometry" (this
 * layer's rasterized shapes); the layer's output pass produces the new
 * composite. Blending is therefore whatever the graph computes. */
export interface Layer {
	id: string;
	name: string;
	visible: boolean;
	opacity: number; // 0..1, scales this layer's geometry contribution
	passes: Pass[]; // the layer's render graph
	outputPassId: string; // the pass whose output is this layer's composite
	shapes: Shape[];
}

// A bindable media asset: a still image or (kind === "video") a clip sampled per
// frame. Both are stored inline as a data URL so they persist/export with the
// project. The webcam is a live channel with no asset.
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
	/** The document: an ordered stack of layers drawn BACK TO FRONT. layers[0] is
	 * the bottom layer (drawn first); the last entry is on top. Each layer is its
	 * own render graph; the previous layers' composite feeds the next as "under".
	 * The topmost visible layer's composite is shown on screen. */
	layers: Layer[];
	/** Custom uniforms are shared across every pass in every layer. */
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
	const pass = makePass("Composite", LAYER_COMPOSITE_SOURCE, channels, 320, 60);
	return makeLayer(name, [pass], pass.id, shapes);
}
