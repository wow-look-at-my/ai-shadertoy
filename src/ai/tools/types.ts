// Tool contracts. Each tool colocates its schema (`def`) and implementation
// (`execute`) in its own file and self-registers. The store builds a ToolContext
// — the only surface a tool may touch — and dispatches to the registry.

import type { Channel, ImageAsset, ImageBlock, Layer, Pass, PassFormat, Project, Settings, Shape, ShapeKind, TextBlock, Uniform } from "../../state/types.ts";
import type { CompileResult, Renderer } from "../../gl/renderer.ts";
import type { ToolDef } from "../types.ts";

export interface ToolResult {
	content: Array<TextBlock | ImageBlock>;
	isError?: boolean;
}

/** Screenshot block plus a short human-readable average-colour note. */
export type ShotBlock = ImageBlock & { _avg: string };

/** The capabilities a tool is allowed to use. Provided by the store. The document
 * is a back-to-front stack of layers; each layer is its own graph of passes plus
 * geometry. Tools target objects by an EXPLICIT ref passed in the call (there is
 * no "active" object): a layer ref is a name | id | stack index. A pass ref is a
 * name | id resolved within a layer. A shape ref is an index within a layer.
 * `resolveLayer`/`resolvePass`/`resolveShape` are the uniform entry points; they
 * never consult the editor's UI selection. */
export interface ToolContext {
	settings: Settings;
	project: Project;
	assets: ImageAsset[];
	renderer: Renderer;
	// ---- ref resolution (no "active" state -- everything is explicit) ----
	layers(): Layer[];
	resolveLayer(ref?: string | number): Layer | null;
	/** Resolve a pass by name or id within `layer`; no argument = its output pass. */
	resolvePass(layer: Layer, ref?: string): Pass | null;
	/** Resolve a shape by 0-based index within `layer`. */
	resolveShape(layer: Layer, index: number): Shape | null;
	/** The default target layer when a tool allows an omitted layer (the top one). */
	defaultLayer(): Layer | null;
	/** True if `layer`'s output pass still holds an UNAUTHORED default source (the fresh-project shader or the composite template) -- so seeding it via create_object won't overwrite real work. */
	isOutputUnauthored(layer: Layer): boolean;
	// ---- layers ----
	addLayer(name: string, shapes?: Shape[]): Layer;
	removeLayer(layerId: string): { ok: boolean; error?: string };
	renameLayerById(layerId: string, name: string): void;
	reorderLayer(layerId: string, toIndex: number): void;
	setLayerVisible(layerId: string, visible: boolean): void;
	setLayerOpacity(layerId: string, opacity: number): void;
	/** Add (or focus) a layer's mask; returns the mask layer. The mask's alpha attenuates the layer per-pixel. */
	addMask(layerId: string): Layer | null;
	removeMask(layerId: string): void;
	// ---- geometry ----
	addShape(layerId: string, kind: ShapeKind, patch?: Partial<Shape>): Shape | null;
	updateShape(layerId: string, shapeId: string, patch: Partial<Shape>): void;
	removeShape(layerId: string, shapeId: string): void;
	// ---- passes ----
	setPassSource(passId: string, src: string, compile?: boolean): CompileResult;
	/** Create a new pass in a layer; returns it (name is de-duplicated). */
	addPass(name: string, source: string, format: PassFormat, layerId: string): Pass;
	removePass(passId: string): { ok: boolean; error?: string };
	setOutputPass(passId: string): void;
	setPassFormat(passId: string, format: PassFormat): void;
	setUniforms(uniforms: Uniform[]): CompileResult;
	connectPin(passId: string, index: number, patch: Partial<Channel>): void;
	/** Rename the current shader (the project name shown in the top bar). */
	renameProject(name: string): void;
	addAsset(asset: ImageAsset): void;
	screenshotBlock(): ShotBlock;
	/** Draw the latest state and wait for the browser to present a frame. */
	nextFrame(): Promise<void>;
	/** Build the standard compile result. */
	shaderResult(okPrefix: string, withImage: boolean): ToolResult;
	/** Current compile error log (across all passes), or null when all compile. */
	compileError(): string | null;
}

/** Gates which tools are offered to the model. */
export interface ToolAvailability {
	imageGen: boolean;
}

export interface Tool {
	name: string;
	def: ToolDef;
	/** Whether the tool is offered this turn (default: always). */
	available?(opts: ToolAvailability): boolean;
	/** When true (or when the predicate returns true for this call's input), the agent asks the user to approve the call before it runs. */
	requiresPermission?: boolean | ((input: Record<string, unknown>) => boolean);
	/** Human-readable description of the pending action for the approval prompt (e.g. `Rename the shader to "Foo"?`). */
	permissionPrompt?(input: Record<string, unknown>): string;
	execute(ctx: ToolContext, input: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

export function text(t: string): TextBlock {
	return { type: "text", text: t };
}

export function imageBlock(shot: ShotBlock): ImageBlock {
	return { type: "image", mediaType: shot.mediaType, data: shot.data };
}
