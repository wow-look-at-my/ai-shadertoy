// Right-hand panel with three tabs: the shader Code editor, live Uniform
// controls, and the iChannel texture bindings. All edits flow through the store.

import { el, render } from "../util/dom.ts";
import { debounce, pickFile, uid } from "../util/misc.ts";
import { BUILTIN_LABELS } from "../gl/textures.ts";
import type { BuiltinTexture, ImageAsset, Uniform, UniformType } from "../state/types.ts";
import type { Store } from "../state/store.ts";

export function createRightPanel(store: Store): HTMLElement {
	const tabs = ["Code", "Uniforms", "Textures"] as const;
	let active: (typeof tabs)[number] = "Code";

	const tabBar = el("div", { class: "tabbar" });
	const body = el("div", { class: "panel-body" });

	const codeView = buildCodeView(store);
	const uniformsView = el("div", { class: "uniforms" });
	const texturesView = el("div", { class: "textures" });

	const renderActive = () => {
		render(tabBar, ...tabs.map((t) => el("button", { class: `tab${t === active ? " active" : ""}`, on: { click: () => select(t) } }, t)));
		render(body, active === "Code" ? codeView.root : active === "Uniforms" ? uniformsView : texturesView);
		if (active === "Uniforms") renderUniforms(store, uniformsView);
		if (active === "Textures") renderTextures(store, texturesView);
	};
	const select = (t: (typeof tabs)[number]) => {
		active = t;
		renderActive();
	};

	store.on("project", () => {
		codeView.sync();
		if (active === "Uniforms") renderUniforms(store, uniformsView);
		if (active === "Textures") renderTextures(store, texturesView);
	});
	store.on("assets", () => {
		if (active === "Textures") renderTextures(store, texturesView);
	});
	store.on("compile", () => codeView.syncLog());

	renderActive();
	return el("section", { class: "rightpanel" }, tabBar, body);
}

// ---- code editor -----------------------------------------------------------

function buildCodeView(store: Store): { root: HTMLElement; sync: () => void; syncLog: () => void } {
	const textarea = el("textarea", { class: "code", attrs: { spellcheck: "false", wrap: "off" } });
	textarea.value = store.project.shaderSource;

	const apply = debounce(() => store.setShaderSource(textarea.value, true), 350);
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
		const c = store.lastCompile;
		if (c && !c.ok) {
			log.textContent = c.log;
			log.hidden = false;
		} else {
			log.hidden = true;
		}
	};
	const sync = () => {
		if (document.activeElement !== textarea && textarea.value !== store.project.shaderSource) {
			textarea.value = store.project.shaderSource;
		}
		syncLog();
	};

	syncLog();
	return { root: el("div", { class: "code-view" }, textarea, log), sync, syncLog };
}

// ---- uniforms --------------------------------------------------------------

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
			el("div", { class: "u-head" }, nameInput, typeSel, el("button", { class: "btn icon tiny", title: "Remove", on: { click: () => { store.project.uniforms.splice(idx, 1); commit(); } } }, "✕")),
			controls,
			u.type === "color" ? el("span", {}) : el("div", { class: "u-range" }, el("label", {}, "min", minInput), el("label", {}, "max", maxInput)),
		);
	});

	render(
		container,
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

// ---- textures --------------------------------------------------------------

function renderTextures(store: Store, container: HTMLElement): void {
	const rows = [0, 1, 2, 3].map((i) => {
		const ch = store.project.channels[i];
		const value = ch.kind === "none" ? "none" : ch.kind === "builtin" ? `builtin:${ch.builtin}` : `image:${ch.assetId}`;
		const sel = el(
			"select",
			{ class: "ch-sel" },
			el("option", { value: "none", attrs: { selected: value === "none" ? "selected" : undefined } }, "(empty)"),
			el("optgroup", { attrs: { label: "Built-in" } }, ...(Object.keys(BUILTIN_LABELS) as BuiltinTexture[]).map((b) => el("option", { value: `builtin:${b}`, attrs: { selected: value === `builtin:${b}` ? "selected" : undefined } }, BUILTIN_LABELS[b]))),
			el("optgroup", { attrs: { label: "Images" } }, ...store.assets.map((a) => el("option", { value: `image:${a.id}`, attrs: { selected: value === `image:${a.id}` ? "selected" : undefined } }, a.name)), el("option", { value: "upload" }, "Upload image…")),
		);
		sel.addEventListener("change", () => {
			const v = sel.value;
			if (v === "none") store.setChannel(i, { kind: "none", assetId: undefined, builtin: undefined });
			else if (v.startsWith("builtin:")) store.setChannel(i, { kind: "builtin", builtin: v.slice(8) as BuiltinTexture, assetId: undefined });
			else if (v === "upload") void uploadAndBind(store, i);
			else if (v.startsWith("image:")) store.setChannel(i, { kind: "image", assetId: v.slice(6), builtin: undefined });
		});

		const filterSel = selectFrom(["linear", "nearest"], ch.filter, (val) => store.setChannel(i, { filter: val as "linear" | "nearest" }));
		const wrapSel = selectFrom(["repeat", "clamp", "mirror"], ch.wrap, (val) => store.setChannel(i, { wrap: val as "repeat" | "clamp" | "mirror" }));

		return el("div", { class: "ch-row" }, el("label", { class: "ch-label" }, `iChannel${i}`), sel, filterSel, wrapSel);
	});

	render(
		container,
		el("div", { class: "ch-list" }, ...rows),
		el("p", { class: "muted small" }, "Built-in textures need no upload. Uploaded/generated images appear here and in the AI's list_assets."),
	);
}

async function uploadAndBind(store: Store, channel: number): Promise<void> {
	const file = await pickFile("image/*");
	if (!file) return;
	const dataUrl = await fileToDataUrl(file);
	const img = await loadImg(dataUrl);
	const asset: ImageAsset = { id: uid("a_"), name: file.name.replace(/\.[^.]+$/, ""), mediaType: file.type || "image/png", dataUrl, width: img.naturalWidth, height: img.naturalHeight, source: "upload" };
	store.addAsset(asset);
	store.setChannel(channel, { kind: "image", assetId: asset.id, builtin: undefined });
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
function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result as string);
		r.onerror = () => reject(new Error("read failed"));
		r.readAsDataURL(file);
	});
}
function loadImg(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("decode failed"));
		img.src = src;
	});
}
