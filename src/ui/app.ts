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

	// Global undo/redo. Inside a text field (code editor, chat box, name inputs)
	// we defer to the browser's native per-character undo, which is what the user
	// expects there; everywhere else these drive the project-level history.
	window.addEventListener("keydown", (e) => {
		const mod = e.ctrlKey || e.metaKey;
		if (!mod || e.altKey) return;
		const key = e.key.toLowerCase();
		const isUndo = key === "z" && !e.shiftKey;
		const isRedo = (key === "z" && e.shiftKey) || key === "y";
		if (!isUndo && !isRedo) return;
		if (isTextEntry(e.target as HTMLElement | null)) return;
		e.preventDefault();
		if (isUndo) store.undo();
		else store.redo();
	});

	return root;
}

// True for elements with meaningful native text undo, where we must not hijack
// Ctrl+Z. Non-text inputs (range/color/checkbox) and selects fall through to the
// project history instead.
function isTextEntry(t: HTMLElement | null): boolean {
	if (!t) return false;
	if (t.isContentEditable) return true;
	if (t.tagName === "TEXTAREA") return true;
	if (t.tagName === "INPUT") return /^(text|search|url|email|password|number|tel)$/.test((t as HTMLInputElement).type);
	return false;
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
