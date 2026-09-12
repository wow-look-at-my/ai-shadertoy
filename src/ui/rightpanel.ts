// Right-hand editor panel. Tabs: Layers (the back-to-front stack + per-layer
// geometry), the per-pass shader Code editor, the Passes render-graph (auto-laid-out
// pass nodes wired by their channel inputs), live Uniform controls (shared across
// passes), the iChannel texture bindings for the selected pass, and Assets (the
// shared media library -- upload images/videos for the AI to bind). All edits flow
// through the store.

import { el, render } from "../util/dom.ts";
import { icon } from "../util/icons.ts";
import { copyText, debounce, formatBytes, pickFile, pickFiles, uid } from "../util/misc.ts";
import { formatUniformDeclarations } from "../gl/wrapper.ts";
import { fileToDataUrl, loadImageEl, loadVideoMeta, MAX_VIDEO_BYTES } from "../util/media.ts";
import { BUILTIN_LABELS } from "../gl/textures.ts";
import { SHAPE_DEFS, SHAPE_LABELS } from "../gl/shapes.ts";
import { layoutGraph, type LayoutResult, type NodePos } from "./graphlayout.ts";
import type { BuiltinTexture, Channel, ImageAsset, Layer, Pass, PassFormat, Shape, Uniform, UniformType } from "../state/types.ts";
import type { Store } from "../state/store.ts";

const TABS = ["Layers", "Code", "Passes", "Uniforms", "Textures", "Assets"] as const;
type Tab = (typeof TABS)[number];

/** Pan/zoom of the Passes graph viewport. Persisted across re-renders so wiring
 * a channel or selecting a pass doesn't reset the user's view. */
interface GraphView {
	x: number;
	y: number;
	zoom: number;
}

export function createRightPanel(store: Store): HTMLElement {
	let active: Tab = "Code";
	const graphView: GraphView = { x: 0, y: 0, zoom: 1 };

	const tabBar = el("div", { class: "tabbar" });
	const body = el("div", { class: "panel-body" });

	const layersView = el("div", { class: "layers-panel" });
	const codeView = buildCodeView(store);
	const passesView = el("div", { class: "passes" });
	const uniformsView = el("div", { class: "uniforms" });
	const texturesView = el("div", { class: "textures" });
	const assetsView = el("div", { class: "assets" });
	setupAssetDrop(store, assetsView);

	const viewFor = (t: Tab): HTMLElement => (t === "Layers" ? layersView : t === "Code" ? codeView.root : t === "Passes" ? passesView : t === "Uniforms" ? uniformsView : t === "Textures" ? texturesView : assetsView);

	const renderActive = () => {
		render(tabBar, ...TABS.map((t) => el("button", { class: `tab${t === active ? " active" : ""}`, on: { click: () => select(t) } }, t)));
		render(body, viewFor(active));
		if (active === "Layers") renderLayers(store, layersView);
		if (active === "Code") codeView.syncHead();
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
		if (active === "Uniforms") renderUniforms(store, uniformsView);
		if (active === "Textures") renderTextures(store, texturesView);
		if (active === "Assets") renderAssets(store, assetsView);
	};
	const select = (t: Tab) => {
		active = t;
		renderActive();
	};

	store.on("project", () => {
		codeView.sync();
		codeView.syncHead();
		if (active === "Layers") renderLayers(store, layersView);
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
		if (active === "Uniforms") renderUniforms(store, uniformsView);
		if (active === "Textures") renderTextures(store, texturesView);
	});
	const onSelectionChange = () => {
		codeView.sync();
		codeView.syncHead();
		codeView.syncLog();
		if (active === "Layers") renderLayers(store, layersView);
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
		if (active === "Textures") renderTextures(store, texturesView);
	};
	store.on("selectedPass", onSelectionChange);
	store.on("selectedLayer", onSelectionChange);
	// Shape selection (from the canvas gizmo or a row click) only re-skins the
	// Layers tab; no need to rebuild the other tabs.
	store.on("selectedShape", () => {
		if (active === "Layers") renderLayers(store, layersView);
	});
	store.on("assets", () => {
		if (active === "Textures") renderTextures(store, texturesView);
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
		if (active === "Assets") renderAssets(store, assetsView);
	});
	store.on("compile", () => codeView.syncLog());
	// Undo/redo: the "project" handler above already refreshed the other tabs and
	// ran the focus-guarded code sync; this forces the code box to update too even
	// when it currently holds focus.
	store.on("restore", () => codeView.forceSync());

	renderActive();
	return el("section", { class: "rightpanel" }, tabBar, body);
}

// ---- code editor -----------------------------------------------------------

