// Right-hand editor panel with four tabs: the per-pass shader Code editor, the
// Passes render-graph (the object graph: draggable pass nodes wired by their
// channel inputs), live Uniform controls (shared across passes), and the
// iChannel texture bindings for the selected pass. All edits flow through the
// store.

import { el, render } from "../util/dom.ts";
import { icon } from "../util/icons.ts";
import { debounce, formatBytes, pickFile, uid } from "../util/misc.ts";
import { fileToDataUrl, loadImageEl, loadVideoMeta, MAX_VIDEO_BYTES } from "../util/media.ts";
import { BUILTIN_LABELS } from "../gl/textures.ts";
import type { BuiltinTexture, Channel, ImageAsset, Pass, PassFormat, Uniform, UniformType } from "../state/types.ts";
import type { Store } from "../state/store.ts";

const TABS = ["Code", "Passes", "Uniforms", "Textures"] as const;
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

	const codeView = buildCodeView(store);
	const passesView = el("div", { class: "passes" });
	const uniformsView = el("div", { class: "uniforms" });
	const texturesView = el("div", { class: "textures" });

	const renderActive = () => {
		render(tabBar, ...TABS.map((t) => el("button", { class: `tab${t === active ? " active" : ""}`, on: { click: () => select(t) } }, t)));
		render(body, active === "Code" ? codeView.root : active === "Passes" ? passesView : active === "Uniforms" ? uniformsView : texturesView);
		if (active === "Code") codeView.syncHead();
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
		if (active === "Uniforms") renderUniforms(store, uniformsView);
		if (active === "Textures") renderTextures(store, texturesView);
	};
	const select = (t: Tab) => {
		active = t;
		renderActive();
	};

	store.on("project", () => {
		codeView.sync();
		codeView.syncHead();
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
		if (active === "Uniforms") renderUniforms(store, uniformsView);
		if (active === "Textures") renderTextures(store, texturesView);
	});
	store.on("selectedPass", () => {
		codeView.sync();
		codeView.syncHead();
		codeView.syncLog();
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
		if (active === "Textures") renderTextures(store, texturesView);
	});
	store.on("assets", () => {
		if (active === "Textures") renderTextures(store, texturesView);
		if (active === "Passes") renderGraph(store, passesView, select, graphView);
	});
	store.on("compile", () => codeView.syncLog());

	renderActive();
	return el("section", { class: "rightpanel" }, tabBar, body);
}

// ---- code editor -----------------------------------------------------------

