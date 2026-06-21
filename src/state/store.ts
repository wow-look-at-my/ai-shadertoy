// Central application store. Owns settings, the current project (a render graph
// of passes), the asset library, and the renderer, and is the single place that
// mutates state + persists it. Also implements tool execution for the agent.

import type { Channel, ImageAsset, Pass, PassFormat, Project, Settings, Uniform } from "./types.ts";
import { makePass } from "./types.ts";
import { getTool, text } from "../ai/tools/index.ts";
import type { ShotBlock, ToolContext, ToolResult } from "../ai/tools/types.ts";
import { Renderer } from "../gl/renderer.ts";
import type { CompileResult } from "../gl/renderer.ts";
import { db, getCurrentProjectId, importBundle, loadSettingsRaw, requestPersistence, saveSettings, setCurrentProjectId } from "./persist.ts";
import { DEFAULT_SETTINGS, makeProject, mergeSettings } from "./defaults.ts";
import { debounce } from "../util/misc.ts";

type EventName = "project" | "projects" | "settings" | "assets" | "compile" | "busy" | "stats" | "toolActivity" | "selectedPass";

export class Store {
	settings: Settings = structuredClone(DEFAULT_SETTINGS);
	project!: Project;
	projects: Array<{ id: string; name: string; updatedAt: number }> = [];
	assets: ImageAsset[] = [];
	renderer!: Renderer;
	/** Aggregate compile state: ok when every pass compiles; log lists failures. */
	lastCompile: CompileResult | null = null;
	/** Per-pass compile results, keyed by pass id. */
	passCompiles = new Map<string, CompileResult>();
	/** Which pass the editor/inspector is focused on. */
	selectedPassId = "";
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
		this.selectedPassId = this.project.outputPassId;
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

	// ---- pass helpers -------------------------------------------------------

	passById(id: string): Pass | undefined {
		return this.project.passes.find((p) => p.id === id);
	}
	passByName(name: string): Pass | undefined {
		const n = name.toLowerCase();
		return this.project.passes.find((p) => p.name.toLowerCase() === n);
	}
	selectedPass(): Pass {
		return this.passById(this.selectedPassId) ?? this.passById(this.project.outputPassId) ?? this.project.passes[0];
	}
	selectPass(id: string): void {
		if (!this.passById(id) || id === this.selectedPassId) return;
		this.selectedPassId = id;
		this.emit("selectedPass", id);
	}

	// ---- renderer application ----------------------------------------------

	private applyProjectToRenderer(): void {
		this.passCompiles = this.renderer.setPasses(this.project.passes, this.project.outputPassId, this.project.uniforms);
		this.lastCompile = this.aggregateCompile();
		this.emit("compile", this.lastCompile);
		for (const pass of this.project.passes) for (let i = 0; i < 4; i++) void this.applyChannel(pass.id, i);
	}

	private aggregateCompile(): CompileResult {
		const fails: string[] = [];
		for (const pass of this.project.passes) {
			const c = this.passCompiles.get(pass.id);
			if (c && !c.ok) fails.push(`[${pass.name}]\n${c.log}`);
		}
		return fails.length ? { ok: false, log: fails.join("\n\n") } : { ok: true, log: "" };
	}

	/** Compile result for a specific pass (used by the per-pass editor log). */
	compileFor(passId: string): CompileResult | null {
		return this.passCompiles.get(passId) ?? null;
	}