function buildCodeView(store: Store): { root: HTMLElement; sync: () => void; forceSync: () => void; syncLog: () => void; syncHead: () => void } {
	const head = el("div", { class: "code-head" });
	const textarea = el("textarea", { class: "code", attrs: { spellcheck: "false", wrap: "soft" } });
	textarea.value = store.selectedPass().source;

	// The pass is captured at keystroke time: the selection can change before
	// the debounce fires, and the edit must land on the pass it was typed into.
	const applyTo = debounce((passId: string, source: string) => store.setPassSource(passId, source, true), 350);
	const apply = () => applyTo(store.selectedPassId, textarea.value);
	textarea.addEventListener("input", apply);
	textarea.addEventListener("keydown", (e) => {
		if (e.key === "Tab") {
			e.preventDefault();
			// setRangeText keeps the browser's own undo stack intact.
			textarea.setRangeText("\t", textarea.selectionStart, textarea.selectionEnd, "end");
			apply();
		}
	});

	const log = el("pre", { class: "compile-log" });
	const syncLog = () => {
		const c = store.compileFor(store.selectedPassId);
		if (c && !c.ok) {
			log.textContent = c.log;
			log.hidden = false;
		} else {
			log.hidden = true;
		}
	};
	const sync = () => {
		applyTo.flush(); // a pending edit belongs to the pass it was typed into
		const src = store.selectedPass().source;
		if (document.activeElement !== textarea && textarea.value !== src) textarea.value = src;
		syncLog();
	};
	// Undo/redo changed the source: refresh the box even if it has focus (best
	// effort to keep the caret in range), which the focus-guarded sync() won't do.
	const forceSync = () => {
		const src = store.selectedPass().source;
		if (textarea.value !== src) {
			const pos = Math.min(textarea.selectionStart, src.length);
			textarea.value = src;
			try {
				textarea.setSelectionRange(pos, pos);
			} catch {
				/* detached / unsupported: ignore */
			}
		}
		syncLog();
	};
	const syncHead = () => {
		const pass = store.selectedPass();
		const layer = store.activeLayer();
		const isOutput = pass.id === layer.outputPassId;
		const passSel = el(
			"select",
			{ class: "code-pass", title: "Pass being edited (in the active layer)" },
			...layer.passes.map((p) => el("option", { value: p.id, attrs: { selected: p.id === pass.id ? "selected" : undefined } }, p.name + (p.id === layer.outputPassId ? " ★" : ""))),
		);
		passSel.addEventListener("change", () => store.selectPass(passSel.value));

		const fmtSel = el(
			"select",
			{ class: "code-fmt", title: "Render-target format" },
			...(["rgba8", "rgba16f"] as PassFormat[]).map((f) => el("option", { value: f, attrs: { selected: f === pass.format ? "selected" : undefined } }, f)),
		);
		fmtSel.addEventListener("change", () => store.setPassFormat(pass.id, fmtSel.value as PassFormat));

		const outBtn = el("button", { class: `btn tiny${isOutput ? " on" : ""}`, title: isOutput ? "This pass is shown on screen" : "Make this pass the screen output", on: { click: () => store.setOutputPass(pass.id) } }, isOutput ? "★ output" : "set output");

		render(head, el("span", { class: "code-label" }, "Pass"), passSel, fmtSel, el("span", { class: "spacer" }), outBtn);
	};

	syncHead();
	syncLog();
	return { root: el("div", { class: "code-view" }, head, textarea, log), sync, forceSync, syncLog, syncHead };
}

// ---- passes graph (the object graph) ---------------------------------------

const NODE_W = 196;
const HEADER_H = 30;
const ROW_H = 26;
const CARD_BORDER = 2; // top+bottom 1px borders, so geometry matches the rendered card
// Auto-layout spacing: the DAG is laid out left-to-right in dependency columns.
const COL_GAP = 64; // horizontal gap between columns
const ROW_GAP = 28; // vertical gap between stacked nodes in a column
const GRAPH_MARGIN = 28; // padding before the first column/row

// Per-node geometry. A node is a header plus one row per input pin (there is NO
// add-row), so the card is HEADER_H + rows*ROW_H (+ borders). The single output
// port sits at the card's vertical centre -- valid even with zero input rows, so
// it never floats off the card.
const inPortY = (i: number): number => HEADER_H + ROW_H / 2 + i * ROW_H;
const nodeHeight = (pass: Pass): number => HEADER_H + pass.channels.length * ROW_H + CARD_BORDER;
const outPortY = (pass: Pass): number => nodeHeight(pass) / 2;

/** Smooth cubic path through the given points (horizontal tangents at each),
 * chained so a routed edge threads its waypoints between the columns it spans. */
