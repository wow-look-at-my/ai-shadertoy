// Live preview: the WebGL canvas, playback toolbar, and a stats readout.

import { el, render } from "../util/dom.ts";
import { icon } from "../util/icons.ts";
import { downloadFile } from "../util/misc.ts";
import { encodeHalfRGBA } from "../util/exr.ts";
import { createShapeGizmo } from "./shapegizmo.ts";
import type { Store } from "../state/store.ts";
import type { RenderStats } from "../gl/renderer.ts";

export function createPreview(store: Store, canvas: HTMLCanvasElement): HTMLElement {
	const playBtn = el("button", { class: "btn icon", title: "Play / Pause (space)" });
	const updatePlay = () => render(playBtn, icon(store.renderer.isPaused() ? "play" : "pause"));
	playBtn.addEventListener("click", () => store.togglePlay());
	store.on("playback", updatePlay);

	const stats = el("span", { class: "stats" }, "—");
	store.on("stats", (s) => {
		const st = s as RenderStats;
		const layers = st.layers > 1 ? ` · ${st.layers} layers` : "";
		const passes = st.passes > 1 ? ` · ${st.passes} passes` : "";
		stats.textContent = `${st.width}x${st.height} · ${st.fps} fps · frame ${st.frame} · t=${st.time.toFixed(1)}s${layers}${passes}${st.paused ? " · paused" : ""}`;
	});

	const scaleSel = el(
		"select",
		{ class: "scale", title: "Render scale" },
		...[
			["0.25", "¼×"],
			["0.5", "½×"],
			["1", "1×"],
		].map(([v, label]) => el("option", { value: v }, label)),
	);
	scaleSel.value = String(store.settings.renderScale);
	scaleSel.addEventListener("change", () => store.updateSettings({ renderScale: Number(scaleSel.value) }));
	store.on("settings", () => (scaleSel.value = String(store.settings.renderScale)));

	// Square-pixels toggle: forces an isotropic UV space (iResolution = short side).
	const squareBtn = el("button", { class: "btn icon", title: "Square pixels: isotropic UVs (circles stay round)" }, icon("aspectRatio"));
	const updateSquare = () => {
		squareBtn.classList.toggle("on", store.settings.squarePixels);
		squareBtn.setAttribute("aria-pressed", String(store.settings.squarePixels));
	};
	squareBtn.addEventListener("click", () => store.updateSettings({ squarePixels: !store.settings.squarePixels }));
	updateSquare();
	store.on("settings", updateSquare);

	const errBadge = el("span", { class: "err-badge", title: "Shader does not compile" }, "compile error");
	errBadge.hidden = true;
	store.on("compile", (c) => {
		const ok = (c as { ok: boolean } | null)?.ok ?? true;
		errBadge.hidden = ok;
	});

	const toolbar = el(
		"div",
		{ class: "toolbar" },
		playBtn,
		el("button", { class: "btn icon", title: "Restart time", on: { click: () => store.renderer.reset() } }, icon("restart")),
		createDownloadMenu(store),
		errBadge,
		el("span", { class: "spacer" }),
		squareBtn,
		scaleSel,
	);

	updatePlay();
	store.on("project", updatePlay);

	const canvasWrap = el("div", { class: "canvas-wrap" });
	canvasWrap.appendChild(canvas);
	canvasWrap.appendChild(createShapeGizmo(store, canvas));

	return el("section", { class: "preview" }, toolbar, canvasWrap, el("div", { class: "statbar" }, stats));
}

/** Download button that opens a small format menu: lossless PNG, lossless WebP,
 * and — only when the output is an HDR (rgba16f) target — lossless 16-bit EXR.
 * The menu is rebuilt on each open so the EXR option reflects the live output. */
function createDownloadMenu(store: Store): HTMLElement {
	const btn = el("button", { class: "btn icon", title: "Download a screenshot" }, icon("download"));
	const menu = el("div", { class: "download-menu" });
	menu.hidden = true;
	const wrap = el("div", { class: "download-wrap" }, btn, menu);

	const baseName = () => store.project.name.replace(/\s+/g, "_") || "shader";

	const saveRaster = (mime: string) => {
		// One quality -> lossless for both PNG (ignored) and WebP (true VP8L lossless).
		const shot = store.renderer.screenshot(1920, mime, 1);
		const blob = dataUrlToBlob(shot.dataUrl);
		downloadFile(`${baseName()}.${blob.type === "image/webp" ? "webp" : "png"}`, blob);
	};
	const saveExr = () => {
		const cap = store.renderer.captureFloat();
		if (!cap) return; // output stopped being a float target between open and click
		const bytes = encodeHalfRGBA(cap.width, cap.height, cap.data);
		downloadFile(`${baseName()}.exr`, new Blob([bytes as BlobPart], { type: "image/x-exr" }));
	};

	const onDocDown = (e: PointerEvent) => {
		if (!wrap.contains(e.target as Node)) close();
	};
	const close = () => {
		if (menu.hidden) return;
		menu.hidden = true;
		document.removeEventListener("pointerdown", onDocDown, true);
	};
	const item = (label: string, note: string, run: () => void) =>
		el("button", { class: "download-item", on: { click: () => { close(); run(); } } }, el("span", { class: "fmt" }, label), el("span", { class: "note" }, note));

	const open = () => {
		const items = [
			item("PNG", "Lossless", () => saveRaster("image/png")),
			item("WebP", "Lossless", () => saveRaster("image/webp")),
		];
		if (store.renderer.hasFloatOutput()) items.push(item("EXR", "HDR · 16-bit float", saveExr));
		render(menu, ...items);
		menu.hidden = false;
		document.addEventListener("pointerdown", onDocDown, true);
	};

	btn.addEventListener("click", () => (menu.hidden ? open() : close()));
	return wrap;
}

function dataUrlToBlob(dataUrl: string): Blob {
	const [head, b64] = dataUrl.split(",");
	const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/png";
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}