	private async applyChannel(passId: string, index: number): Promise<void> {
		const pass = this.passById(passId);
		if (!pass) return;
		const ch = pass.channels[index];
		if (ch.kind === "none") {
			this.renderer.clearPassChannel(passId, index);
		} else if (ch.kind === "builtin" && ch.builtin) {
			this.renderer.setPassChannelBuiltin(passId, index, ch.builtin, ch.filter, ch.wrap);
		} else if (ch.kind === "pass" && ch.passId) {
			this.renderer.setPassChannelPass(passId, index, ch.passId, ch.filter, ch.wrap);
		} else if (ch.kind === "image" && ch.assetId) {
			const asset = this.assets.find((a) => a.id === ch.assetId);
			if (!asset) {
				this.renderer.clearPassChannel(passId, index);
				return;
			}
			try {
				const img = await loadImage(asset.dataUrl);
				this.renderer.setPassChannelImage(passId, index, img, img.naturalWidth, img.naturalHeight, ch.filter, ch.wrap);
			} catch {
				this.renderer.clearPassChannel(passId, index);
			}
		} else {
			this.renderer.clearPassChannel(passId, index);
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

	/** Edit one pass's source (recompiles just that pass). */
	setPassSource(passId: string, src: string, compile = true): CompileResult {
		const pass = this.passById(passId);
		if (!pass) return { ok: true, log: "" };
		pass.source = src;
		if (compile) {
			this.passCompiles.set(passId, this.renderer.setPassSource(passId, src));
			this.lastCompile = this.aggregateCompile();
			this.emit("compile", this.lastCompile);
		}
		this.emit("project", this.project);
		this.touch();
		return this.passCompiles.get(passId) ?? { ok: true, log: "" };
	}

	setUniforms(uniforms: Uniform[]): CompileResult {
		this.project.uniforms = uniforms;
		// Declarations changed -> every pass header changes, so recompile all.
		this.passCompiles = this.renderer.setPasses(this.project.passes, this.project.outputPassId, uniforms);
		this.lastCompile = this.aggregateCompile();
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

	setPassChannel(passId: string, index: number, patch: Partial<Channel>): void {
		const pass = this.passById(passId);
		if (!pass) return;
		pass.channels[index] = { ...pass.channels[index], ...patch };
		void this.applyChannel(passId, index);
		this.emit("project", this.project);
		this.touch();
	}

	// ---- pass graph mutations ----------------------------------------------

	addPass(name: string, source = "", format: PassFormat = "rgba8"): Pass {
		const x = this.project.passes.reduce((m, p) => Math.max(m, p.x), 0);
		const pass = makePass(uniquePassName(this.project.passes, name), source, undefined, x ? x - 240 : 40, 60 + this.project.passes.length * 30);
		pass.format = format;
		this.project.passes.unshift(pass);
		this.selectedPassId = pass.id;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedPass", pass.id);
		this.touch();
		return pass;
	}

	removePass(passId: string): { ok: boolean; error?: string } {
		if (this.project.passes.length <= 1) return { ok: false, error: "Cannot remove the only pass." };
		const idx = this.project.passes.findIndex((p) => p.id === passId);
		if (idx === -1) return { ok: false, error: "No such pass." };
		this.project.passes.splice(idx, 1);
		// Detach any channel referencing the removed pass.
		for (const p of this.project.passes) {
			p.channels.forEach((c, i) => {
				if (c.kind === "pass" && c.passId === passId) p.channels[i] = { ...c, kind: "none", passId: undefined };
			});
		}
		if (this.project.outputPassId === passId) this.project.outputPassId = this.project.passes[this.project.passes.length - 1].id;
		if (this.selectedPassId === passId) this.selectedPassId = this.project.outputPassId;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedPass", this.selectedPassId);
		this.touch();
		return { ok: true };
	}

	renamePass(passId: string, name: string): void {
		const pass = this.passById(passId);
		if (!pass) return;
		pass.name = uniquePassName(this.project.passes, name, passId);
		this.emit("project", this.project);
		this.touch();
	}

	setOutputPass(passId: string): void {
		if (!this.passById(passId)) return;
		this.project.outputPassId = passId;
		this.renderer.setOutputPass(passId);
		this.emit("project", this.project);
		this.touch();
	}

	setPassFormat(passId: string, format: PassFormat): void {
		const pass = this.passById(passId);
		if (!pass || pass.format === format) return;
		pass.format = format;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.touch();
	}

	/** Persist a graph-node position (no recompile, no re-render of views). */
	movePass(passId: string, x: number, y: number): void {
		const pass = this.passById(passId);
		if (!pass) return;
		pass.x = x;
		pass.y = y;
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
		// detach from any pass channel using it
		for (const p of this.project.passes) {
			p.channels.forEach((ch, i) => {
				if (ch.kind === "image" && ch.assetId === id) this.setPassChannel(p.id, i, { kind: "none", assetId: undefined });
			});
		}
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

	private adoptProject(p: Project): void {
		this.project = p;
		this.selectedPassId = p.outputPassId;
		setCurrentProjectId(p.id);
	}

	async newProject(defaultShaderSource: string): Promise<void> {
		await this.saveProjectNow();
		this.adoptProject(makeProject("Untitled shader", defaultShaderSource));
		await db.saveProject(this.project);
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
		this.adoptProject(next);
		this.refreshProjectList(projects);
		this.applyProjectToRenderer();
		this.emit("project", this.project);
	}

	async deleteProject(id: string, defaultShaderSource: string): Promise<void> {
		await db.deleteProject(id);
		const projects = await db.loadProjects();
		if (this.project.id === id) {
			if (projects.length) {
				this.adoptProject(projects.sort((a, b) => b.updatedAt - a.updatedAt)[0]);
			} else {
				this.adoptProject(makeProject("Untitled shader", defaultShaderSource));
				await db.saveProject(this.project);
			}
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
			this.adoptProject(projects.sort((a, b) => b.updatedAt - a.updatedAt)[0]);
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
		const err = this.aggregateCompile();
		if (!err.ok) {
			return { content: [text(`Compile FAILED. Read the log and fix it with edit_shader, then it re-renders.\n\nGLSL log (line numbers relative to each pass's source):\n${err.log}`)], isError: true };
		}
		const stats = this.renderer.stats();
		const passNote = stats.passes > 1 ? ` (${stats.passes} passes)` : "";
		if (withImage || this.settings.autoScreenshot) {
			const shot = this.screenshotBlock();
			return { content: [text(`${okPrefix} Rendered ${stats.width}x${stats.height}${passNote}, t=${stats.time.toFixed(2)}s. ${shot._avg}. Current frame:`), { type: "image", mediaType: shot.mediaType, data: shot.data }] };
		}
		return { content: [text(`${okPrefix} Rendered ${stats.width}x${stats.height}${passNote}. (No preview attached — set screenshot:true to see it now, otherwise you'll be shown the final render when you finish.)`)] };
	}

	// ---- tool execution: dispatch to the registry via a ToolContext ----------

	private toolContext(): ToolContext {
		return {
			settings: this.settings,
			project: this.project,
			assets: this.assets,
			renderer: this.renderer,
			passes: () => this.project.passes,
			outputPassId: () => this.project.outputPassId,
			selectedPassId: () => this.selectedPassId,
			resolvePass: (nameOrId) => this.resolvePass(nameOrId),
			setPassSource: (id, s, c) => this.setPassSource(id, s, c),
			addPass: (name, source, format) => this.addPass(name, source, format),
			removePass: (id) => this.removePass(id),
			renamePassById: (id, name) => this.renamePass(id, name),
			setOutputPass: (id) => this.setOutputPass(id),
			setPassFormat: (id, fmt) => this.setPassFormat(id, fmt),
			selectPass: (id) => this.selectPass(id),
			setUniforms: (u) => this.setUniforms(u),
			setPassChannel: (id, i, p) => this.setPassChannel(id, i, p),
			renameProject: (n) => this.renameProject(n),
			addAsset: (a) => this.addAsset(a),
			screenshotBlock: () => this.screenshotBlock(),
			shaderResult: (p, w) => this.shaderResult(p, w),
			compileError: () => (this.lastCompile && !this.lastCompile.ok ? this.lastCompile.log : null),
		};
	}

	/** Resolve a pass by id or name; default (no arg) = the output pass. */
	private resolvePass(nameOrId?: string): Pass | null {
		if (!nameOrId) return this.passById(this.project.outputPassId) ?? this.project.passes[0] ?? null;
		return this.passById(nameOrId) ?? this.passByName(nameOrId) ?? null;
	}

	async applyTool(name: string, input: unknown): Promise<ToolResult> {
		this.emit("toolActivity", { name });
		const tool = getTool(name);
		if (!tool) return { content: [text(`Unknown tool: ${name}`)], isError: true };
		return tool.execute(this.toolContext(), (input ?? {}) as Record<string, unknown>);
	}
}

function uniquePassName(passes: Pass[], base: string, exceptId?: string): string {
	const trimmed = base.trim() || "Pass";
	const taken = (n: string) => passes.some((p) => p.id !== exceptId && p.name.toLowerCase() === n.toLowerCase());
	if (!taken(trimmed)) return trimmed;
	let i = 2;
	while (taken(`${trimmed} ${i}`)) i++;
	return `${trimmed} ${i}`;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image decode failed"));
		img.src = dataUrl;
	});
}