function edgePath(points: NodePos[]): string {
	let d = `M ${points[0].x} ${points[0].y}`;
	for (let k = 1; k < points.length; k++) {
		const a = points[k - 1];
		const b = points[k];
		const dx = Math.max(36, Math.abs(b.x - a.x) * 0.5);
		d += ` C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
	}
	return d;
}

/** Auto-layout the active layer's passes: a left-to-right layered DAG layout
 * derived purely from the pass->pass edges (no stored coordinates), plus routing
 * waypoints for edges that span more than one column. */
function layoutPasses(passes: Pass[]): LayoutResult {
	const nodes = passes.map((p) => ({
		id: p.id,
		deps: p.channels.filter((c) => c.kind === "pass" && c.passId).map((c) => c.passId!),
		height: nodeHeight(p),
	}));
	return layoutGraph(nodes, { nodeWidth: NODE_W, hGap: COL_GAP, vGap: ROW_GAP, margin: GRAPH_MARGIN });
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.5;
const clampZoom = (z: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Multiply zoom by `factor`, keeping the graph point under (cx,cy) (container
 * coordinates) fixed -- zoom-to-cursor. */
function zoomAt(view: GraphView, cx: number, cy: number, factor: number): void {
	const nz = clampZoom(view.zoom * factor);
	const f = nz / view.zoom;
	view.x = cx - (cx - view.x) * f;
	view.y = cy - (cy - view.y) * f;
	view.zoom = nz;
}

/** Frame all nodes within the container. */
function fitView(view: GraphView, passes: Pass[], pos: Map<string, NodePos>, graph: HTMLElement): void {
	if (!passes.length) return;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of passes) {
		const at = pos.get(p.id) ?? { x: GRAPH_MARGIN, y: GRAPH_MARGIN };
		minX = Math.min(minX, at.x);
		minY = Math.min(minY, at.y);
		maxX = Math.max(maxX, at.x + NODE_W);
		maxY = Math.max(maxY, at.y + nodeHeight(p));
	}
	const pad = 36;
	const cw = graph.clientWidth || 600;
	const ch = graph.clientHeight || 400;
	view.zoom = clampZoom(Math.min(cw / (maxX - minX + pad * 2), ch / (maxY - minY + pad * 2)));
	view.x = (cw - (minX + maxX) * view.zoom) / 2;
	view.y = (ch - (minY + maxY) * view.zoom) / 2;
}

function renderGraph(store: Store, container: HTMLElement, select: (t: Tab) => void, view: GraphView): void {
	const passes = store.activeLayer().passes;
	const layout = layoutPasses(passes);
	const at = (id: string): NodePos => layout.pos.get(id) ?? { x: GRAPH_MARGIN, y: GRAPH_MARGIN };
	const viewport = el("div", { class: "graph-viewport" });

	// Edges (SVG) behind the nodes, inside the transformed viewport. Bounds cover
	// nodes AND routing waypoints so the SVG never clips a routed edge.
	const xs = [640, ...passes.map((p) => at(p.id).x + NODE_W + 60)];
	const ys = [360, ...passes.map((p) => at(p.id).y + nodeHeight(p) + 60)];
	for (const pts of layout.routes.values()) for (const pt of pts) { xs.push(pt.x + 60); ys.push(pt.y + 60); }
	const w = Math.max(...xs);
	const h = Math.max(...ys);
	const svgNS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNS, "svg");
	svg.setAttribute("class", "graph-edges");
	svg.setAttribute("width", String(w));
	svg.setAttribute("height", String(h));

	const byId = new Map(passes.map((p) => [p.id, p]));
	const drawEdges = (): void => {
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		for (const tgt of passes) {
			const tp = at(tgt.id);
			tgt.channels.forEach((c, i) => {
				if (c.kind !== "pass" || !c.passId) return;
				const src = byId.get(c.passId);
				if (!src) return;
				const sp = at(src.id);
				const start = { x: sp.x + NODE_W, y: sp.y + outPortY(src) };
				const end = { x: tp.x, y: tp.y + inPortY(i) };
				// Thread any routing waypoints so an edge spanning >1 column bends
				// around the nodes in between instead of crossing them.
				const waypoints = layout.routes.get(`${src.id}>${tgt.id}`) ?? [];
				const path = document.createElementNS(svgNS, "path");
				path.setAttribute("d", edgePath([start, ...waypoints, end]));
				path.setAttribute("class", src.id === tgt.id ? "edge feedback" : "edge");
				svg.appendChild(path);
			});
		}
	};

	for (const pass of passes) viewport.appendChild(buildNode(store, pass, at(pass.id), select));
	viewport.insertBefore(svg, viewport.firstChild);
	drawEdges();

	const graph = el("div", { class: "graph" }, viewport);
	const zoomLabel = el("span", { class: "zoom-label" }, "100%");
	const applyTransform = (): void => {
		viewport.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
		zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
	};
	applyTransform();

	// Wheel: ctrl/cmd (incl. trackpad pinch, which browsers report as ctrl+wheel)
	// zooms to the cursor; a plain wheel / two-finger scroll pans. Non-passive so
	// preventDefault stops the browser's page zoom/scroll.
	graph.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			const rect = graph.getBoundingClientRect();
			if (e.ctrlKey || e.metaKey) {
				const dy = Math.max(-80, Math.min(80, e.deltaY));
				zoomAt(view, e.clientX - rect.left, e.clientY - rect.top, Math.exp(-dy * 0.0125));
			} else {
				const k = e.deltaMode === 1 ? 16 : 1; // line vs pixel deltas
				view.x -= e.deltaX * k;
				view.y -= e.deltaY * k;
			}
			applyTransform();
		},
		{ passive: false },
	);

	// Drag the empty background to pan (node/button/select interactions are skipped).
	graph.addEventListener("pointerdown", (e) => {
		if ((e.target as HTMLElement).closest(".graph-node")) return;
		e.preventDefault();
		const sx = e.clientX;
		const sy = e.clientY;
		const bx = view.x;
		const by = view.y;
		graph.classList.add("panning");
		const move = (ev: PointerEvent): void => {
			view.x = bx + (ev.clientX - sx);
			view.y = by + (ev.clientY - sy);
			applyTransform();
		};
		const up = (): void => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			graph.classList.remove("panning");
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	});

	const zoomBtn = (label: string, title: string, fn: () => void): HTMLElement => el("button", { class: "btn icon tiny", title, on: { click: () => { fn(); applyTransform(); } } }, label);
	const toolbar = el(
		"div",
		{ class: "graph-toolbar" },
		el("button", { class: "btn tiny", on: { click: () => store.addPass("Pass", "") } }, "+ Add pass"),
		el("span", { class: "muted small" }, `layer: ${store.activeLayer().name}`),
		el("span", { class: "muted small graph-hint" }, "auto-arranged · scroll/drag = pan · ctrl/⌘+scroll or pinch = zoom"),
		el("span", { class: "spacer" }),
		zoomBtn("−", "Zoom out", () => zoomAt(view, graph.clientWidth / 2, graph.clientHeight / 2, 1 / 1.2)),
		zoomLabel,
		zoomBtn("+", "Zoom in", () => zoomAt(view, graph.clientWidth / 2, graph.clientHeight / 2, 1.2)),
		el("button", { class: "btn tiny", title: "Fit all passes", on: { click: () => { fitView(view, passes, layout.pos, graph); applyTransform(); } } }, "Fit"),
	);

	render(container, toolbar, graph);
}

function buildNode(store: Store, pass: Pass, pos: NodePos, select: (t: Tab) => void): HTMLElement {
	const isOutput = pass.id === store.activeLayer().outputPassId;
	const selected = pass.id === store.selectedPassId;
	const node = el("div", { class: `graph-node${selected ? " selected" : ""}${isOutput ? " output" : ""}` });
	node.style.left = `${pos.x}px`;
	node.style.top = `${pos.y}px`;

	const nameEl = el("span", { class: "gn-name" }, pass.name);
	const editBtn = el("button", { class: "btn icon tiny", title: "Edit this pass's code", on: { click: () => { store.selectPass(pass.id); select("Code"); } } }, icon("wrench", { size: 13 }));
	const outBtn = el("button", { class: `btn icon tiny${isOutput ? " on" : ""}`, title: isOutput ? "Shown on screen" : "Make output", on: { click: () => store.setOutputPass(pass.id) } }, icon("eye", { size: 14 }));
	const delBtn = el("button", { class: "btn icon tiny", title: "Delete pass", on: { click: () => { const r = store.removePass(pass.id); if (!r.ok && r.error) alert(r.error); } } }, icon("close", { size: 14 }));

	const header = el("div", { class: "gn-head" }, nameEl, el("span", { class: "spacer" }), editBtn, outBtn, delBtn);
	// Nodes are auto-positioned (no dragging). Click the name/header to select the
	// pass; double-click the name to rename.
	nameEl.addEventListener("dblclick", () => beginRename(store, pass, nameEl));
	header.addEventListener("click", (e) => {
		if (e.target === nameEl || e.target === header) store.selectPass(pass.id);
	});

	const rows = pass.channels.map((_c, i) => {
		const sel = channelSelect(store, pass, i, true);
		return el("div", { class: "gn-row" }, el("span", { class: "gn-port in" }), el("span", { class: "gn-ch" }, `iCh${i}`), sel);
	});

	node.appendChild(header);
	node.appendChild(el("div", { class: "gn-body" }, ...rows));
	const out = el("span", { class: "gn-port out", title: "Output (sampled by other passes)" });
	out.style.top = `${outPortY(pass)}px`;
	node.appendChild(out);
	return node;
}

function beginRename(store: Store, pass: Pass, nameEl: HTMLElement): void {
	const input = el("input", { class: "gn-rename", type: "text", value: pass.name });
	nameEl.replaceWith(input);
	input.focus();
	input.select();
	const commit = () => {
		const v = input.value.trim();
		if (v && v !== pass.name) store.renamePass(pass.id, v);
		else input.replaceWith(nameEl); // unchanged or cleared: restore, no history entry
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") input.blur();
		if (e.key === "Escape") { input.value = pass.name; input.blur(); }
	});
	input.addEventListener("blur", commit);
}

// ---- shared channel <select> -----------------------------------------------

function channelValue(ch: Channel): string {
	if (ch.kind === "none") return "none";
	if (ch.kind === "under") return "under";
	if (ch.kind === "geometry") return "geometry";
	if (ch.kind === "mask") return "mask";
	if (ch.kind === "builtin") return `builtin:${ch.builtin}`;
	if (ch.kind === "pass") return `pass:${ch.passId}`;
	if (ch.kind === "webcam") return "webcam";
	if (ch.kind === "video") return `video:${ch.assetId}`;
	return `image:${ch.assetId}`;
}

/** Build the channel binding <select> shared by the graph nodes and the
 * Textures tab. `compact` trims labels for the narrow graph nodes. */
function channelSelect(store: Store, pass: Pass, index: number, compact: boolean): HTMLSelectElement {
	const ch = pass.channels[index];
	const value = channelValue(ch);
	// Pass sources are within the active layer (incl. this pass itself = feedback).
	const sourcePasses = store.activeLayer().passes;
	const images = store.assets.filter((a) => a.kind !== "video");
	const videos = store.assets.filter((a) => a.kind === "video");
	const opt = (v: string, label: string) => el("option", { value: v, attrs: { selected: v === value ? "selected" : undefined } }, label);
	const sel = el(
		"select",
		{ class: "ch-sel" },
		opt("none", compact ? "—" : "(empty)"),
		el("optgroup", { attrs: { label: "Layer" } }, opt("under", compact ? "Under" : "Under (layers below)"), opt("geometry", compact ? "Geometry" : "Geometry (this layer's shapes)"), opt("mask", compact ? "Mask" : "Mask (this layer's mask)")),
		opt("webcam", compact ? "Webcam" : "Webcam (live)"),
		el("optgroup", { attrs: { label: "Passes" } }, ...sourcePasses.map((p) => opt(`pass:${p.id}`, p.id === pass.id ? `${p.name} (feedback)` : p.name))),
		el("optgroup", { attrs: { label: "Built-in" } }, ...(Object.keys(BUILTIN_LABELS) as BuiltinTexture[]).map((b) => opt(`builtin:${b}`, BUILTIN_LABELS[b]))),
		el("optgroup", { attrs: { label: "Images" } }, ...images.map((a) => opt(`image:${a.id}`, a.name)), el("option", { value: "upload-image" }, "Upload image…")),
		el("optgroup", { attrs: { label: "Videos" } }, ...videos.map((a) => opt(`video:${a.id}`, a.name)), el("option", { value: "upload-video" }, "Upload video…")),
	);
	sel.addEventListener("change", () => {
		const v = sel.value;
		if (v === "none") store.connectPin(pass.id, index, { kind: "none", assetId: undefined, builtin: undefined, passId: undefined });
		else if (v === "under" || v === "geometry" || v === "mask") store.connectPin(pass.id, index, { kind: v, assetId: undefined, builtin: undefined, passId: undefined });
		else if (v === "webcam") store.connectPin(pass.id, index, { kind: "webcam", assetId: undefined, builtin: undefined, passId: undefined });
		else if (v.startsWith("pass:")) store.connectPin(pass.id, index, { kind: "pass", passId: v.slice(5), builtin: undefined, assetId: undefined });
		else if (v.startsWith("builtin:")) store.connectPin(pass.id, index, { kind: "builtin", builtin: v.slice(8) as BuiltinTexture, assetId: undefined, passId: undefined });
		else if (v === "upload-image" || v === "upload-video") {
			// A cancelled dialog leaves no new binding, so show the real one again.
			void uploadAndBind(store, pass.id, index, v === "upload-video" ? "video" : "image").then((bound) => {
				if (!bound) sel.value = value;
			});
		}
		else if (v.startsWith("image:")) store.connectPin(pass.id, index, { kind: "image", assetId: v.slice(6), builtin: undefined, passId: undefined });
		else if (v.startsWith("video:")) store.connectPin(pass.id, index, { kind: "video", assetId: v.slice(6), builtin: undefined, passId: undefined });
	});
	return sel;
}

// ---- uniforms (shared by all passes) ---------------------------------------

function renderUniforms(store: Store, container: HTMLElement): void {
	const uniforms = store.project.uniforms;
	const commit = () => store.setUniforms(structuredClone(store.project.uniforms));

	const rows = uniforms.map((u, idx) => {
		const nameInput = el("input", { class: "u-name", type: "text", value: u.name, on: { change: () => { u.name = nameInput.value; commit(); } } });
		const typeSel = el(
			"select",
			{ class: "u-type", on: { change: () => { u.type = typeSel.value as UniformType; fixLen(u); commit(); } } },
			...(["float", "vec2", "vec3", "vec4", "color"] as UniformType[]).map((t) => el("option", { value: t, attrs: { selected: t === u.type ? "selected" : undefined } }, t)),
		);

		const controls = el("div", { class: "u-controls" });
		const rebuildControls = () => render(controls, ...valueControls(store, u));
		rebuildControls();

		const minInput = numberInput(u.min, (v) => { u.min = v; commit(); });
		const maxInput = numberInput(u.max, (v) => { u.max = v; commit(); });

		return el(
			"div",
			{ class: "u-row" },
			el("div", { class: "u-head" }, nameInput, typeSel, el("button", { class: "btn icon tiny", title: "Remove", on: { click: () => { store.project.uniforms.splice(idx, 1); commit(); } } }, icon("close", { size: 15 }))),
			controls,
			u.type === "color" ? el("span", {}) : el("div", { class: "u-range" }, el("label", {}, "min", minInput), el("label", {}, "max", maxInput)),
		);
	});

	const addBtn = el("button", {
		class: "btn",
		on: {
			click: () => {
				store.project.uniforms.push({ name: uniqueName(uniforms), type: "float", value: [0.5], min: 0, max: 1, step: 0.01 });
				commit();
			},
		},
	}, "+ Add uniform");

	const copyBtn = el("button", {
		class: "btn",
		title: "Copy every uniform as GLSL declarations with their current values (paste into a shader to bake them in)",
		on: {
			click: () => {
				const label = copyBtn.textContent;
				void copyText(formatUniformDeclarations(store.project.uniforms)).then((ok) => {
					copyBtn.textContent = ok ? "Copied!" : "Copy failed";
					setTimeout(() => { copyBtn.textContent = label; }, 1200);
				});
			},
		},
	}, "Copy uniforms");

	render(
		container,
		el("p", { class: "muted small" }, "Uniforms are shared across all passes."),
		uniforms.length ? el("div", { class: "u-list" }, ...rows) : el("p", { class: "muted" }, "No custom uniforms. The AI adds these with set_uniforms, or add one below."),
		el("div", { class: "u-actions" }, addBtn, uniforms.length ? copyBtn : null),
	);
}

function valueControls(store: Store, u: Uniform): HTMLElement[] {
	if (u.type === "color") {
		const hex = rgbToHex(u.value);
		const picker = el("input", { type: "color", value: hex });
		picker.addEventListener("input", () => store.updateUniformValue(u.name, hexToRgb(picker.value)));
		return [picker];
	}
	const n = u.type === "float" ? 1 : u.type === "vec2" ? 2 : u.type === "vec3" ? 3 : 4;
	const out: HTMLElement[] = [];
	for (let i = 0; i < n; i++) {
		const slider = el("input", { type: "range", attrs: { min: u.min, max: u.max, step: u.step, value: u.value[i] ?? 0 } });
		const num = el("span", { class: "u-val" }, (u.value[i] ?? 0).toFixed(3));
		slider.addEventListener("input", () => {
			const v = u.value.slice();
			v[i] = Number((slider as HTMLInputElement).value);
			num.textContent = v[i].toFixed(3);
			store.updateUniformValue(u.name, v);
		});
		out.push(el("div", { class: "u-slider" }, slider, num));
	}
	return out;
}

function fixLen(u: Uniform): void {
	const n = u.type === "float" ? 1 : u.type === "vec2" ? 2 : u.type === "vec4" ? 4 : 3;
	while (u.value.length < n) u.value.push(0);
	u.value.length = n;
}

// ---- textures (inputs for the selected pass) -------------------------------

function renderTextures(store: Store, container: HTMLElement): void {
	const pass = store.selectedPass();
	const layer = store.activeLayer();
	const passSel = el(
		"select",
		{ class: "tex-pass", title: "Pass whose inputs you are editing (in the active layer)" },
		...layer.passes.map((p) => el("option", { value: p.id, attrs: { selected: p.id === pass.id ? "selected" : undefined } }, p.name + (p.id === layer.outputPassId ? " ★" : ""))),
	);
	passSel.addEventListener("change", () => store.selectPass(passSel.value));

	const rows = pass.channels.map((ch, i) => {
		const sel = channelSelect(store, pass, i, false);
		const filterSel = selectFrom(["linear", "nearest"], ch.filter, (val) => store.connectPin(pass.id, i, { filter: val as "linear" | "nearest" }));
		const wrapSel = selectFrom(["repeat", "clamp", "mirror"], ch.wrap, (val) => store.connectPin(pass.id, i, { wrap: val as "repeat" | "clamp" | "mirror" }));
		return el("div", { class: "ch-row" }, el("label", { class: "ch-label" }, `iChannel${i}`), sel, filterSel, wrapSel);
	});

	render(
		container,
		el("div", { class: "tex-head" }, el("span", { class: "field-label" }, "Inputs for pass"), passSel),
		pass.channels.length ? el("div", { class: "ch-list" }, ...rows) : el("p", { class: "muted small" }, "This pass has no inputs yet."),
		el("p", { class: "muted small" }, "Inputs appear automatically from iChannel references in the shader. Bind a built-in texture, an image, a video, the live webcam, or another pass's output, including this pass's own previous frame for feedback."),
	);
}

/** De-duplicate an asset name against the existing library so the AI can address
 * each asset unambiguously (connect_pins resolves asset:<name> by first match). */

/** Probe one already-chosen file's dimensions and add it to the shared asset
 * library (no channel binding). Returns the new asset, or null if it was rejected
 * (a video over the size limit). May throw if the media fails to decode. */
async function addAssetFromFile(store: Store, file: File, type: "image" | "video"): Promise<ImageAsset | null> {
	if (type === "video" && file.size > MAX_VIDEO_BYTES) {
		alert(`Video "${file.name}" is ${formatBytes(file.size)}. Please use a clip under 32 MB — short, low-resolution loops work best (everything is stored inline in your browser).`);
		return null;
	}
	const dataUrl = await fileToDataUrl(file);
	// Content de-dup: identical bytes => identical data URL. Reuse the existing
	// asset instead of storing the same media twice (so re-dropping a file, or
	// dropping one already in the library, is a no-op that still binds correctly).
	const dup = store.assets.find((a) => a.dataUrl === dataUrl);
	if (dup) return dup;
	let width: number;
	let height: number;
	if (type === "video") {
		({ width, height } = await loadVideoMeta(dataUrl));
	} else {
		const img = await loadImageEl(dataUrl);
		width = img.naturalWidth;
		height = img.naturalHeight;
	}
	const asset: ImageAsset = {
		id: uid("a_"),
		// Clean exotic characters out of the filename first (U+202F etc.), then
		// de-duplicate so the AI can address each asset unambiguously by name.
		name: file.name.replace(/\.[^.]+$/, ""), // the store sanitizes and uniquifies
		mediaType: file.type || (type === "video" ? "video/mp4" : "image/png"),
		dataUrl,
		width,
		height,
		source: "upload",
		kind: type,
	};
	store.addAsset(asset);
	return asset;
}

/** Pick a single file, probe it, and add it to the shared asset library (no
 * channel binding). Returns the new asset, or null if cancelled/rejected. */
async function pickAndAddAsset(store: Store, type: "image" | "video"): Promise<ImageAsset | null> {
	const file = await pickFile(type === "video" ? "video/*" : "image/*");
	if (!file) return null;
	return addAssetFromFile(store, file, type);
}

/** Add a batch of (file, kind) pairs to the library. Sequential so name- and
 * content-de-dup see every prior add; each file is isolated so one bad file
 * (corrupt / undecodable) alerts but doesn't abort the rest. */
async function addFilesToLibrary(store: Store, items: Array<{ file: File; kind: "image" | "video" }>): Promise<void> {
	for (const { file, kind } of items) {
		try {
			await addAssetFromFile(store, file, kind);
		} catch {
			alert(`Couldn't load "${file.name}" — it may be corrupt or an unsupported ${kind} format.`);
		}
	}
}

