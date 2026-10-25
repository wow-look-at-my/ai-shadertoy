// Entry point. Sets up the renderer, store, and UI, then mounts the app.

import { Renderer } from "./gl/renderer.ts";
import { Store } from "./state/store.ts";
import { MODEL_PRESETS } from "./state/defaults.ts";
import { createApp } from "./ui/app.ts";
import { completeOpenRouterSignIn, mergeSettingsDraft, OPENROUTER_DRAFT_KEY, OPENROUTER_VERIFIER_KEY, readSettingsDraft } from "./ai/openrouter.ts";
import { el } from "./util/dom.ts";

async function loadText(relPath: string): Promise<string> {
	// Pass a string (.href), not a URL object: ts0's fetch interceptor only matches string / Request inputs.
	const res = await fetch(new URL(relPath, import.meta.url).href);
	if (!res.ok) throw new Error(`failed to load ${relPath}: ${res.status}`);
	return res.text();
}

async function boot(): Promise<void> {
	const mount = document.getElementById("app");
	if (!mount) throw new Error("#app not found");

	let defaultShader: string;
	try {
		defaultShader = await loadText("./src/shaders/default.frag.glsl");
	} catch {
		// Bundle should always embed it; this only trips in an unbundled dev open.
		defaultShader = "void mainImage(out vec4 fragColor, in vec2 fragCoord){\n\tvec2 uv = fragCoord/iResolution.xy;\n\tfragColor = vec4(uv, 0.5+0.5*sin(iTime), 1.0);\n}\n";
	}
	const [fullscreenVert, present, shapeVert, shapeFrag] = await Promise.all([
		loadText("./src/shaders/fullscreen.vert.glsl"),
		loadText("./src/shaders/present.frag.glsl"),
		loadText("./src/shaders/shape.vert.glsl"),
		loadText("./src/shaders/shape.frag.glsl"),
	]);

	const canvas = el("canvas", { class: "gl" });
	let renderer: Renderer;
	try {
		renderer = new Renderer(canvas, { fullscreenVert, present, shapeVert, shapeFrag });
	} catch (e) {
		mount.appendChild(el("div", { class: "fatal" }, el("h1", {}, "WebGL2 unavailable"), el("p", {}, e instanceof Error ? e.message : String(e)), el("p", {}, "This sandbox needs a browser with WebGL2 enabled.")));
		return;
	}

	const store = new Store();
	await store.init(renderer, defaultShader);

	const app = createApp(store, canvas, () => defaultShader);
	mount.appendChild(app.root);
	await finishOpenRouterSignIn(store, mount, app.openSettings);
}

/** Restore the settings draft and complete a returning OpenRouter sign-in. */
async function finishOpenRouterSignIn(store: Store, mount: HTMLElement, openSettings: () => void): Promise<void> {
	const draft = readSettingsDraft(sessionStorage.getItem(OPENROUTER_DRAFT_KEY));
	const result = await completeOpenRouterSignIn(location.href, sessionStorage.getItem(OPENROUTER_VERIFIER_KEY));
	if (!result && !draft) return;
	let chat = mergeSettingsDraft(store.settings.chat, draft);
	sessionStorage.removeItem(OPENROUTER_DRAFT_KEY);
	if (result) {
		sessionStorage.removeItem(OPENROUTER_VERIFIER_KEY);
		history.replaceState(null, "", result.url);
	}
	if (result?.key) {
		const isPreset = Object.values(MODEL_PRESETS).some((list) => list.includes(chat.model));
		chat = {
			...chat,
			provider: "openrouter",
			model: isPreset && !MODEL_PRESETS.openrouter.includes(chat.model) ? MODEL_PRESETS.openrouter[0] : chat.model,
			apiKeys: { ...chat.apiKeys, openrouter: result.key },
		};
	} else if (result?.error) {
		mount.appendChild(el("div", { class: "banner error", attrs: { role: "status" } }, `OpenRouter sign-in failed: ${result.error}`));
	}
	store.updateSettings({ chat });
	openSettings();
}

boot().catch((e) => {
	const mount = document.getElementById("app") ?? document.body;
	mount.appendChild(el("div", { class: "fatal" }, el("h1", {}, "Failed to start"), el("pre", {}, e instanceof Error ? (e.stack ?? e.message) : String(e))));
});
