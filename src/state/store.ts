// Central application store. Owns settings, the current project, the asset
// library, and the renderer, and is the single place that mutates state +
// persists it. Also implements tool execution for the agent (applyTool).

import type { Channel, ImageAsset, Project, Settings, Uniform } from "./types.ts";
import { getTool, text } from "../ai/tools/index.ts";
import type { ShotBlock, ToolContext, ToolResult } from "../ai/tools/types.ts";
import { Renderer } from "../gl/renderer.ts";
import type { CompileResult } from "../gl/renderer.ts";
import { db, getCurrentProjectId, importBundle, loadSettingsRaw, requestPersistence, saveSettings, setCurrentProjectId } from "./persist.ts";
import { DEFAULT_SETTINGS, makeProject, mergeSettings } from "./defaults.ts";
import { debounce } from "../util/misc.ts";

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

	private screenshotBlock(): ShotBlock {
		const shot = this.renderer.screenshot(this.settings.screenshotMaxDim);
		const data = shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1);
		const avg = `avg rgb(${shot.avgColor.join(", ")})${shot.nonBlack ? "" : " — looks black/empty"}`;
		return { type: "image", mediaType: shot.mediaType, data, _avg: avg };
	}

	/** Standard compile result. Attaches the render only when the caller asked
	 * for it (per-tool screenshot flag) or the user enabled always-attach. */
	private shaderResult(okPrefix: string, withImage: boolean): ToolResult {
		if (this.lastCompile && !this.lastCompile.ok) {
			return { content: [text(`Compile FAILED. Read the log and fix it with edit_shader, then it re-renders.\n\nGLSL log (line numbers relative to your source):\n${this.lastCompile.log}`)], isError: true };
		}
		const stats = this.renderer.stats();
		if (withImage || this.settings.autoScreenshot) {
			const shot = this.screenshotBlock();
			return { content: [text(`${okPrefix} Rendered ${stats.width}x${stats.height}, t=${stats.time.toFixed(2)}s. ${shot._avg}. Current frame:`), { type: "image", mediaType: shot.mediaType, data: shot.data }] };
		}
		return { content: [text(`${okPrefix} Rendered ${stats.width}x${stats.height}. (No preview attached — set screenshot:true to see it now, otherwise you'll be shown the final render when you finish.)`)] };
	}

	// ---- tool execution: dispatch to the registry via a ToolContext ----------

	private toolContext(): ToolContext {
		return {
			settings: this.settings,
			project: this.project,
			assets: this.assets,
			renderer: this.renderer,
			setShaderSource: (s, c) => this.setShaderSource(s, c),
			setUniforms: (u) => this.setUniforms(u),
			setChannel: (i, p) => this.setChannel(i, p),
			addAsset: (a) => this.addAsset(a),
			screenshotBlock: () => this.screenshotBlock(),
			shaderResult: (p, w) => this.shaderResult(p, w),
			compileError: () => (this.lastCompile && !this.lastCompile.ok ? this.lastCompile.log : null),
		};
	}

	async applyTool(name: string, input: unknown): Promise<ToolResult> {
		this.emit("toolActivity", { name });
		const tool = getTool(name);
		if (!tool) return { content: [text(`Unknown tool: ${name}`)], isError: true };
		return tool.execute(this.toolContext(), (input ?? {}) as Record<string, unknown>);
	}
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image decode failed"));
		img.src = dataUrl;
	});
}