/** Pick one or more files (all of one kind) and add them to the shared library. */
async function pickAndAddAssets(store: Store, type: "image" | "video"): Promise<void> {
	const files = await pickFiles(type === "video" ? "video/*" : "image/*");
	await addFilesToLibrary(store, files.map((file) => ({ file, kind: type })));
}

/** Classify a dropped file as image or video (MIME first, extension as a fallback
 * for when the OS didn't tag it); null = not media we accept. */
function fileKind(file: File): "image" | "video" | null {
	const t = file.type.toLowerCase();
	if (t.startsWith("image/")) return "image";
	if (t.startsWith("video/")) return "video";
	const ext = (file.name.split(".").pop() ?? "").toLowerCase();
	if (["mp4", "webm", "mov", "m4v", "ogv", "ogg", "mkv"].includes(ext)) return "video";
	if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"].includes(ext)) return "image";
	return null;
}

/** Add files dropped onto the Assets panel, routing each to image/video by type. */
async function addDroppedFiles(store: Store, fileList: FileList): Promise<void> {
	const items: Array<{ file: File; kind: "image" | "video" }> = [];
	let skipped = 0;
	for (const file of Array.from(fileList)) {
		const kind = fileKind(file);
		if (kind) items.push({ file, kind });
		else skipped++;
	}
	if (!items.length && skipped) {
		alert("Only image and video files can be added to the library.");
		return;
	}
	await addFilesToLibrary(store, items);
}

