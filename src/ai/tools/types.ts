// Tool contracts. Each tool colocates its schema (`def`) and implementation
// (`execute`) in its own file and self-registers. The store builds a ToolContext
// — the only surface a tool may touch — and dispatches to the registry.

import type { Channel, ImageAsset, ImageBlock, Pass, PassFormat, Project, Settings, TextBlock, Uniform } from "../../state/types.ts";
import type { CompileResult, Renderer } from "../../gl/renderer.ts";
import type { ToolDef } from "../types.ts";

export interface ToolResult {
	content: Array<TextBlock | ImageBlock>;
	isError?: boolean;
}

/** Screenshot block plus a short human-readable average-colour note. */
export type ShotBlock = ImageBlock & { _avg: string };

/** The capabilities a tool is allowed to use. Provided by the store. The shader
 * is a graph of passes; most edit tools take an optional pass name and default
 * to the output pass (resolved via `resolvePass`). */
export interface ToolContext {
	settings: Settings;
	project: Project;
	assets: ImageAsset[];
	renderer: Renderer;
	passes(): Pass[];
	outputPassId(): string;
	selectedPassId(): string;
	/** Resolve a pass by id or name; no argument = the output pass. */
	resolvePass(nameOrId?: string): Pass | null;
	setPassSource(passId: string, src: string, compile?: boolean): CompileResult;
	/** Create a new pass; returns it (name is de-duplicated). */
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
