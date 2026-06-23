// Central application store. Owns settings, the current project (a back-to-front
// stack of layers, each its own render graph plus geometry), the asset library,
// and the renderer, and is the single place that mutates state + persists it.
// Also implements tool execution for the agent.

import type { Channel, ImageAsset, Layer, Pass, PassFormat, Project, Settings, Shape, ShapeKind, Uniform } from "./types.ts";
import { channelsForSource, ensureMaskCompositePass, makeCompositeLayer, makeMaskLayer, makePass, makeShape, removeMaskCompositePass } from "./types.ts";
import { shapeDef } from "../gl/shapes.ts";
import { extractUniformDeclarations } from "../gl/wrapper.ts";
import { getTool, text } from "../ai/tools/index.ts";
import { buildCompactedMessages, shouldCompact, summarizeConversation } from "../ai/compact.ts";
import type { ShotBlock, ToolContext, ToolResult } from "../ai/tools/types.ts";
import { Renderer } from "../gl/renderer.ts";
import type { CompileResult } from "../gl/renderer.ts";
import { db, getCurrentProjectId, importBundle, loadSettingsRaw, requestPersistence, saveSettings, setCurrentProjectId } from "./persist.ts";
import { DEFAULT_SETTINGS, makeProject, mergeSettings } from "./defaults.ts";
import { History } from "./history.ts";
import { applyLayout } from "../util/graphlayout.ts";
import { debounce, uid } from "../util/misc.ts";
import { loadImageEl, requestWebcam, stopStream } from "../util/media.ts";

type EventName = "project" | "projects" | "settings" | "assets" | "compile" | "busy" | "stats" | "toolActivity" | "selectedPass" | "selectedLayer" | "selectedShape" | "history" | "restore";

/** The slice of a Project that undo/redo restores: the visible/editable state
 * (name, layer stack, uniforms). The conversation log and identity/timestamps
 * are intentionally excluded -- you don't "undo" the chat history, and ids must
 * stay stable. Snapshots are deep-cloned on the way in and out. */
interface ProjectSnapshot {
	name: string;
	layers: Layer[];
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
	/** Per-pass compile results, keyed by pass id (across all layers). */
	passCompiles = new Map<string, CompileResult>();
	/** Which layer the editor is focused on (its graph fills the Code/Passes tabs). */
	selectedLayerId = "";
	/** Which pass (within the active layer) the editor/inspector is focused on. */
	selectedPassId = "";
	/** Which shape (in the active layer) is selected for direct manipulation on the
	 * canvas, or "" for none. Cleared when the active layer changes. */
	selectedShapeId = "";
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
		this.resetSelection();
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

	// ---- layer / pass helpers ----------------------------------------------

	get layers(): Layer[] {
		return this.project.layers;
	}
	/** Visit every layer in the document, recursing into masks. */
	private eachLayer(fn: (l: Layer) => void): void {
		const walk = (l: Layer): void => {
			fn(l);
			if (l.mask) walk(l.mask);
		};
		for (const l of this.project.layers) walk(l);
	}
	layerById(id: string): Layer | undefined {
		let found: Layer | undefined;
		this.eachLayer((l) => {
			if (l.id === id) found = l;
		});
		return found;
	}
	/** The stack layer that owns `layerId` as its mask, if any. */
	maskOwner(layerId: string): Layer | undefined {
		return this.project.layers.find((l) => l.mask?.id === layerId);
	}
	/** The layer whose graph is currently being edited (top layer by default). */
	activeLayer(): Layer {
		return this.layerById(this.selectedLayerId) ?? this.project.layers[this.project.layers.length - 1];
	}
	layerOfPass(passId: string): Layer | undefined {
		let found: Layer | undefined;
		this.eachLayer((l) => {
			if (l.passes.some((p) => p.id === passId)) found = l;
		});
		return found;
	}
	passById(id: string): Pass | undefined {
		let found: Pass | undefined;
		this.eachLayer((l) => {
			const p = l.passes.find((x) => x.id === id);
			if (p) found = p;
		});
		return found;
	}
	/** Find a pass by name within a layer (pass names are unique per layer). */
	passByNameIn(layer: Layer, name: string): Pass | undefined {
		const n = name.toLowerCase();
		return layer.passes.find((p) => p.name.toLowerCase() === n);
	}
	selectedPass(): Pass {
		const layer = this.activeLayer();
		const p = layer.passes.find((x) => x.id === this.selectedPassId);
		return p ?? layer.passes.find((x) => x.id === layer.outputPassId) ?? layer.passes[0];
	}