/** Make the Assets panel a drop target for files dragged in from the OS. */
function setupAssetDrop(store: Store, container: HTMLElement): void {
	const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
	// dragenter/leave fire per child, so count depth and only un-highlight at zero.
	let depth = 0;
	const setHot = (on: boolean) => container.classList.toggle("dropzone-hot", on);
	container.addEventListener("dragenter", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		depth++;
		setHot(true);
	});
	container.addEventListener("dragover", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
	});
	container.addEventListener("dragleave", (e) => {
		if (!hasFiles(e)) return;
		depth = Math.max(0, depth - 1);
		if (depth === 0) setHot(false);
	});
	container.addEventListener("drop", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		depth = 0;
		setHot(false);
		const files = e.dataTransfer?.files;
		if (files && files.length) void addDroppedFiles(store, files);
	});
}

/** Upload one file into the library and bind it to a channel. False when the
 * dialog was cancelled or the file was rejected (nothing changed). */
async function uploadAndBind(store: Store, passId: string, channel: number, type: "image" | "video"): Promise<boolean> {
	const asset = await pickAndAddAsset(store, type);
	if (!asset) return false;
	store.connectPin(passId, channel, { kind: type === "video" ? "video" : "image", assetId: asset.id, builtin: undefined, passId: undefined });
	return true;
}

