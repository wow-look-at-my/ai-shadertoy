// Central application store. Owns settings, the current project (a render graph
// of passes), the asset library, and the renderer, and is the single place that
// mutates state + persists it. Also implements tool execution for the agent.

import type { Channel, ImageAsset, Pass, PassFormat, Project, Settings, Uniform } from "./types.ts";
import { emptyChannel, makePass } from "./types.ts";
import { getTool, text } from "../ai/tools/index.ts";
import type { ShotBlock, ToolContext, ToolResult } from "../ai/tools/types.ts";
import { Renderer } from "../gl/renderer.ts";
import type { CompileResult } from "../gl/renderer.ts";
import { db, getCurrentProjectId, importBundle, loadSettingsRaw, requestPersistence, saveSettings, setCurrentProjectId } from "./persist.ts";
import { DEFAULT_SETTINGS, makeProject, mergeSettings } from "./defaults.ts";
import { History } from "./history.ts";
import { debounce, uid } from "../util/misc.ts";
import { loadImageEl, requestWebcam, stopStream } from "../util/media.ts";

type EventName = "project" | "projects" | "settings" | "assets" | "compile" | "busy" | "stats" | "toolActivity" | "selectedPass" | "history" | "restore";

/** The slice of a Project that undo/redo restores: the visible/editable state
 * (name, render graph, uniforms). The conversation log and identity/timestamps
 * are intentionally excluded -- you don't "undo" the chat history, and ids must
 * stay stable. Snapshots are deep-cloned on the way in and out. */
interface ProjectSnapshot {
	name: string;
	passes: Pass[];
	outputPassId: string;
	uniforms: Uniform[];
}