function buildCodeView(store: Store): { root: HTMLElement; sync: () => void; syncLog: () => void; syncHead: () => void } {
	const head = el("div", { class: "code-head" });
	const textarea = el("textarea", { class: "code", attrs: { spellcheck: "false", wrap: "soft" } });
	textarea.value = store.selectedPass().source;

	const apply = debounce(() => store.setPassSource(store.selectedPassId, textarea.value, true), 350);
	textarea.addEventListener("input", apply);
	textarea.addEventListener("keydown", (e) => {
		if (e.key === "Tab") {
			e.preventDefault();
			const s = textarea.selectionStart;
			const eN = textarea.selectionEnd;
			textarea.value = textarea.value.slice(0, s) + "\t" + textarea.value.slice(eN);
			textarea.selectionStart = textarea.selectionEnd = s + 1;
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
		const src = store.selectedPass().source;
		if (document.activeElement !== textarea && textarea.value !== src) textarea.value = src;
		syncLog();
	};
	const syncHead = () => {
		const pass = store.selectedPass();
		const isOutput = pass.id === store.project.outputPassId;
		const passSel = el(
			"select",
			{ class: "code-pass", title: "Pass being edited" },
			...store.project.passes.map((p) => el("option", { value: p.id, attrs: { selected: p.id === pass.id ? "selected" : undefined } }, p.name + (p.id === store.project.outputPassId ? " ★" : ""))),
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
	return { root: el("div", { class: "code-view" }, head, textarea, log), sync, syncLog, syncHead };
}

// ---- passes graph (the object graph) ---------------------------------------

const NODE_W = 196;
const HEADER_H = 30;
const ROW_H = 26;
const ADDROW_H = 24;

// Per-node geometry (input count varies, so heights/ports are computed).
const inPortY = (i: number): number => HEADER_H + ROW_H / 2 + i * ROW_H;
const outPortY = (pass: Pass): number => HEADER_H + (Math.max(pass.channels.length, 1) * ROW_H) / 2;
const nodeHeight = (pass: Pass): number => HEADER_H + pass.channels.length * ROW_H + ADDROW_H + 6;

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
function fitView(view: GraphView, passes: Pass[], graph: HTMLElement): void {
	if (!passes.length) return;
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of passes) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x + NODE_W);
		maxY = Math.max(maxY, p.y + nodeHeight(p));
	}
	const pad = 36;
	const cw = graph.clientWidth || 600;
	const ch = graph.clientHeight || 400;
	view.zoom = clampZoom(Math.min(cw / (maxX - minX + pad * 2), ch / (maxY - minY + pad * 2)));
	view.x = (cw - (minX + maxX) * view.zoom) / 2;
	view.y = (ch - (minY + maxY) * view.zoom) / 2;
}

function renderGraph(store: Store, container: HTMLElement, select: (t: Tab) => void, view: GraphView): void {
	const passes = store.project.passes;
	const viewport = el("div", { class: "graph-viewport" });

	// Edges (SVG) behind the nodes, inside the transformed viewport.
	const w = Math.max(640, ...passes.map((p) => p.x + NODE_W + 60));
	const h = Math.max(360, ...passes.map((p) => p.y + nodeHeight(p) + 60));
	const svgNS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNS, "svg");
	svg.setAttribute("class", "graph-edges");
	svg.setAttribute("width", String(w));
	svg.setAttribute("height", String(h));

	const byId = new Map(passes.map((p) => [p.id, p]));
	const drawEdges = (): void => {
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		for (const tgt of passes) {
			tgt.channels.forEach((c, i) => {
				if (c.kind !== "pass" || !c.passId) return;
				const src = byId.get(c.passId);
				if (!src) return;
				const sx = src.x + NODE_W;
				const sy = src.y + outPortY(src);
				const tx = tgt.x;
				const ty = tgt.y + inPortY(i);
				const path = document.createElementNS(svgNS, "path");
				const dx = Math.max(40, Math.abs(tx - sx) * 0.5);
				path.setAttribute("d", `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`);
				path.setAttribute("class", src.id === tgt.id ? "edge feedback" : "edge");
				svg.appendChild(path);
			});
		}
	};

	for (const pass of passes) viewport.appendChild(buildNode(store, pass, select, () => drawEdges(), view));
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
		el("span", { class: "muted small graph-hint" }, "scroll = pan · ctrl/⌘+scroll or pinch = zoom · drag background = pan"),
		el("span", { class: "spacer" }),
		zoomBtn("−", "Zoom out", () => zoomAt(view, graph.clientWidth / 2, graph.clientHeight / 2, 1 / 1.2)),
		zoomLabel,
		zoomBtn("+", "Zoom in", () => zoomAt(view, graph.clientWidth / 2, graph.clientHeight / 2, 1.2)),
		el("button", { class: "btn tiny", title: "Fit all passes", on: { click: () => { fitView(view, passes, graph); applyTransform(); } } }, "Fit"),
	);

	render(container, toolbar, graph);
}

function buildNode(store: Store, pass: Pass, select: (t: Tab) => void, onWireChange: () => void, view: GraphView): HTMLElement {
	const isOutput = pass.id === store.project.outputPassId;
	const selected = pass.id === store.selectedPassId;
	const node = el("div", { class: `graph-node${selected ? " selected" : ""}${isOutput ? " output" : ""}` });
	node.style.left = `${pass.x}px`;
	node.style.top = `${pass.y}px`;

	const nameEl = el("span", { class: "gn-name" }, pass.name);
	const editBtn = el("button", { class: "btn icon tiny", title: "Edit this pass's code", on: { click: () => { store.selectPass(pass.id); select("Code"); } } }, icon("wrench", { size: 13 }));
	const outBtn = el("button", { class: `btn icon tiny${isOutput ? " on" : ""}`, title: isOutput ? "Shown on screen" : "Make output", on: { click: () => store.setOutputPass(pass.id) } }, icon("eye", { size: 14 }));
	const delBtn = el("button", { class: "btn icon tiny", title: "Delete pass", on: { click: () => { const r = store.removePass(pass.id); if (!r.ok && r.error) alert(r.error); } } }, icon("close", { size: 14 }));

	const header = el("div", { class: "gn-head" }, nameEl, el("span", { class: "spacer" }), editBtn, outBtn, delBtn);
	header.addEventListener("pointerdown", (e) => startDrag(store, pass, node, e, onWireChange, view));
	// Rename inline on double-click.
	nameEl.addEventListener("dblclick", () => beginRename(store, pass, nameEl));
	header.addEventListener("click", (e) => {
		if (e.target === nameEl || e.target === header) store.selectPass(pass.id);
	});

	const rows = pass.channels.map((_c, i) => {
		const sel = channelSelect(store, pass, i, true);
		const rm = el("button", { class: "btn icon tiny gn-rm", title: `Remove iChannel${i}`, on: { click: () => store.removePassChannel(pass.id, i) } }, icon("close", { size: 12 }));
		return el("div", { class: "gn-row" }, el("span", { class: "gn-port in" }), el("span", { class: "gn-ch" }, `iCh${i}`), sel, rm);
	});
	const atMax = pass.channels.length >= store.renderer.maxInputs();
	const addRow = el("div", { class: "gn-addrow" }, el("button", { class: "btn tiny", attrs: { disabled: atMax ? "" : undefined }, title: atMax ? "Input limit reached" : "Add an input channel", on: { click: () => store.addPassChannel(pass.id) } }, `+ input (iChannel${pass.channels.length})`));

	node.appendChild(header);
	node.appendChild(el("div", { class: "gn-body" }, ...rows, addRow));
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
		if (v) store.renamePass(pass.id, v);
		else store.renamePass(pass.id, pass.name); // re-render to restore
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") input.blur();
		if (e.key === "Escape") { input.value = pass.name; input.blur(); }
	});
	input.addEventListener("blur", commit);
}

