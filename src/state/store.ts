// Central application store. Owns settings, the current project, the asset
// library, and the renderer, and is the single place that mutates state +
// persists it. Also implements tool execution for the agent (applyTool).

import type { BuiltinTexture, Channel, ImageAsset, Project, Settings, TexFilter, TexWrap, Uniform } from "./types.ts";
import type { ToolResult } from "../ai/agent.ts";
import type { ImageBlock, TextBlock } from "./types.ts";
import { Renderer } from "../gl/renderer.ts";
import type { CompileResult } from "../gl/renderer.ts";
import { BUILTIN_LABELS } from "../gl/textures.ts";
import { isValidUniformName } from "../gl/wrapper.ts";
import { TOOL_NAMES } from "../ai/tools.ts";
import { generateImage } from "../ai/imagegen.ts";
import { db, getCurrentProjectId, importBundle, loadSettingsRaw, requestPersistence, saveSettings, setCurrentProjectId } from "./persist.ts";
import { DEFAULT_SETTINGS, makeProject, mergeSettings } from "./defaults.ts";
import { debounce, uid } from "../util/misc.ts";

type EventName = "project" | "projects" | "settings" | "assets" | "compile" | "busy" | "stats" | "toolActivity";

export class Store {
	settings: Settings = structuredClone(DEFAULT_SETTINGS);
	project!: Project;
	projects: Array<{ id: string; name: string; updatedAt: number }> = [];
	assets: ImageAsset[] = [];
	renderer!: Renderer;
	lastCompile: CompileResult | null = null;
	busy = false;

	private listeners = new Map<EventName, Set<(p: unknown) => void>>();
	private saveDebounced = debounce(() => void this.saveProjectNow(), 700);

