// Entry point. Sets up the renderer, store, and UI, then mounts the app.

import { Renderer } from "./gl/renderer.ts";
import { Store } from "./state/store.ts";
import { MODEL_PRESETS } from "./state/defaults.ts";
import { createApp } from "./ui/app.ts";
import { completeOpenRouterSignIn, OPENROUTER_VERIFIER_KEY } from "./ai/openrouter.ts";
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

	mount.appendChild(createApp(store, canvas, () => defaultShader));
	await finishOpenRouterSignIn(store, mount);
}

/** Complete an OpenRouter sign-in that returned to this page. */
async function finishOpenRouterSignIn(store: Store, mount: HTMLElement): Promise<void> {
	const result = await completeOpenRouterSignIn(location.href, sessionStorage.getItem(OPENROUTER_VERIFIER_KEY));
	if (!result) return;
	sessionStorage.removeItem(OPENROUTER_VERIFIER_KEY);
	history.replaceState(null, "", result.url);
	if (!result.key) {
		mount.appendChild(el("div", { class: "banner error", attrs: { role: "status" } }, `OpenRouter sign-in failed: ${result.error ?? "unknown error"}`));
		return;
	}
	const chat = store.settings.chat;
	const isPreset = Object.values(MODEL_PRESETS).some((list) => list.includes(chat.model));
	const model = isPreset && !MODEL_PRESETS.openrouter.includes(chat.model) ? MODEL_PRESETS.openrouter[0] : chat.model;
	store.updateSettings({ chat: { ...chat, provider: "openrouter", apiKey: result.key, model } });
}

boot().catch((e) => {
	const mount = document.getElementById("app") ?? document.body;
	mount.appendChild(el("div", { class: "fatal" }, el("h1", {}, "Failed to start"), el("pre", {}, e instanceof Error ? (e.stack ?? e.message) : String(e))));
});