function startDrag(store: Store, pass: Pass, node: HTMLElement, e: PointerEvent, onMove: () => void, view: GraphView): void {
	if ((e.target as HTMLElement).closest("button, select, input")) return;
	e.preventDefault();
	const startX = e.clientX;
	const startY = e.clientY;
	const baseX = pass.x;
	const baseY = pass.y;
	let curX = baseX;
	let curY = baseY;
	const move = (ev: PointerEvent): void => {
		// Screen deltas are in zoomed pixels; convert to graph units.
		curX = Math.max(0, baseX + (ev.clientX - startX) / view.zoom);
		curY = Math.max(0, baseY + (ev.clientY - startY) / view.zoom);
		node.style.left = `${curX}px`;
		node.style.top = `${curY}px`;
		pass.x = curX;
		pass.y = curY;
		onMove();
	};
	const up = (): void => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		store.movePass(pass.id, curX, curY);
	};
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", up);
}

// ---- shared channel <select> -----------------------------------------------

function channelValue(ch: Channel): string {
	if (ch.kind === "none") return "none";
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
	// All passes are selectable as a source, including this pass itself (feedback).
	const sourcePasses = store.project.passes;
	const images = store.assets.filter((a) => a.kind !== "video");
	const videos = store.assets.filter((a) => a.kind === "video");
	const opt = (v: string, label: string) => el("option", { value: v, attrs: { selected: v === value ? "selected" : undefined } }, label);
	const sel = el(
		"select",
		{ class: "ch-sel" },
		opt("none", compact ? "—" : "(empty)"),
		opt("webcam", compact ? "Webcam" : "Webcam (live)"),
		el("optgroup", { attrs: { label: "Passes" } }, ...sourcePasses.map((p) => opt(`pass:${p.id}`, p.id === pass.id ? `${p.name} (feedback)` : p.name))),
		el("optgroup", { attrs: { label: "Built-in" } }, ...(Object.keys(BUILTIN_LABELS) as BuiltinTexture[]).map((b) => opt(`builtin:${b}`, BUILTIN_LABELS[b]))),
		el("optgroup", { attrs: { label: "Images" } }, ...images.map((a) => opt(`image:${a.id}`, a.name)), el("option", { value: "upload-image" }, "Upload image…")),
		el("optgroup", { attrs: { label: "Videos" } }, ...videos.map((a) => opt(`video:${a.id}`, a.name)), el("option", { value: "upload-video" }, "Upload video…")),
	);
	sel.addEventListener("change", () => {
		const v = sel.value;
		if (v === "none") store.setPassChannel(pass.id, index, { kind: "none", assetId: undefined, builtin: undefined, passId: undefined });
		else if (v === "webcam") store.setPassChannel(pass.id, index, { kind: "webcam", assetId: undefined, builtin: undefined, passId: undefined });
		else if (v.startsWith("pass:")) store.setPassChannel(pass.id, index, { kind: "pass", passId: v.slice(5), builtin: undefined, assetId: undefined });
		else if (v.startsWith("builtin:")) store.setPassChannel(pass.id, index, { kind: "builtin", builtin: v.slice(8) as BuiltinTexture, assetId: undefined, passId: undefined });
		else if (v === "upload-image") void uploadAndBind(store, pass.id, index, "image");
		else if (v === "upload-video") void uploadAndBind(store, pass.id, index, "video");
		else if (v.startsWith("image:")) store.setPassChannel(pass.id, index, { kind: "image", assetId: v.slice(6), builtin: undefined, passId: undefined });
		else if (v.startsWith("video:")) store.setPassChannel(pass.id, index, { kind: "video", assetId: v.slice(6), builtin: undefined, passId: undefined });
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

	render(
		container,
		el("p", { class: "muted small" }, "Uniforms are shared across all passes."),
		uniforms.length ? el("div", { class: "u-list" }, ...rows) : el("p", { class: "muted" }, "No custom uniforms. The AI adds these with set_uniforms, or add one below."),
		el("button", {
			class: "btn",
			on: {
				click: () => {
					store.project.uniforms.push({ name: uniqueName(uniforms), type: "float", value: [0.5], min: 0, max: 1, step: 0.01 });
					commit();
				},
			},
		}, "+ Add uniform"),
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
	const passSel = el(
		"select",
		{ class: "tex-pass", title: "Pass whose inputs you are editing" },
		...store.project.passes.map((p) => el("option", { value: p.id, attrs: { selected: p.id === pass.id ? "selected" : undefined } }, p.name + (p.id === store.project.outputPassId ? " ★" : ""))),
	);
	passSel.addEventListener("change", () => store.selectPass(passSel.value));

	const rows = pass.channels.map((ch, i) => {
		const sel = channelSelect(store, pass, i, false);
		const filterSel = selectFrom(["linear", "nearest"], ch.filter, (val) => store.setPassChannel(pass.id, i, { filter: val as "linear" | "nearest" }));
		const wrapSel = selectFrom(["repeat", "clamp", "mirror"], ch.wrap, (val) => store.setPassChannel(pass.id, i, { wrap: val as "repeat" | "clamp" | "mirror" }));
		const rm = el("button", { class: "btn icon tiny", title: `Remove iChannel${i}`, on: { click: () => store.removePassChannel(pass.id, i) } }, icon("close", { size: 14 }));
		return el("div", { class: "ch-row" }, el("label", { class: "ch-label" }, `iChannel${i}`), sel, filterSel, wrapSel, rm);
	});

	const atMax = pass.channels.length >= store.renderer.maxInputs();
	const addBtn = el("button", { class: "btn", attrs: { disabled: atMax ? "" : undefined }, on: { click: () => store.addPassChannel(pass.id) } }, atMax ? `Max inputs (${store.renderer.maxInputs()})` : `+ Add input (iChannel${pass.channels.length})`);

	render(
		container,
		el("div", { class: "tex-head" }, el("span", { class: "field-label" }, "Inputs for pass"), passSel),
		pass.channels.length ? el("div", { class: "ch-list" }, ...rows) : el("p", { class: "muted small" }, "This pass has no inputs yet."),
		addBtn,
		el("p", { class: "muted small" }, "Bind a built-in texture, an image, a video, the live webcam, or another pass's output (kind=pass) — including this pass's own previous frame for feedback. Videos and the webcam animate (their current frame is sampled each frame). A pass can have as many inputs as the GPU allows (≥16), not just 4."),
	);
}

async function uploadAndBind(store: Store, passId: string, channel: number, type: "image" | "video"): Promise<void> {
	const file = await pickFile(type === "video" ? "video/*" : "image/*");
	if (!file) return;
	if (type === "video" && file.size > MAX_VIDEO_BYTES) {
		alert(`Video is ${formatBytes(file.size)}. Please use a clip under 32 MB — short, low-resolution loops work best (everything is stored inline in your browser).`);
		return;
	}
	const dataUrl = await fileToDataUrl(file);
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
		name: file.name.replace(/\.[^.]+$/, ""),
		mediaType: file.type || (type === "video" ? "video/mp4" : "image/png"),
		dataUrl,
		width,
		height,
		source: "upload",
		kind: type,
	};
	store.addAsset(asset);
	store.setPassChannel(passId, channel, { kind: type === "video" ? "video" : "image", assetId: asset.id, builtin: undefined, passId: undefined });
}

// ---- small helpers ---------------------------------------------------------

function numberInput(value: number, onChange: (v: number) => void): HTMLInputElement {
	const inp = el("input", { class: "u-num", type: "number", value: String(value) });
	inp.addEventListener("change", () => onChange(Number(inp.value)));
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