	on(event: EventName, cb: (payload: unknown) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) this.listeners.set(event, (set = new Set()));
		set.add(cb);
		return () => set!.delete(cb);
	}
	private emit(event: EventName, payload?: unknown): void {
		this.listeners.get(event)?.forEach((cb) => cb(payload));
	}

	// ---- init ---------------------------------------------------------------

	async init(renderer: Renderer, defaultShaderSource: string): Promise<void> {
		this.renderer = renderer;
		renderer.onStats = (s) => this.emit("stats", s);

		this.settings = mergeSettings(loadSettingsRaw());
		this.renderer.setRenderScale(this.settings.renderScale);
		void requestPersistence().then((granted) => {
			if (granted && !this.settings.persistRequested) {
				this.settings.persistRequested = true;
				saveSettings(this.settings);
			}
		});

		this.assets = await db.loadAssets();
		const projects = await db.loadProjects();
		if (projects.length === 0) {
			this.project = makeProject("Untitled shader", defaultShaderSource);
			await db.saveProject(this.project);
		} else {
			const wanted = getCurrentProjectId();
			this.project = projects.find((p) => p.id === wanted) ?? projects.sort((a, b) => b.updatedAt - a.updatedAt)[0];
		}
		setCurrentProjectId(this.project.id);
		this.refreshProjectList(projects.length ? projects : [this.project]);

		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("assets", this.assets);
		this.emit("settings", this.settings);
	}

	private refreshProjectList(all: Array<{ id: string; name: string; updatedAt: number }>): void {
		const map = new Map(all.map((p) => [p.id, { id: p.id, name: p.name, updatedAt: p.updatedAt }]));
		map.set(this.project.id, { id: this.project.id, name: this.project.name, updatedAt: this.project.updatedAt });
		this.projects = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		this.emit("projects", this.projects);
	}

	// ---- renderer application ----------------------------------------------

	private applyProjectToRenderer(): void {
		this.lastCompile = this.renderer.setShader(this.project.shaderSource, this.project.uniforms);
		this.emit("compile", this.lastCompile);
		for (let i = 0; i < 4; i++) void this.applyChannel(i);
	}

	private async applyChannel(index: number): Promise<void> {
		const ch = this.project.channels[index];
		if (ch.kind === "none") {
			this.renderer.clearChannel(index);
		} else if (ch.kind === "builtin" && ch.builtin) {
			this.renderer.setChannelBuiltin(index, ch.builtin, ch.filter, ch.wrap);
		} else if (ch.kind === "image" && ch.assetId) {
			const asset = this.assets.find((a) => a.id === ch.assetId);
			if (!asset) {
				this.renderer.clearChannel(index);
				return;
			}
			try {
				const img = await loadImage(asset.dataUrl);
				this.renderer.setChannelImage(index, img, img.naturalWidth, img.naturalHeight, ch.filter, ch.wrap);
			} catch {
				this.renderer.clearChannel(index);
			}
		}
	}

	// ---- mutations ----------------------------------------------------------

	private touch(): void {
		this.project.updatedAt = Date.now();
		this.refreshProjectList(this.projects);
		this.saveDebounced();
	}

	async saveProjectNow(): Promise<void> {
		await db.saveProject(this.project);
	}

	setShaderSource(src: string, compile = true): CompileResult {
		this.project.shaderSource = src;
		if (compile) {
			this.lastCompile = this.renderer.setShader(src, this.project.uniforms);
			this.emit("compile", this.lastCompile);
		}
		this.emit("project", this.project);
		this.touch();
		return this.lastCompile ?? { ok: true, log: "" };
	}

	setUniforms(uniforms: Uniform[]): CompileResult {
		this.project.uniforms = uniforms;
		this.lastCompile = this.renderer.setShader(this.project.shaderSource, uniforms);
		this.emit("compile", this.lastCompile);
		this.emit("project", this.project);
		this.touch();
		return this.lastCompile;
	}

	updateUniformValue(name: string, value: number[]): void {
		const u = this.project.uniforms.find((x) => x.name === name);
		if (!u) return;
		u.value = value;
		this.renderer.setUniformValues(this.project.uniforms);
		this.touch();
	}

	setChannel(index: number, patch: Partial<Channel>): void {
		this.project.channels[index] = { ...this.project.channels[index], ...patch };
		void this.applyChannel(index);
		this.emit("project", this.project);
		this.touch();
	}

	addAsset(asset: ImageAsset): void {
		this.assets.push(asset);
		void db.saveAsset(asset);
		this.emit("assets", this.assets);
	}

	deleteAsset(id: string): void {
		this.assets = this.assets.filter((a) => a.id !== id);
		void db.deleteAsset(id);
		// detach from any channel using it
		this.project.channels.forEach((ch, i) => {
			if (ch.kind === "image" && ch.assetId === id) this.setChannel(i, { kind: "none", assetId: undefined });
		});
		this.emit("assets", this.assets);
	}

	// ---- settings -----------------------------------------------------------

	updateSettings(patch: Partial<Settings>): void {
		this.settings = { ...this.settings, ...patch };
		saveSettings(this.settings);
		this.renderer.setRenderScale(this.settings.renderScale);
		this.emit("settings", this.settings);
	}

	// ---- projects -----------------------------------------------------------

	async newProject(defaultShaderSource: string): Promise<void> {
		await this.saveProjectNow();
		this.project = makeProject("Untitled shader", defaultShaderSource);
		await db.saveProject(this.project);
		setCurrentProjectId(this.project.id);
		this.refreshProjectList(await db.loadProjects());
		this.applyProjectToRenderer();
		this.emit("project", this.project);
	}

	async switchProject(id: string): Promise<void> {
		if (id === this.project.id) return;
		await this.saveProjectNow();
		const projects = await db.loadProjects();
		const next = projects.find((p) => p.id === id);
		if (!next) return;
		this.project = next;
		setCurrentProjectId(id);
		this.refreshProjectList(projects);
		this.applyProjectToRenderer();
		this.emit("project", this.project);
	}

	async deleteProject(id: string, defaultShaderSource: string): Promise<void> {
		await db.deleteProject(id);
		const projects = await db.loadProjects();
		if (this.project.id === id) {
			if (projects.length) {
				this.project = projects.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			} else {
				this.project = makeProject("Untitled shader", defaultShaderSource);
				await db.saveProject(this.project);
			}
			setCurrentProjectId(this.project.id);
			this.applyProjectToRenderer();
			this.emit("project", this.project);
		}
		this.refreshProjectList(await db.loadProjects());
	}

	renameProject(name: string): void {
		this.project.name = name;
		this.emit("project", this.project);
		this.touch();
	}

	async reloadAfterImport(): Promise<void> {
		this.assets = await db.loadAssets();
		const projects = await db.loadProjects();
		if (projects.length) {
			this.project = projects.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			setCurrentProjectId(this.project.id);
		}
		this.refreshProjectList(projects.length ? projects : [this.project]);
		this.applyProjectToRenderer();
		this.emit("assets", this.assets);
		this.emit("project", this.project);
	}

	async importData(bundle: Parameters<typeof importBundle>[0], mode: "merge" | "replace"): Promise<{ projects: number; assets: number }> {
		const res = await importBundle(bundle, mode);
		await this.reloadAfterImport();
		return res;
	}

	setBusy(b: boolean): void {
		this.busy = b;
		this.emit("busy", b);
	}

	// ---- screenshot ---------------------------------------------------------

	private screenshotBlock(): ImageBlock & { _avg: string } {
		const shot = this.renderer.screenshot(this.settings.screenshotMaxDim);
		const data = shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1);
		const avg = `avg rgb(${shot.avgColor.join(", ")})${shot.nonBlack ? "" : " — looks black/empty"}`;
		return { type: "image", mediaType: shot.mediaType, data, _avg: avg };
	}

	// ---- tool execution -----------------------------------------------------

	async applyTool(name: string, input: unknown): Promise<ToolResult> {
		const args = (input ?? {}) as Record<string, unknown>;
		this.emit("toolActivity", { name });
		switch (name) {
			case TOOL_NAMES.writeShader:
				return this.toolWriteShader(String(args["source"] ?? ""), args["note"] ? String(args["note"]) : undefined);
			case TOOL_NAMES.getShader:
				return this.toolGetShader();
			case TOOL_NAMES.setUniforms:
				return this.toolSetUniforms(args["uniforms"]);
			case TOOL_NAMES.setChannel:
				return this.toolSetChannel(args);
			case TOOL_NAMES.setChannelAsset:
				return await this.toolSetChannelAsset(args);
			case TOOL_NAMES.listAssets:
				return this.toolListAssets();
			case TOOL_NAMES.screenshot:
				return this.toolScreenshot();
			case TOOL_NAMES.generateTexture:
				return await this.toolGenerateTexture(args);
			default:
				return { content: [text(`Unknown tool: ${name}`)], isError: true };
		}
	}

	private toolWriteShader(source: string, note?: string): ToolResult {
		if (!source.trim()) return { content: [text("write_shader requires non-empty source.")], isError: true };
		const result = this.setShaderSource(source, true);
		if (!result.ok) {
			return { content: [text(`Compile FAILED. Fix and call write_shader again.\n\nGLSL log (line numbers are relative to your source):\n${result.log}`)], isError: true };
		}
		const stats = this.renderer.stats();
		const blocks: Array<TextBlock | ImageBlock> = [];
		if (this.settings.autoScreenshot) {
			const shot = this.screenshotBlock();
			blocks.push(text(`Compiled OK${note ? ` (${note})` : ""}. Rendered ${stats.width}x${stats.height}, t=${stats.time.toFixed(2)}s. ${shot._avg}. Current frame:`));
			blocks.push({ type: "image", mediaType: shot.mediaType, data: shot.data });
		} else {
			blocks.push(text(`Compiled OK${note ? ` (${note})` : ""}. Rendered ${stats.width}x${stats.height}. (auto-screenshot disabled; call capture_screenshot to see it.)`));
		}
		return { content: blocks };
	}

	private toolGetShader(): ToolResult {
		const p = this.project;
		const uniforms = p.uniforms.length ? p.uniforms.map((u) => `${u.type} ${u.name} = [${u.value.join(", ")}]`).join("\n") : "(none)";
		const channels = p.channels.map((c, i) => `iChannel${i}: ${describeChannel(c, this.assets)}`).join("\n");
		const err = this.lastCompile && !this.lastCompile.ok ? `\n\nLast compile error:\n${this.lastCompile.log}` : "";
		return { content: [text(`Current shader source:\n\`\`\`glsl\n${p.shaderSource}\n\`\`\`\n\nCustom uniforms:\n${uniforms}\n\nChannels:\n${channels}${err}`)] };
	}

	private toolSetUniforms(raw: unknown): ToolResult {
		if (!Array.isArray(raw)) return { content: [text("uniforms must be an array.")], isError: true };
		const uniforms: Uniform[] = [];
		const errors: string[] = [];
		for (const item of raw as Array<Record<string, unknown>>) {
			const name = String(item["name"] ?? "");
			const type = String(item["type"] ?? "float") as Uniform["type"];
			if (!isValidUniformName(name)) {
				errors.push(`invalid/duplicate uniform name: ${name}`);
				continue;
			}
			const need = type === "float" ? 1 : type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
			let value = Array.isArray(item["value"]) ? (item["value"] as unknown[]).map(Number) : [];
			if (value.length < need) value = value.concat(new Array(need - value.length).fill(0));
			value = value.slice(0, need);
			uniforms.push({
				name,
				type,
				value,
				min: typeof item["min"] === "number" ? (item["min"] as number) : 0,
				max: typeof item["max"] === "number" ? (item["max"] as number) : 1,
				step: typeof item["step"] === "number" ? (item["step"] as number) : 0.01,
				label: item["label"] ? String(item["label"]) : undefined,
			});
		}
		const result = this.setUniforms(uniforms);
		const decl = uniforms.map((u) => `uniform ${u.type === "color" ? "vec3" : u.type} ${u.name};`).join("\n");
		const head = result.ok ? "Uniforms set." : `Uniforms set, but the shader no longer compiles:\n${result.log}`;
		return { content: [text(`${head}\nDeclared:\n${decl}${errors.length ? `\nSkipped: ${errors.join("; ")}` : ""}`)], isError: !result.ok };
	}

	private toolSetChannel(args: Record<string, unknown>): ToolResult {
		const index = Number(args["index"]);
		if (!(index >= 0 && index <= 3)) return { content: [text("index must be 0-3.")], isError: true };
		const kind = String(args["kind"] ?? "none");
		const filter = (args["filter"] as TexFilter) ?? "linear";
		const wrap = (args["wrap"] as TexWrap) ?? "repeat";
		if (kind === "none") {
			this.setChannel(index, { kind: "none", assetId: undefined, builtin: undefined });
			return { content: [text(`iChannel${index} cleared.`)] };
		}
		const builtin = String(args["builtin"] ?? "") as BuiltinTexture;
		if (!(builtin in BUILTIN_LABELS)) return { content: [text(`builtin must be one of: ${Object.keys(BUILTIN_LABELS).join(", ")}`)], isError: true };
		this.setChannel(index, { kind: "builtin", builtin, filter, wrap, assetId: undefined });
		return { content: [text(`iChannel${index} = builtin ${builtin} (${BUILTIN_LABELS[builtin]}).`)] };
	}

	private async toolSetChannelAsset(args: Record<string, unknown>): Promise<ToolResult> {
		const index = Number(args["index"]);
		if (!(index >= 0 && index <= 3)) return { content: [text("index must be 0-3.")], isError: true };
		const assetName = String(args["asset"] ?? "");
		const asset = this.assets.find((a) => a.name === assetName) ?? this.assets.find((a) => a.id === assetName);
		if (!asset) return { content: [text(`No asset named "${assetName}". Use list_assets.`)], isError: true };
		this.setChannel(index, { kind: "image", assetId: asset.id, builtin: undefined, filter: (args["filter"] as TexFilter) ?? "linear", wrap: (args["wrap"] as TexWrap) ?? "repeat" });
		return { content: [text(`iChannel${index} = image "${asset.name}" (${asset.width}x${asset.height}).`)] };
	}

	private toolListAssets(): ToolResult {
		if (!this.assets.length) return { content: [text("No image assets. The user can upload one, or use generate_texture if image generation is enabled.")] };
		const list = this.assets.map((a) => `- ${a.name} (${a.width}x${a.height}, ${a.source})`).join("\n");
		return { content: [text(`Available image assets:\n${list}`)] };
	}

	private toolScreenshot(): ToolResult {
		const shot = this.screenshotBlock();
		const stats = this.renderer.stats();
		return { content: [text(`Frame at t=${stats.time.toFixed(2)}s, ${stats.width}x${stats.height}. ${shot._avg}.`), { type: "image", mediaType: shot.mediaType, data: shot.data }] };
	}

	private async toolGenerateTexture(args: Record<string, unknown>): Promise<ToolResult> {
		if (!this.settings.imageGen.enabled) return { content: [text("Image generation is not enabled. Ask the user to configure it in Settings.")], isError: true };
		const prompt = String(args["prompt"] ?? "");
		if (!prompt.trim()) return { content: [text("generate_texture requires a prompt.")], isError: true };
		const gen = await generateImage(this.settings, prompt);
		const asset: ImageAsset = {
			id: uid("a_"),
			name: args["name"] ? String(args["name"]) : `gen-${this.assets.length + 1}`,
			mediaType: gen.mediaType,
			dataUrl: gen.dataUrl,
			width: gen.width,
			height: gen.height,
			source: "generated",
			prompt,
		};
		this.addAsset(asset);
		const blocks: Array<TextBlock | ImageBlock> = [text(`Generated texture "${asset.name}" (${asset.width}x${asset.height}).`)];
		const idx = Number(args["index"]);
		if (idx >= 0 && idx <= 3) {
			this.setChannel(idx, { kind: "image", assetId: asset.id, builtin: undefined, filter: "linear", wrap: "repeat" });
			blocks[0] = text(`Generated texture "${asset.name}" and bound it to iChannel${idx}.`);
		}
		blocks.push({ type: "image", mediaType: gen.mediaType, data: gen.dataUrl.slice(gen.dataUrl.indexOf(",") + 1) });
		return { content: blocks };
	}
}

function text(t: string): TextBlock {
	return { type: "text", text: t };
}

function describeChannel(c: Channel, assets: ImageAsset[]): string {
	if (c.kind === "none") return "empty";
	if (c.kind === "builtin") return `builtin:${c.builtin}`;
	const a = assets.find((x) => x.id === c.assetId);
	return `image:${a?.name ?? c.assetId}`;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image decode failed"));
		img.src = dataUrl;
	});
}
