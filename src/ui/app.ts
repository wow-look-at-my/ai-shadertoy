// Composes the whole UI: top bar and a two-column workspace -- chat on the
// left, and a main column on the right that stacks the live preview ON TOP of
// the editor (code / passes / uniforms / textures), separated by a draggable
// splitter so the code gets the full width to read.

import { el } from "../util/dom.ts";
import { createTopbar } from "./topbar.ts";
import { createChat } from "./chat.ts";
import { createPreview } from "./preview.ts";
import { createRightPanel } from "./rightpanel.ts";
import { createSettings } from "./settings.ts";
import type { Store } from "../state/store.ts";

export function createApp(store: Store, canvas: HTMLCanvasElement, defaultShader: () => string): HTMLElement {
	const settings = createSettings(store);
	const openSettings = () => settings.open();

	const topbar = createTopbar({ store, defaultShader, openSettings });
	const chat = createChat({ store, openSettings });
	const preview = createPreview(store, canvas);
	const right = createRightPanel(store);

	const splitter = el("div", { class: "v-splitter", title: "Drag to resize the preview" });
	const main = el("div", { class: "main-col" }, preview, splitter, right);
	wireSplitter(main, splitter);

	const workspace = el("div", { class: "workspace" }, chat, main);
	const root = el("div", { class: "app" }, topbar, workspace, settings.root);

	// Space toggles playback unless the user is typing in a control.
	window.addEventListener("keydown", (e) => {
		if (e.key !== " ") return;
		const t = e.target as HTMLElement | null;
		if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
		e.preventDefault();
		store.renderer.togglePlay();
	});

	return root;
}

// Vertical resize of the preview / editor split. Updates --preview-h on the
// main column; the canvas auto-resizes from its container each animation frame.
function wireSplitter(main: HTMLElement, handle: HTMLElement): void {
	let dragging = false;
	const onMove = (e: PointerEvent): void => {
		if (!dragging) return;
		const rect = main.getBoundingClientRect();
		const pct = ((e.clientY - rect.top) / rect.height) * 100;
		main.style.setProperty("--preview-h", `${Math.max(15, Math.min(85, pct))}%`);
	};
	const onUp = (): void => {
		dragging = false;
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", onUp);
		document.body.style.userSelect = "";
	};
	handle.addEventListener("pointerdown", (e) => {
		dragging = true;
		e.preventDefault();
		document.body.style.userSelect = "none";
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	});
}