// ---- assets (shared media library) -----------------------------------------

/** Thumbnail for a library asset: an <img> for stills; for video a muted <video>
 * seeked to an early frame so the card shows a still preview instead of black. */
function assetThumb(a: ImageAsset): HTMLElement {
	if (a.kind !== "video") return el("img", { class: "asset-thumb", attrs: { src: a.dataUrl, alt: a.name } });
	const v = el("video", { class: "asset-thumb", attrs: { playsinline: "", preload: "metadata" } });
	v.muted = true;
	v.src = a.dataUrl;
	v.addEventListener("loadedmetadata", () => {
		try {
			v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
		} catch {
			/* some browsers reject seeking before canplay; the poster just stays black */
		}
	});
	return v;
}

function renderAssets(store: Store, container: HTMLElement): void {
	const assets = store.assets;

	const cards = assets.map((a) => {
		const nameInput = el("input", { class: "asset-name", type: "text", value: a.name, title: "Rename (the AI binds assets by name)" });
		nameInput.addEventListener("change", () => store.renameAsset(a.id, nameInput.value));

		const meta = `${a.kind === "video" ? "video" : "image"} · ${a.width}×${a.height} · ${a.source}`;
		const del = el("button", { class: "btn icon tiny", title: "Delete asset", on: { click: () => { if (confirm(`Delete asset "${a.name}"? It will be removed from every shader that uses it.`)) store.deleteAsset(a.id); } } }, icon("close", { size: 15 }));

		return el(
			"div",
			{ class: "asset-card" },
			el("div", { class: "asset-thumb-wrap" }, assetThumb(a), a.kind === "video" ? el("span", { class: "asset-badge" }, "video") : el("span", {})),
			el("div", { class: "asset-info" }, el("div", { class: "asset-head" }, nameInput, del), el("div", { class: "asset-meta" }, meta)),
		);
	});

	render(
		container,
		el("p", { class: "muted small" }, "Shared media library across all your shaders. Upload or drag in images or videos (several at once); the AI can bind them to a pass input (it sees them via read what:assets, and you can wire any input to one in the Textures tab)."),
		assets.length ? el("div", { class: "asset-grid" }, ...cards) : el("p", { class: "muted" }, "No assets yet. Upload or drag in images or videos and the AI can use them."),
		el(
			"div",
			{ class: "asset-actions" },
			el("button", { class: "btn", on: { click: () => void pickAndAddAssets(store, "image") } }, "+ Upload images"),
			el("button", { class: "btn", on: { click: () => void pickAndAddAssets(store, "video") } }, "+ Upload videos"),
		),
	);
}