	/** Point the selection at a valid (layer, pass) -- top layer, its output pass. */
	private resetSelection(): void {
		const layer = this.project.layers[this.project.layers.length - 1];
		this.selectedLayerId = layer?.id ?? "";
		this.selectedPassId = layer?.outputPassId ?? "";
		this.selectedShapeId = "";
	}

	/** True if a shape with the given id exists in the active layer. */
	private shapeInActiveLayer(shapeId: string): boolean {
		return this.activeLayer()?.shapes.some((s) => s.id === shapeId) ?? false;
	}

	selectLayer(id: string): void {
		const layer = this.layerById(id);
		if (!layer || id === this.selectedLayerId) return;
		this.selectedLayerId = id;
		this.selectedPassId = layer.outputPassId;
		this.clearShapeSelection();
		this.emit("selectedLayer", id);
		this.emit("selectedPass", this.selectedPassId);
	}

	/** Select a shape (in the active layer) for canvas direct-manipulation. */
	selectShape(shapeId: string): void {
		if (this.selectedShapeId === shapeId) return;
		this.selectedShapeId = shapeId;
		this.emit("selectedShape", shapeId);
	}
	clearShapeSelection(): void {
		if (!this.selectedShapeId) return;
		this.selectedShapeId = "";
		this.emit("selectedShape", "");
	}

	selectPass(id: string): void {
		const layer = this.layerOfPass(id);
		if (!layer) return;
		const changedLayer = layer.id !== this.selectedLayerId;
		if (id === this.selectedPassId && !changedLayer) return;
		this.selectedLayerId = layer.id;
		this.selectedPassId = id;
		if (changedLayer) this.emit("selectedLayer", layer.id);
		this.emit("selectedPass", id);
	}

	// ---- renderer application ----------------------------------------------

	private applyProjectToRenderer(): void {
		this.syncUniformInputsFromSources();
		this.passCompiles = this.renderer.setDocument(this.project.layers, this.project.uniforms);
		this.lastCompile = this.aggregateCompile();
		this.emit("compile", this.lastCompile);
		this.eachLayer((layer) => {
			for (const pass of layer.passes) for (let i = 0; i < pass.channels.length; i++) void this.applyChannel(pass.id, i);
		});
	}

	private aggregateCompile(): CompileResult {
		const fails: string[] = [];
		this.eachLayer((layer) => {
			for (const pass of layer.passes) {
				const c = this.passCompiles.get(pass.id);
				if (c && !c.ok) fails.push(`[${layer.name}/${pass.name}]\n${c.log}`);
			}
		});
		return fails.length ? { ok: false, log: fails.join("\n\n") } : { ok: true, log: "" };
	}

	/** Compile result for a specific pass (used by the per-pass editor log). */
	compileFor(passId: string): CompileResult | null {
		return this.passCompiles.get(passId) ?? null;
	}

	private syncUniformInputsFromSources(): boolean {
		const declared: Uniform[] = [];
		const seen = new Set<string>();
		this.eachLayer((layer) => {
			for (const pass of layer.passes) {
				for (const u of extractUniformDeclarations(pass.source)) {
					if (seen.has(u.name)) continue;
					seen.add(u.name);
					declared.push(u);
				}
			}
		});
		const previous = new Map(this.project.uniforms.map((u) => [u.name, u]));
		const next = declared.map((u) => {
			const prev = previous.get(u.name);
			if (!prev) return u;
			const type = prev.type === "color" && u.type === "vec3" ? "color" : u.type;
			const length = type === "float" ? 1 : type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
			const value = prev.value.slice(0, length);
			while (value.length < length) value.push(0);
			return { ...u, type, value, min: prev.min, max: prev.max, step: prev.step, label: prev.label };
		});
		if (!uniformListsEqual(this.project.uniforms, next)) {
			this.project.uniforms = next;
			return true;
		}
		return false;
	}

