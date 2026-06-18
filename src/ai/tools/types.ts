// Tool contracts. Each tool colocates its schema (`def`) and implementation
// (`execute`) in its own file and self-registers. The store builds a ToolContext
// — the only surface a tool may touch — and dispatches to the registry.

import type { Channel, ImageAsset, ImageBlock, Project, Settings, TextBlock, Uniform } from "../../state/types.ts";
import type { CompileResult, Renderer } from "../../gl/renderer.ts";
import type { ToolDef } from "../types.ts";

export interface ToolResult {
	content: Array<TextBlock | ImageBlock>;
	isError?: boolean;
}

/** Screenshot block plus a short human-readable average-colour note. */
export type ShotBlock = ImageBlock & { _avg: string };

/** The capabilities a tool is allowed to use. Provided by the store. */
export interface ToolContext {
	settings: Settings;
	project: Project;
	assets: ImageAsset[];
	renderer: Renderer;
	setShaderSource(src: string, compile?: boolean): CompileResult;
	setUniforms(uniforms: Uniform[]): CompileResult;
	setChannel(index: number, patch: Partial<Channel>): void;
	addAsset(asset: ImageAsset): void;
	screenshotBlock(): ShotBlock;
	/** Build the standard "compiled OK + screenshot" / "compile failed + log" result. */
	shaderResult(okPrefix: string): ToolResult;
	/** Current compile error log, or null when the shader compiles. */
	compileError(): string | null;
}

/** Gates which tools are offered to the model on a given turn. */
export interface ToolAvailability {
	imageGen: boolean;
	allowWriteShader: boolean;
}

export interface Tool {
	name: string;
	def: ToolDef;
	/** Whether the tool is offered this turn (default: always). */
	available?(opts: ToolAvailability): boolean;
	execute(ctx: ToolContext, input: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

export function text(t: string): TextBlock {
	return { type: "text", text: t };
}

export function imageBlock(shot: ShotBlock): ImageBlock {
	return { type: "image", mediaType: shot.mediaType, data: shot.data };
}