// ---- small helpers ---------------------------------------------------------

function numberInput(value: number, onChange: (v: number) => void): HTMLInputElement {
	const inp = el("input", { class: "u-num", type: "number", value: String(value) });
	inp.addEventListener("change", () => {
		if (inp.value === "" || !Number.isFinite(inp.valueAsNumber)) return; // a cleared field is not 0
		onChange(inp.valueAsNumber);
	});
	return inp;
}

function selectFrom(options: string[], current: string, onChange: (v: string) => void): HTMLSelectElement {
	const sel = el("select", { class: "mini" }, ...options.map((o) => el("option", { value: o, attrs: { selected: o === current ? "selected" : undefined } }, o)));
	sel.addEventListener("change", () => onChange(sel.value));
	return sel;
}

function uniqueName(uniforms: Uniform[]): string {
	let i = 1;
	while (uniforms.some((u) => u.name === `u_param${i}`)) i++;
	return `u_param${i}`;
}

function rgbToHex(v: number[]): string {
	const c = (x: number) => Math.max(0, Math.min(255, Math.round((x ?? 0) * 255))).toString(16).padStart(2, "0");
	return `#${c(v[0])}${c(v[1])}${c(v[2])}`;
}
function hexToRgb(hex: string): number[] {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return [0, 0, 0];
	return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

// ---- layers panel (the document's back-to-front stack) ---------------------

function renderLayers(store: Store, container: HTMLElement): void {
	const layers = store.project.layers;
	const active = store.activeLayer();
	const activeId = active.id;
	const maskOwner = store.maskOwner(activeId); // set when we're editing a layer's mask

	const addBtn = el("button", { class: "btn tiny", title: "Add a layer on top", on: { click: () => store.addLayer("Layer") } }, "+ Add layer");

	// Render front (top) first, matching how the layers stack visually.
	const rows: HTMLElement[] = [];
	for (let i = layers.length - 1; i >= 0; i--) rows.push(layerRow(store, layers[i], i, layers.length, activeId));

	const banner = maskOwner
		? el(
				"div",
				{ class: "mask-banner" },
				icon("mask", { size: 14 }),
				el("span", {}, `Editing the MASK of "${maskOwner.name}"`),
				el("span", { class: "spacer" }),
				el("button", { class: "btn tiny", title: "Stop editing the mask", on: { click: () => store.selectLayer(maskOwner.id) } }, "Back to layer"),
				el("button", { class: "btn tiny", title: "Remove this mask", on: { click: () => store.removeMask(maskOwner.id) } }, "Remove mask"),
			)
		: null;

	render(
		container,
		el("div", { class: "layers-head" }, el("span", { class: "field-label" }, "Layers"), el("span", { class: "spacer" }), addBtn),
				el("p", { class: "muted small" }, "Drawn back to front (top of the list = front). Each layer composites over the layers below it; what its graph does to the 'under' and 'mask' inputs is the blend."),
		banner,
		layers.length ? el("div", { class: "layer-list" }, ...rows) : el("p", { class: "muted" }, "No layers."),
		shapesEditor(store, active),
	);
}

function layerRow(store: Store, layer: Layer, index: number, total: number, activeId: string): HTMLElement {
	const isActive = layer.id === activeId;
	const editingMask = !!layer.mask && layer.mask.id === activeId;
	const stop = (e: Event) => e.stopPropagation();

	const eyeBtn = el("button", { class: "btn icon tiny", title: layer.visible ? "Hide layer" : "Show layer", on: { click: (e) => { stop(e); store.setLayerVisible(layer.id, !layer.visible); } } }, icon(layer.visible ? "eye" : "eyeOff", { size: 15 }));
	const nameEl = el("span", { class: "layer-name" }, layer.name);
	nameEl.addEventListener("dblclick", (e) => { stop(e); beginLayerRename(store, layer, nameEl); });
	const meta = el("span", { class: "layer-meta muted small" }, `${layer.shapes.length} shp · ${layer.passes.length}p`);

	const opacity = el("input", { class: "layer-opacity", type: "range", title: "Layer opacity", attrs: { min: "0", max: "1", step: "0.01", value: String(layer.opacity) } });
	opacity.addEventListener("input", () => store.setLayerOpacity(layer.id, Number(opacity.value), true));
	opacity.addEventListener("pointerdown", stop);
	opacity.addEventListener("click", stop); // the click after a drag must not select the layer

	const maskBtn = layer.mask
		? el("button", { class: `btn icon tiny mask-btn${editingMask ? " on" : ""}`, title: editingMask ? "Editing this mask" : "Edit mask", on: { click: (e) => { stop(e); store.selectLayer(layer.mask!.id); } } }, icon("mask", { size: 15 }))
		: el("button", { class: "btn icon tiny mask-add", title: "Add a mask", on: { click: (e) => { stop(e); store.addMask(layer.id); } } }, icon("mask", { size: 15 }));

	const up = el("button", { class: "btn icon tiny", title: "Move toward front", disabled: index === total - 1, on: { click: (e) => { stop(e); store.reorderLayer(layer.id, index + 1); } } }, icon("chevronUp", { size: 15 }));
	const down = el("button", { class: "btn icon tiny", title: "Move toward back", disabled: index === 0, on: { click: (e) => { stop(e); store.reorderLayer(layer.id, index - 1); } } }, icon("chevronDown", { size: 15 }));
	const del = el("button", { class: "btn icon tiny", title: "Delete layer", on: { click: (e) => { stop(e); const r = store.removeLayer(layer.id); if (!r.ok && r.error) alert(r.error); } } }, icon("trash", { size: 15 }));

	const row = el("div", { class: `layer-row${isActive ? " active" : ""}${editingMask ? " mask-owner" : ""}${layer.visible ? "" : " is-hidden"}` }, eyeBtn, el("div", { class: "layer-id" }, nameEl, meta), el("span", { class: "spacer" }), opacity, maskBtn, up, down, del);
	row.addEventListener("click", () => store.selectLayer(layer.id));
	return row;
}

function beginLayerRename(store: Store, layer: Layer, nameEl: HTMLElement): void {
	const input = el("input", { class: "gn-rename", type: "text", value: layer.name });
	nameEl.replaceWith(input);
	input.focus();
	input.select();
	input.addEventListener("pointerdown", (e) => e.stopPropagation());
	input.addEventListener("click", (e) => e.stopPropagation());
	const commit = () => {
		const v = input.value.trim();
		if (v && v !== layer.name) store.renameLayer(layer.id, v);
		else input.replaceWith(nameEl); // unchanged or cleared: restore, no history entry
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") input.blur();
		if (e.key === "Escape") { input.value = layer.name; input.blur(); }
	});
	input.addEventListener("blur", commit);
}