	private async applyChannel(passId: string, index: number): Promise<void> {
		const pass = this.passById(passId);
		if (!pass) return;
		const ch = pass.channels[index];
		if (ch.kind === "none") {
			this.renderer.disconnectInput(passId, index);
		} else if (ch.kind === "under" || ch.kind === "geometry" || ch.kind === "mask") {
			this.renderer.connectAmbientInput(passId, index, ch.kind, ch.filter, ch.wrap);
		} else if (ch.kind === "builtin" && ch.builtin) {
			this.renderer.connectBuiltinInput(passId, index, ch.builtin, ch.filter, ch.wrap);
		} else if (ch.kind === "pass" && ch.passId) {
			this.renderer.connectPassInput(passId, index, ch.passId, ch.filter, ch.wrap);
		} else if (ch.kind === "image" && ch.assetId) {
			const asset = this.assets.find((a) => a.id === ch.assetId);
			if (!asset) {
				this.renderer.disconnectInput(passId, index);
				return;
			}
			try {
				const img = await loadImageEl(asset.dataUrl);
				this.renderer.connectImageInput(passId, index, img, img.naturalWidth, img.naturalHeight, ch.filter, ch.wrap);
			} catch {
				this.renderer.disconnectInput(passId, index);
			}
		} else if (ch.kind === "video" && ch.assetId) {
			const asset = this.assets.find((a) => a.id === ch.assetId);
			if (!asset) {
				this.renderer.disconnectInput(passId, index);
				return;
			}
			// Idempotent: the renderer keeps the playing clip when the key matches,
			// so re-applying on an unrelated edit doesn't restart playback.
			this.renderer.connectVideoInput(passId, index, asset.dataUrl, asset.id, ch.filter, ch.wrap);
		} else if (ch.kind === "webcam") {
			// Already streaming? Refresh filter/wrap instead of re-acquiring the camera.
			if (this.renderer.dynamicKey(passId, index) === "webcam") {
				this.renderer.setInputParams(passId, index, ch.filter, ch.wrap);
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
				this.renderer.connectWebcamInput(passId, index, stream, cur.filter, cur.wrap);
			} catch {
				this.renderer.disconnectInput(passId, index); // permission denied / no camera
			}
		} else {
			this.renderer.disconnectInput(passId, index);
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
		return { name: this.project.name, layers: this.project.layers, uniforms: this.project.uniforms };
	}

	/** Record the just-applied mutation into history. Call AFTER mutating
	 * `this.project`. `tag` groups same-kind edits for coalescing. */
	private commit(label: string, tag: string, coalesce = false): void {
		this.history.commit(this.snapshot(), label, tag, coalesce);
	}

	/** Restore a snapshot (from undo/redo) into the live project + renderer. */
	private applySnapshot(s: ProjectSnapshot): void {
		this.project.name = s.name;
		this.project.layers = structuredClone(s.layers);
		this.project.uniforms = structuredClone(s.uniforms);
		if (!this.layerById(this.selectedLayerId) || !this.passById(this.selectedPassId)) this.resetSelection();
		if (this.selectedShapeId && !this.shapeInActiveLayer(this.selectedShapeId)) this.selectedShapeId = "";
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedLayer", this.selectedLayerId);
		this.emit("selectedPass", this.selectedPassId);
		this.emit("selectedShape", this.selectedShapeId);
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

	/** Compact the conversation: replace the history with an AI-written summary so
	 * the context window (and per-turn cost) drops. The model call is the caller's
	 * to gate (busy/abort live in the chat, like an agent turn); this just does the
	 * summarize-and-replace and persists. Throws on a provider/network error. */
	async compactConversation(signal?: AbortSignal): Promise<{ ok: boolean; error?: string; before: number; after: number }> {
		const before = this.project.messages.length;
		if (!shouldCompact(this.project.messages)) return { ok: false, error: "Not enough conversation to compact yet.", before, after: before };
		const { summary } = await summarizeConversation(this.settings, this.project.messages, { signal });
		// A mid-stream Stop can return partial text instead of throwing -- don't
		// replace the conversation if the user cancelled.
		if (signal?.aborted) return { ok: false, error: "Compaction cancelled.", before, after: before };
		this.project.messages = buildCompactedMessages(summary);
		this.commitMessages();
		return { ok: true, before, after: this.project.messages.length };
	}

	/** Edit one pass's source (recompiles just that pass). */
	setPassSource(passId: string, src: string, compile = true): CompileResult {
		const pass = this.passById(passId);
		if (!pass) return { ok: true, log: "" };
		const prevChannels = pass.channels;
		pass.source = src;
		const inferred = channelsForSource(src).slice(0, this.renderer.maxInputs());
		const inputsChanged = inferred.length !== prevChannels.length;
		pass.channels = inferred.map((ch, i) => prevChannels[i] ?? ch);
		const uniformsChanged = this.syncUniformInputsFromSources();
		if (compile) {
			if (inputsChanged || uniformsChanged) {
				this.applyProjectToRenderer();
			} else {
				this.passCompiles.set(passId, this.renderer.setPassSource(passId, src));
				this.lastCompile = this.aggregateCompile();
				this.emit("compile", this.lastCompile);
			}
		}
		this.emit("project", this.project);
		this.commit(`Edit ${pass.name} code`, `code:${passId}`, true);
		this.touch();
		return this.passCompiles.get(passId) ?? { ok: true, log: "" };
	}

	setUniforms(uniforms: Uniform[]): CompileResult {
		this.project.uniforms = uniforms;
		// Declarations changed -> every pass header changes, so recompile all.
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.commit("Edit uniforms", "uniforms");
		this.touch();
		return this.lastCompile ?? { ok: true, log: "" };
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

	connectPin(passId: string, index: number, patch: Partial<Channel>): void {
		const pass = this.passById(passId);
		if (!pass || index < 0 || index >= pass.channels.length || index >= this.renderer.maxInputs()) return;
		const prev = pass.channels[index];
		const next = { ...prev, ...patch };
		pass.channels[index] = next;
		const sourceSame = prev.kind === next.kind && prev.assetId === next.assetId && prev.builtin === next.builtin && prev.passId === next.passId;
		if (sourceSame && next.kind !== "none") {
			// Only filter/wrap changed -> cheap update (no image reload, no clip
			// restart, no webcam re-acquire).
			this.renderer.setInputParams(passId, index, next.filter, next.wrap);
		} else {
			void this.applyChannel(passId, index);
		}
		// A changed pass->pass edge reshapes the graph: re-arrange it.
		if (!sourceSame && (prev.kind === "pass" || next.kind === "pass")) {
			const layer = this.layerOfPass(passId);
			if (layer) applyLayout(layer);
		}
		this.emit("project", this.project);
		this.commit(`Set ${pass.name} iChannel${index}`, `channel:${passId}:${index}`);
		this.touch();
	}

	// ---- pass graph mutations (within a layer) ------------------------------

	addPass(name: string, source = "", format: PassFormat = "rgba8", layerId?: string): Pass {
		const layer = (layerId && this.layerById(layerId)) || this.activeLayer();
		// Position is owned by the auto-layout below, so makePass's default x/y is
		// just a placeholder until applyLayout re-places every node by dependency.
		const pass = makePass(uniquePassName(layer.passes, name), source);
		pass.format = format;
		layer.passes.unshift(pass);
		applyLayout(layer);
		this.selectedLayerId = layer.id;
		this.selectedPassId = pass.id;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedPass", pass.id);
		this.commit(`Add pass "${pass.name}"`, "addpass");
		this.touch();
		return pass;
	}

	removePass(passId: string): { ok: boolean; error?: string } {
		const layer = this.layerOfPass(passId);
		if (!layer) return { ok: false, error: "No such pass." };
		if (layer.passes.length <= 1) return { ok: false, error: "Cannot remove a layer's only pass." };
		const idx = layer.passes.findIndex((p) => p.id === passId);
		const removedName = layer.passes[idx].name;
		layer.passes.splice(idx, 1);
		// Detach any channel (in this layer) referencing the removed pass.
		for (const p of layer.passes) {
			p.channels.forEach((c, i) => {
				if (c.kind === "pass" && c.passId === passId) p.channels[i] = { ...c, kind: "none", passId: undefined };
			});
		}
		if (layer.outputPassId === passId) layer.outputPassId = layer.passes[layer.passes.length - 1].id;
		if (this.selectedPassId === passId) this.selectedPassId = layer.outputPassId;
		applyLayout(layer);
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedPass", this.selectedPassId);
		this.commit(`Remove pass "${removedName}"`, "removepass");
		this.touch();
		return { ok: true };
	}

	renamePass(passId: string, name: string): void {
		const layer = this.layerOfPass(passId);
		const pass = layer?.passes.find((p) => p.id === passId);
		if (!layer || !pass) return;
		pass.name = uniquePassName(layer.passes, name, passId);
		this.emit("project", this.project);
		this.commit(`Rename pass to "${pass.name}"`, `renamepass:${passId}`);
		this.touch();
	}

	setOutputPass(passId: string): void {
		const layer = this.layerOfPass(passId);
		if (!layer) return;
		layer.outputPassId = passId;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.commit("Set layer output pass", `output:${layer.id}`);
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


	// ---- layer stack mutations ---------------------------------------------

	/** Add a new layer ON TOP of the stack (drawn last/front). Defaults to a ready
	 * "Composite" layer wired under->iChannel0, geometry->iChannel1 (source-over). */
	addLayer(name = "Layer", shapes: Shape[] = []): Layer {
		const layer = makeCompositeLayer(uniqueLayerName(this.project.layers, name), shapes);
		this.project.layers.push(layer);
		this.selectedLayerId = layer.id;
		this.selectedPassId = layer.outputPassId;
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedLayer", layer.id);
		this.emit("selectedPass", layer.outputPassId);
		this.commit(`Add layer "${layer.name}"`, "addlayer");
		this.touch();
		return layer;
	}

	removeLayer(layerId: string): { ok: boolean; error?: string } {
		if (this.project.layers.length <= 1) return { ok: false, error: "Cannot remove the only layer." };
		const idx = this.project.layers.findIndex((l) => l.id === layerId);
		if (idx === -1) return { ok: false, error: "No such layer." };
		const name = this.project.layers[idx].name;
		this.project.layers.splice(idx, 1);
		if (this.selectedLayerId === layerId) this.resetSelection();
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedLayer", this.selectedLayerId);
		this.emit("selectedPass", this.selectedPassId);
		this.commit(`Remove layer "${name}"`, "removelayer");
		this.touch();
		return { ok: true };
	}

	/** Move a layer to a new index in the stack (0 = bottom/back). */
	reorderLayer(layerId: string, toIndex: number): void {
		const from = this.project.layers.findIndex((l) => l.id === layerId);
		if (from === -1) return;
		const to = Math.max(0, Math.min(this.project.layers.length - 1, toIndex));
		if (to === from) return;
		const [layer] = this.project.layers.splice(from, 1);
		this.project.layers.splice(to, 0, layer);
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.commit(`Reorder layer "${layer.name}"`, "reorderlayer");
		this.touch();
	}

	renameLayer(layerId: string, name: string): void {
		const layer = this.layerById(layerId);
		if (!layer) return;
		layer.name = uniqueLayerName(this.project.layers, name, layerId);
		this.emit("project", this.project);
		this.commit(`Rename layer to "${layer.name}"`, `renamelayer:${layerId}`);
		this.touch();
	}

	setLayerVisible(layerId: string, visible: boolean): void {
		const layer = this.layerById(layerId);
		if (!layer || layer.visible === visible) return;
		layer.visible = visible;
		this.renderer.setLayerProps(layerId, { visible });
		this.emit("project", this.project);
		this.commit(`${visible ? "Show" : "Hide"} layer "${layer.name}"`, `vis:${layerId}`);
		this.touch();
	}

	setLayerOpacity(layerId: string, opacity: number, live = false): void {
		const layer = this.layerById(layerId);
		if (!layer) return;
		layer.opacity = Math.max(0, Math.min(1, opacity));
		this.renderer.setLayerProps(layerId, { opacity: layer.opacity });
		// A live slider drag must NOT emit "project" -- that would rebuild the
		// Layers panel mid-drag and destroy the slider being held. The renderer is
		// already updated; programmatic (AI) calls emit so the panel refreshes.
		if (!live) this.emit("project", this.project);
		this.commit(`Set "${layer.name}" opacity`, `opacity:${layerId}`, true);
		this.touch();
	}

	// ---- layer masks --------------------------------------------------------

	/** Add a mask to a layer (or focus the existing one) and make it active for
	 * editing. The mask is seeded with a soft radial circle so it does something
	 * visible immediately. */
	addMask(layerId: string): Layer | null {
		const layer = this.layerById(layerId);
		if (!layer) return null;
		if (!layer.mask) layer.mask = makeMaskLayer([makeShape("circle", { w: 0.6, h: 0.6, falloff: 1 })]);
		ensureMaskCompositePass(layer);
		applyLayout(layer);
		const mask = layer.mask;
		this.applyProjectToRenderer();
		// Edit the mask: make it the active layer + select its first shape.
		this.selectedLayerId = mask.id;
		this.selectedPassId = mask.outputPassId;
		this.selectedShapeId = mask.shapes[0]?.id ?? "";
		this.emit("project", this.project);
		this.emit("selectedLayer", mask.id);
		this.emit("selectedShape", this.selectedShapeId);
		this.commit(`Add mask to "${layer.name}"`, "addmask");
		this.touch();
		return mask;
	}

	removeMask(layerId: string): void {
		// Accept either the masked layer or the mask itself.
		const layer = this.maskOwner(layerId) ?? this.layerById(layerId);
		if (!layer || !layer.mask) return;
		layer.mask = undefined;
		removeMaskCompositePass(layer);
		applyLayout(layer);
		// If we were editing the now-removed mask, fall back to the owner layer.
		if (!this.layerById(this.selectedLayerId)) {
			this.selectedLayerId = layer.id;
			this.selectedPassId = layer.outputPassId;
			this.selectedShapeId = "";
		} else if (!this.passById(this.selectedPassId)) {
			this.selectedPassId = this.activeLayer().outputPassId;
		}
		this.applyProjectToRenderer();
		this.emit("project", this.project);
		this.emit("selectedLayer", this.selectedLayerId);
		this.emit("selectedPass", this.selectedPassId);
		this.emit("selectedShape", this.selectedShapeId);
		this.commit(`Remove mask from "${layer.name}"`, "removemask");
		this.touch();
	}

	// ---- shape (geometry) mutations ----------------------------------------

	addShape(layerId: string, kind: ShapeKind, patch: Partial<Shape> = {}): Shape | null {
		const layer = this.layerById(layerId);
		if (!layer) return null;
		const shape = makeShape(kind, { ...(shapeDef(kind)?.defaults ?? {}), ...patch });
		layer.shapes.push(shape);
		this.renderer.setLayerShapes(layerId, layer.shapes);
		// Auto-select the new shape so its canvas handles appear immediately (only
		// when it lands in the active layer; otherwise selection would be invalid).
		if (layerId === this.activeLayer().id) this.selectedShapeId = shape.id;
		this.emit("project", this.project);
		this.emit("selectedShape", this.selectedShapeId);
		this.commit(`Add ${kind} to "${layer.name}"`, "addshape");
		this.touch();
		return shape;
	}

	updateShape(layerId: string, shapeId: string, patch: Partial<Shape>, coalesce = false): void {
		const layer = this.layerById(layerId);
		const shape = layer?.shapes.find((s) => s.id === shapeId);
		if (!layer || !shape) return;
		Object.assign(shape, patch);
		this.renderer.setLayerShapes(layerId, layer.shapes);
		// `coalesce` marks a live drag/type from the shape editor: skip the
		// "project" emit so the panel isn't rebuilt mid-gesture (it would steal
		// focus / interrupt the drag). One-shot/AI edits emit so the fields refresh.
		if (!coalesce) this.emit("project", this.project);
		this.commit(`Edit shape in "${layer.name}"`, `shape:${shapeId}`, coalesce);
		this.touch();
	}

	removeShape(layerId: string, shapeId: string): void {
		const layer = this.layerById(layerId);
		if (!layer) return;
		const idx = layer.shapes.findIndex((s) => s.id === shapeId);
		if (idx === -1) return;
		layer.shapes.splice(idx, 1);
		if (this.selectedShapeId === shapeId) this.selectedShapeId = "";
		this.renderer.setLayerShapes(layerId, layer.shapes);
		this.emit("project", this.project);
		this.emit("selectedShape", this.selectedShapeId);
		this.commit(`Remove shape from "${layer.name}"`, "removeshape");
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
		for (const layer of this.project.layers) {
			for (const p of layer.passes) {
				p.channels.forEach((ch, i) => {
					if ((ch.kind === "image" || ch.kind === "video") && ch.assetId === id) this.connectPin(p.id, i, { kind: "none", assetId: undefined });
				});
			}
		}
		this.emit("assets", this.assets);
	}

	/** Rename a library asset. Channels reference assets by id, so existing
	 * bindings are unaffected; the name is how the AI addresses it (asset:<name>). */
	renameAsset(id: string, name: string): void {
		const asset = this.assets.find((a) => a.id === id);
		const trimmed = name.trim();
		if (!asset || !trimmed || asset.name === trimmed) return;
		asset.name = trimmed;
		void db.saveAsset(asset);
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
		this.resetSelection();
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

	/** Clone the current project (layers, passes, channels, geometry, uniforms,
	 * conversation) into a new independent project and switch to it. Layer/pass/
	 * shape ids are remapped so the copy shares no state with the original; image
	 * assets are referenced by id from the shared library, so they need no copy. */
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
		const parts: string[] = [];
		if (stats.layers > 1) parts.push(`${stats.layers} layers`);
		if (stats.passes > 1) parts.push(`${stats.passes} passes`);
		const note = parts.length ? ` (${parts.join(", ")})` : "";
		if (withImage || this.settings.autoScreenshot) {
			const shot = this.screenshotBlock();
			return { content: [text(`${okPrefix} Rendered ${stats.width}x${stats.height}${note}, t=${stats.time.toFixed(2)}s. ${shot._avg}. Current frame:`), { type: "image", mediaType: shot.mediaType, data: shot.data }] };
		}
		return { content: [text(`${okPrefix} Rendered ${stats.width}x${stats.height}${note}. (No preview attached — set screenshot:true or call capture_screenshot if you want to see the render.)`)] };
	}

	// ---- tool execution: dispatch to the registry via a ToolContext ----------

	private toolContext(): ToolContext {
		return {
			settings: this.settings,
			project: this.project,
			assets: this.assets,
			renderer: this.renderer,
			layers: () => this.project.layers,
			activeLayerId: () => this.activeLayer().id,
			resolveLayer: (nameOrId) => this.resolveLayer(nameOrId),
			passes: () => this.activeLayer().passes,
			outputPassId: () => this.activeLayer().outputPassId,
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
			connectPin: (id, i, p) => this.connectPin(id, i, p),
			addLayer: (name, shapes) => this.addLayer(name, shapes),
			removeLayer: (id) => this.removeLayer(id),
			renameLayerById: (id, name) => this.renameLayer(id, name),
			reorderLayer: (id, to) => this.reorderLayer(id, to),
			setLayerVisible: (id, v) => this.setLayerVisible(id, v),
			setLayerOpacity: (id, o) => this.setLayerOpacity(id, o),
			addMask: (id) => this.addMask(id),
			removeMask: (id) => this.removeMask(id),
			selectLayer: (id) => this.selectLayer(id),
			addShape: (layerId, kind, patch) => this.addShape(layerId, kind, patch),
			updateShape: (layerId, shapeId, patch) => this.updateShape(layerId, shapeId, patch),
			removeShape: (layerId, shapeId) => this.removeShape(layerId, shapeId),
			renameProject: (n) => this.renameProject(n),
			addAsset: (a) => this.addAsset(a),
			screenshotBlock: () => this.screenshotBlock(),
			shaderResult: (p, w) => this.shaderResult(p, w),
			compileError: () => (this.lastCompile && !this.lastCompile.ok ? this.lastCompile.log : null),
		};
	}

	/** Resolve a layer by id or name; default (no arg) = the active layer. */
	private resolveLayer(nameOrId?: string): Layer | null {
		if (!nameOrId) return this.activeLayer() ?? null;
		const n = nameOrId.toLowerCase();
		return this.layerById(nameOrId) ?? this.project.layers.find((l) => l.name.toLowerCase() === n) ?? null;
	}

	/** Resolve a pass by id or name within the active layer; default = the active
	 * layer's output pass. Falls back to a global id/name match. */
	private resolvePass(nameOrId?: string): Pass | null {
		const layer = this.activeLayer();
		if (!nameOrId) return layer.passes.find((p) => p.id === layer.outputPassId) ?? layer.passes[0] ?? null;
		return this.passById(nameOrId) ?? this.passByNameIn(layer, nameOrId) ?? this.passByNameAnywhere(nameOrId) ?? null;
	}

	private passByNameAnywhere(name: string): Pass | undefined {
		const n = name.toLowerCase();
		for (const l of this.project.layers) {
			const p = l.passes.find((x) => x.name.toLowerCase() === n);
			if (p) return p;
		}
		return undefined;
	}

	async applyTool(name: string, input: unknown): Promise<ToolResult> {
		this.emit("toolActivity", { name });
		const tool = getTool(name);
		if (!tool) return { content: [text(`Unknown tool: ${name}`)], isError: true };
		return tool.execute(this.toolContext(), (input ?? {}) as Record<string, unknown>);
	}
}

/** Deep-clone a project into a brand-new one: fresh project + layer + pass + shape
 * ids (with all outputPassId / channel passId references remapped onto the new
 * pass ids), fresh timestamps, and the given name. */
function remapLayerIds(layer: Layer): void {
	layer.id = uid("layer_");
	const idMap = new Map<string, string>();
	for (const pass of layer.passes) {
		const fresh = uid("pass_");
		idMap.set(pass.id, fresh);
		pass.id = fresh;
	}
	for (const pass of layer.passes) {
		for (const ch of pass.channels) {
			if (ch.kind === "pass" && ch.passId) ch.passId = idMap.get(ch.passId) ?? ch.passId;
		}
	}
	layer.outputPassId = idMap.get(layer.outputPassId) ?? layer.passes[layer.passes.length - 1].id;
	for (const shape of layer.shapes) shape.id = uid("shape_");
	if (layer.mask) remapLayerIds(layer.mask);
}

function cloneProjectAsNew(src: Project, name: string): Project {
	const clone = structuredClone(src);
	for (const layer of clone.layers) remapLayerIds(layer);
	const now = Date.now();
	return { ...clone, id: uid("p_"), name, createdAt: now, updatedAt: now };
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

function uniformListsEqual(a: Uniform[], b: Uniform[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.name !== y.name || x.type !== y.type || x.min !== y.min || x.max !== y.max || x.step !== y.step || x.label !== y.label) return false;
		if (x.value.length !== y.value.length) return false;
		for (let j = 0; j < x.value.length; j++) if (x.value[j] !== y.value[j]) return false;
	}
	return true;
}

function uniquePassName(passes: Pass[], base: string, exceptId?: string): string {
	const trimmed = base.trim() || "Pass";
	const taken = (n: string) => passes.some((p) => p.id !== exceptId && p.name.toLowerCase() === n.toLowerCase());
	if (!taken(trimmed)) return trimmed;
	let i = 2;
	while (taken(`${trimmed} ${i}`)) i++;
	return `${trimmed} ${i}`;
}

function uniqueLayerName(layers: Layer[], base: string, exceptId?: string): string {
	const trimmed = base.trim() || "Layer";
	const taken = (n: string) => layers.some((l) => l.id !== exceptId && l.name.toLowerCase() === n.toLowerCase());
	if (!taken(trimmed)) return trimmed;
	let i = 2;
	while (taken(`${trimmed} ${i}`)) i++;
	return `${trimmed} ${i}`;
}
