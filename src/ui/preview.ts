// Live preview: the WebGL canvas, playback toolbar, and a stats readout.

import { el, render } from "../util/dom.ts";
import { icon } from "../util/icons.ts";
import { downloadFile } from "../util/misc.ts";
import type { Store } from "../state/store.ts";
import type { RenderStats } from "../gl/renderer.ts";

export function createPreview(store: Store, canvas: HTMLCanvasElement): HTMLElement {
	const playBtn = el("button", { class: "btn icon", title: "Play / Pause (space)" });
	const updatePlay = () => render(playBtn, icon(store.renderer.isPaused() ? "play" : "pause"));
	playBtn.addEventListener("click", () => {
		store.renderer.togglePlay();
		updatePlay();
	});

	const stats = el("span", { class: "stats" }, "—");
	store.on("stats", (s) => {
		const st = s as RenderStats;
		const passes = st.passes > 1 ? ` · ${st.passes} passes` : "";
		stats.textContent = `${st.width}x${st.height} · ${st.fps} fps · frame ${st.frame} · t=${st.time.toFixed(1)}s${passes}${st.paused ? " · paused" : ""}`;
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
		el("button", {
			class: "btn icon",
			title: "Download a PNG screenshot",
			on: {
				click: () => {
					const shot = store.renderer.screenshot(1920, "image/png", 1);
					downloadFile(`${store.project.name.replace(/\s+/g, "_")}.png`, dataUrlToBlob(shot.dataUrl));
				},
			},
		}, icon("download")),
		errBadge,
		el("span", { class: "spacer" }),
		scaleSel,
	);

	updatePlay();
	store.on("project", updatePlay);

	const canvasWrap = el("div", { class: "canvas-wrap" });
	canvasWrap.appendChild(canvas);

	return el("section", { class: "preview" }, toolbar, canvasWrap, el("div", { class: "statbar" }, stats));
}

function dataUrlToBlob(dataUrl: string): Blob {
	const [head, b64] = dataUrl.split(",");
	const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/png";
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}