// ---- geometry editor (the active layer's shapes) ---------------------------

function shapesEditor(store: Store, layer: Layer): HTMLElement {
	const addButtons = SHAPE_DEFS.map((d) => el("button", { class: "btn tiny", title: `Add a ${d.label.toLowerCase()} to "${layer.name}"`, on: { click: () => store.addShape(layer.id, d.id) } }, `+ ${d.label}`));
	const head = el("div", { class: "shapes-head" }, el("span", { class: "field-label" }, `Geometry — ${layer.name}`), el("span", { class: "spacer" }), ...addButtons);
	const rows = layer.shapes.map((s, i) => shapeRow(store, layer, s, i));
	return el(
		"div",
		{ class: "shapes-editor" },
		head,
		layer.shapes.length ? el("div", { class: "shape-list" }, ...rows) : el("p", { class: "muted small" }, "No shapes. Add a quad or circle — it rasterizes into this layer's 'geometry' input, which the layer's graph composites over what's below."),
	);
}

function shapeRow(store: Store, layer: Layer, shape: Shape, index: number): HTMLElement {
	const upd = (patch: Partial<Shape>) => store.updateShape(layer.id, shape.id, patch, true);
	const field = (label: string, value: number, step: number, onChange: (v: number) => void) => el("label", { class: "shape-field" }, el("span", { class: "shape-flabel" }, label), shapeNum(value, step, onChange));

	const fields = el(
		"div",
		{ class: "shape-fields" },
		field("x", round2(shape.x), 0.01, (v) => upd({ x: v })),
		field("y", round2(shape.y), 0.01, (v) => upd({ y: v })),
		field("w", round2(shape.w), 0.01, (v) => upd({ w: Math.max(0, v) })),
		field("h", round2(shape.h), 0.01, (v) => upd({ h: Math.max(0, v) })),
		field("rot", Math.round((shape.rotation * 180) / Math.PI), 1, (v) => upd({ rotation: (v * Math.PI) / 180 })),
	);

	const colorPicker = el("input", { class: "shape-color", type: "color", value: rgbToHex(shape.color) });
	colorPicker.addEventListener("input", () => { const rgb = hexToRgb(colorPicker.value); upd({ color: [rgb[0], rgb[1], rgb[2], shape.color[3]] }); });
	const alpha = el("input", { class: "shape-alpha", type: "range", title: "Alpha", attrs: { min: "0", max: "1", step: "0.01", value: String(shape.color[3]) } });
	alpha.addEventListener("input", () => upd({ color: [shape.color[0], shape.color[1], shape.color[2], Number(alpha.value)] }));
	const style = el("div", { class: "shape-style" }, el("span", { class: "shape-flabel" }, "fill"), colorPicker, alpha);
	if (shape.kind === "quad") {
		const cr = el("input", { class: "shape-round", type: "range", title: "Corner radius", attrs: { min: "0", max: "1", step: "0.01", value: String(shape.cornerRadius) } });
		cr.addEventListener("input", () => upd({ cornerRadius: Number(cr.value) }));
		style.appendChild(el("span", { class: "shape-flabel" }, "round"));
		style.appendChild(cr);
	}
	const fo = el("input", { class: "shape-round", type: "range", title: "Radial falloff (0 = solid, 1 = full gradient mask)", attrs: { min: "0", max: "1", step: "0.01", value: String(shape.falloff) } });
	fo.addEventListener("input", () => upd({ falloff: Number(fo.value) }));
	style.appendChild(el("span", { class: "shape-flabel" }, "falloff"));
	style.appendChild(fo);

	const del = el("button", { class: "btn icon tiny", title: "Delete shape", on: { click: () => store.removeShape(layer.id, shape.id) } }, icon("trash", { size: 14 }));
	const kindLabel = el("span", { class: "shape-kind", title: "Select on canvas", on: { click: () => store.selectShape(shape.id) } }, `[${index}] ${SHAPE_LABELS[shape.kind]}`);
	const head = el("div", { class: "shape-head" }, kindLabel, el("span", { class: "spacer" }), del);
	const selected = store.selectedShapeId === shape.id;
	return el("div", { class: `shape-row${selected ? " selected" : ""}` }, head, fields, style);
}

function shapeNum(value: number, step: number, onChange: (v: number) => void): HTMLInputElement {
	const inp = el("input", { class: "shape-num", type: "number", attrs: { step: String(step), value: String(value) } });
	// A field mid-edit ("", "-", "1.") is not a number yet; leave the shape alone.
	const fire = () => { if (inp.value !== "" && Number.isFinite(inp.valueAsNumber)) onChange(inp.valueAsNumber); };
	inp.addEventListener("input", fire);
	return inp;
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}