const HISTORY_LIMIT = 200;
const HISTORY_COALESCE_MS = 1200;

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
	/** Undo/redo over project snapshots. Reset whenever the active project
	 * changes so history never crosses project boundaries. */
	history!: History<ProjectSnapshot>;

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
		this.history = new History<ProjectSnapshot>(this.snapshot(), (s) => structuredClone(s), { limit: HISTORY_LIMIT, coalesceMs: HISTORY_COALESCE_MS });
		this.history.setOnChange(() => this.emit("history"));
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
		for (const pass of this.project.passes) for (let i = 0; i < pass.channels.length; i++) void this.applyChannel(pass.id, i);
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
				const img = await loadImageEl(asset.dataUrl);
				this.renderer.setPassChannelImage(passId, index, img, img.naturalWidth, img.naturalHeight, ch.filter, ch.wrap);
			} catch {
				this.renderer.clearPassChannel(passId, index);
			}
		} else if (ch.kind === "video" && ch.assetId) {
			const asset = this.assets.find((a) => a.id === ch.assetId);
			if (!asset) {
				this.renderer.clearPassChannel(passId, index);
				return;
			}
			// Idempotent: the renderer keeps the playing clip when the key matches,
			// so re-applying on an unrelated edit doesn't restart playback.
			this.renderer.setPassChannelVideo(passId, index, asset.dataUrl, asset.id, ch.filter, ch.wrap);
		} else if (ch.kind === "webcam") {
			// Already streaming? Refresh filter/wrap instead of re-acquiring the camera.
			if (this.renderer.dynamicKey(passId, index) === "webcam") {
				this.renderer.setPassChannelParams(passId, index, ch.filter, ch.wrap);
				return;
			}
			try {
				const stream = await requestWebcam();
				// The binding may have changed while we awaited the permission prompt.
				const cur = this.passById(passId)?.channels[index];
				if (!cur || cur.kind !== "webcam") {
					stopStream(stream);
					return;
				}
				this.renderer.setPassChannelWebcam(passId, index, stream, cur.filter, cur.wrap);
			} catch {
				this.renderer.clearPassChannel(passId, index); // permission denied / no camera
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

	// ---- undo / redo --------------------------------------------------------

	/** Live (uncloned) view of the undoable project slice; History clones it. */
	private snapshot(): ProjectSnapshot {
		return { name: this.project.name, passes: this.project.passes, outputPassId: this.project.outputPassId, uniforms: this.project.uniforms };
	}

	/** Record the just-applied mutation into history. Call AFTER mutating
	 * `this.project`. `tag` groups same-kind edits for coalescing. */
	private commit(label: string, tag: string, coalesce = false): void {
		this.history.commit(this.snapshot(), label, tag, coalesce);
	}

	/** Restore a snapshot (from undo/redo) into the live project + renderer. */
	private applySnapshot(s: ProjectSnapshot): void {
		this.project.name = s.name;
		this.project.passes = structuredClone(s.passes);
		this.project.outputPassId = s.outputPassId;
		this.project.uniforms = structuredClone(s.uniforms);
		if (!this.passById(this.selectedPassId)) this.selectedPassId = this.project.outputPassId;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedPass", this.selectedPassId);
		// Source changed out from under the editor: force the code box to refresh
		// even if it currently has focus (a normal "project" sync won't clobber a
		// focused textarea, but an undo/redo must always be reflected).
		this.emit("restore");
		this.touch();
	}

	canUndo(): boolean {
		return !this.busy && this.history.canUndo();
	}
	canRedo(): boolean {
		return !this.busy && this.history.canRedo();
	}
	undoLabel(): string | null {
		return this.history.undoLabel();
	}
	redoLabel(): string | null {
		return this.history.redoLabel();
	}

	undo(): void {
		if (this.busy) return; // never unwind while the agent is mid-edit
		const s = this.history.undo();
		if (s) this.applySnapshot(s);
	}
	redo(): void {
		if (this.busy) return;
		const s = this.history.redo();
		if (s) this.applySnapshot(s);
	}

	/** Group every project mutation until endHistoryGroup() into one undo step.
	 * The chat wraps an agent turn in this so a whole turn reverts at once. */
	beginHistoryGroup(label: string): void {
		this.history.beginGroup(label);
	}
	endHistoryGroup(): void {
		this.history.endGroup();
	}

	/** The chat UI edited/deleted entries in `project.messages` in place. Bump the
	 * timestamp, refresh the project list, and persist immediately. */
	commitMessages(): void {
		this.touch();
		void this.saveProjectNow();
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
		this.commit(`Edit ${pass.name} code`, `code:${passId}`, true);
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
		this.commit("Edit uniforms", "uniforms");
		this.touch();
		return this.lastCompile;
	}

	updateUniformValue(name: string, value: number[]): void {
		const u = this.project.uniforms.find((x) => x.name === name);
		if (!u) return;
		u.value = value;
		this.renderer.setUniformValues(this.project.uniforms);
		// Coalesce a slider/picker drag into one entry rather than one per tick.
		this.commit(`Adjust ${name}`, `uval:${name}`, true);
		this.touch();
	}

	setPassChannel(passId: string, index: number, patch: Partial<Channel>): void {
		const pass = this.passById(passId);
		if (!pass || index < 0 || index >= this.renderer.maxInputs()) return;
		// Auto-grow the input list so a higher index just adds inputs (no fixed cap).
		const grew = index >= pass.channels.length;
		while (pass.channels.length <= index) pass.channels.push(emptyChannel());
		const prev = pass.channels[index];
		const next = { ...prev, ...patch };
		pass.channels[index] = next;
		if (grew) {
			// Channel count changed -> the pass header changes -> recompile.
			this.applyProjectToRenderer();
		} else {
			const sourceSame = prev.kind === next.kind && prev.assetId === next.assetId && prev.builtin === next.builtin && prev.passId === next.passId;
			if (sourceSame && next.kind !== "none") {
				// Only filter/wrap changed -> cheap update (no image reload, no clip
				// restart, no webcam re-acquire).
				this.renderer.setPassChannelParams(passId, index, next.filter, next.wrap);
			} else {
				void this.applyChannel(passId, index);
			}
		}
		this.emit("project", this.project);
		this.commit(`Set ${pass.name} iChannel${index}`, `channel:${passId}:${index}`);
		this.touch();
	}

	/** Append one empty input to a pass (up to the hardware limit). */
	addPassChannel(passId: string): void {
		const pass = this.passById(passId);
		if (!pass || pass.channels.length >= this.renderer.maxInputs()) return;
		pass.channels.push(emptyChannel());
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.commit(`Add input to ${pass.name}`, `addchannel:${passId}`);
		this.touch();
	}

	/** Remove one input from a pass. Subsequent inputs shift down (iChannelN is
	 * positional), so references in the shader may need updating. */
	removePassChannel(passId: string, index: number): void {
		const pass = this.passById(passId);
		if (!pass || index < 0 || index >= pass.channels.length) return;
		pass.channels.splice(index, 1);
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.commit(`Remove iChannel${index} from ${pass.name}`, `rmchannel:${passId}`);
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
		this.commit(`Add pass "${pass.name}"`, "addpass");
		this.touch();
		return pass;
	}

	removePass(passId: string): { ok: boolean; error?: string } {
		if (this.project.passes.length <= 1) return { ok: false, error: "Cannot remove the only pass." };
		const idx = this.project.passes.findIndex((p) => p.id === passId);
		if (idx === -1) return { ok: false, error: "No such pass." };
		const removedName = this.project.passes[idx].name;
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
		this.commit(`Remove pass "${removedName}"`, "removepass");
		this.touch();
		return { ok: true };
	}

	renamePass(passId: string, name: string): void {
		const pass = this.passById(passId);
		if (!pass) return;
		pass.name = uniquePassName(this.project.passes, name, passId);
		this.emit("project", this.project);
		this.commit(`Rename pass to "${pass.name}"`, `renamepass:${passId}`);
		this.touch();
	}

	setOutputPass(passId: string): void {
		if (!this.passById(passId)) return;
		this.project.outputPassId = passId;
		this.renderer.setOutputPass(passId);
		this.emit("project", this.project);
		this.commit("Set output pass", "output");
		this.touch();
	}

	setPassFormat(passId: string, format: PassFormat): void {
		const pass = this.passById(passId);
		if (!pass || pass.format === format) return;
		pass.format = format;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.commit(`Set ${pass.name} format`, `format:${passId}`);
		this.touch();
	}

	/** Persist a graph-node position (no recompile, no re-render of views). */
	movePass(passId: string, x: number, y: number): void {
		const pass = this.passById(passId);
		if (!pass) return;
		pass.x = x;
		pass.y = y;
		this.commit("Move pass", `move:${passId}`, true);
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
		// detach from any pass channel using it (image or video)
		for (const p of this.project.passes) {
			p.channels.forEach((ch, i) => {
				if ((ch.kind === "image" || ch.kind === "video") && ch.assetId === id) this.setPassChannel(p.id, i, { kind: "none", assetId: undefined });
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
		// History is per-project: starting fresh on the adopted project's state.
		this.history?.reset(this.snapshot());
	}

	async newProject(defaultShaderSource: string): Promise<void> {
		await this.saveProjectNow();
		this.adoptProject(makeProject("Untitled shader", defaultShaderSource));
		await db.saveProject(this.project);
		this.refreshProjectList(await db.loadProjects());
		this.applyProjectToRenderer();
		this.emit("project", this.project);
	}

	/** Clone the current project (passes, channels, uniforms, conversation) into a
	 * new independent project and switch to it. Pass ids are remapped so the copy
	 * shares no state with the original; image assets are referenced by id from
	 * the shared library, so they need no copy. */
	async duplicateProject(): Promise<void> {
		await this.saveProjectNow();
		const copy = cloneProjectAsNew(this.project, uniqueProjectName(this.projects, this.project.name));
		await db.saveProject(copy);
		this.adoptProject(copy);
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
		this.commit("Rename shader", "projname");
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

/** Deep-clone a project into a brand-new one: fresh project + pass ids (with all
 * outputPassId / channel passId references remapped onto the new ids), fresh
 * timestamps, and the given name. */
function cloneProjectAsNew(src: Project, name: string): Project {
	const clone = structuredClone(src);
	const idMap = new Map<string, string>();
	for (const pass of clone.passes) {
		const fresh = uid("pass_");
		idMap.set(pass.id, fresh);
		pass.id = fresh;
	}
	for (const pass of clone.passes) {
		for (const ch of pass.channels) {
			if (ch.kind === "pass" && ch.passId) ch.passId = idMap.get(ch.passId) ?? ch.passId;
		}
	}
	const now = Date.now();
	return {
		...clone,
		id: uid("p_"),
		name,
		outputPassId: idMap.get(src.outputPassId) ?? clone.passes[clone.passes.length - 1].id,
		createdAt: now,
		updatedAt: now,
	};
}

/** "Foo" -> "Foo copy" -> "Foo copy 2" ..., stripping an existing copy suffix so
 * duplicating a copy doesn't pile up ("Foo copy" -> "Foo copy 2", not "copy copy"). */
function uniqueProjectName(existing: Array<{ name: string }>, base: string): string {
	const root = base.replace(/ copy(?: \d+)?$/i, "").trim() || "Untitled shader";
	const taken = (n: string) => existing.some((p) => p.name.toLowerCase() === n.toLowerCase());
	if (!taken(`${root} copy`)) return `${root} copy`;
	let i = 2;
	while (taken(`${root} copy ${i}`)) i++;
	return `${root} copy ${i}`;
}

function uniquePassName(passes: Pass[], base: string, exceptId?: string): string {
	const trimmed = base.trim() || "Pass";
	const taken = (n: string) => passes.some((p) => p.id !== exceptId && p.name.toLowerCase() === n.toLowerCase());
	if (!taken(trimmed)) return trimmed;
	let i = 2;
	while (taken(`${trimmed} ${i}`)) i++;
	return `${trimmed} ${i}`;
}
