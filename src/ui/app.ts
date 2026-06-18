// Composes the whole UI: top bar, the three-column workspace (chat / preview /
// editor), and the settings modal.

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

	const workspace = el("div", { class: "workspace" }, chat, preview, right);
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
