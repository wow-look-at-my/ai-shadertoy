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
 * geometry. Pass-scoped methods operate on the ACTIVE layer (switch it with
 * `selectLayer`); most edit tools take an optional pass name and default to that
 * layer's output pass (resolved via `resolvePass`). */
export interface ToolContext {
	settings: Settings;
	project: Project;
	assets: ImageAsset[];
	renderer: Renderer;
	// ---- layers ----
	layers(): Layer[];
	activeLayerId(): string;
	/** Resolve a layer by id or name; no argument = the active layer. */
	resolveLayer(nameOrId?: string): Layer | null;
	/** Add a new layer on top of the stack; returns it (name de-duplicated). */
	addLayer(name: string, shapes?: Shape[]): Layer;
	removeLayer(layerId: string): { ok: boolean; error?: string };
	renameLayerById(layerId: string, name: string): void;
	reorderLayer(layerId: string, toIndex: number): void;
	setLayerVisible(layerId: string, visible: boolean): void;
	setLayerOpacity(layerId: string, opacity: number): void;
	/** Add (or focus) a layer's mask and make it the active layer for editing;
	 * returns the mask layer. The mask's alpha attenuates the layer per-pixel. */
	addMask(layerId: string): Layer | null;
	removeMask(layerId: string): void;
	/** Make a layer active so the pass-scoped methods below target its graph. */
	selectLayer(layerId: string): void;
	// ---- geometry ----
	addShape(layerId: string, kind: ShapeKind, patch?: Partial<Shape>): Shape | null;
	updateShape(layerId: string, shapeId: string, patch: Partial<Shape>): void;
	removeShape(layerId: string, shapeId: string): void;
	// ---- passes (within the active layer) ----
	passes(): Pass[];
	outputPassId(): string;
	selectedPassId(): string;
	/** Resolve a pass by id or name within the active layer; no argument = its
	 * output pass. */
	resolvePass(nameOrId?: string): Pass | null;
	setPassSource(passId: string, src: string, compile?: boolean): CompileResult;
	/** Create a new pass in the active layer; returns it (name is de-duplicated). */
	addPass(name: string, source: string, format?: PassFormat): Pass;
	removePass(passId: string): { ok: boolean; error?: string };
	renamePassById(passId: string, name: string): void;
	setOutputPass(passId: string): void;
	setPassFormat(passId: string, format: PassFormat): void;
	selectPass(passId: string): void;
	setUniforms(uniforms: Uniform[]): CompileResult;
	setPassChannel(passId: string, index: number, patch: Partial<Channel>): void;
	/** Rename the current shader (the project name shown in the top bar). */
	renameProject(name: string): void;
	addAsset(asset: ImageAsset): void;
	screenshotBlock(): ShotBlock;
	/** Build the standard compile result. `withImage` attaches the rendered frame
	 * (the model can request it per-call); a compile failure always returns the log. */
	shaderResult(okPrefix: string, withImage: boolean): ToolResult;
	/** Current compile error log (across all passes), or null when all compile. */
	compileError(): string | null;
}

/** Gates which tools are offered to the model on a given turn. */
export interface ToolAvailability {
	imageGen: boolean;
	allowInitShader: boolean;
}

export interface Tool {
	name: string;
	def: ToolDef;
	/** Whether the tool is offered this turn (default: always). */
	available?(opts: ToolAvailability): boolean;
	/** When true, the agent asks the user to approve the call before it runs;
	 * a denial is fed back to the model instead of executing. */
	requiresPermission?: boolean;
	/** Human-readable description of the pending action for the approval prompt
	 * (e.g. `Rename the shader to "Foo"?`). Falls back to a generic message. */
	permissionPrompt?(input: Record<string, unknown>): string;
	execute(ctx: ToolContext, input: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

export function text(t: string): TextBlock {
	return { type: "text", text: t };
}

export function imageBlock(shot: ShotBlock): ImageBlock {
	return { type: "image", mediaType: shot.mediaType, data: shot.data };
}
