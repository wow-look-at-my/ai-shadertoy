// Entry point. Sets up the renderer, store, and UI, then mounts the app.
// The default shader is loaded from a .glsl asset (embedded into the single-file
// bundle by ts0's fetch interceptor).

import { Renderer } from "./gl/renderer.ts";
import { Store } from "./state/store.ts";
import { createApp } from "./ui/app.ts";
import { el } from "./util/dom.ts";

async function loadText(relPath: string): Promise<string> {
	// Pass a string (.href), not a URL object: ts0's fetch interceptor only
	// matches string / Request inputs, so a bare URL object would bypass the
	// embedded-asset map and hit the (nonexistent) network path.
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
	const [vertSource, presentSource] = await Promise.all([loadText("./src/shaders/fullscreen.vert.glsl"), loadText("./src/shaders/present.frag.glsl")]);

	const canvas = el("canvas", { class: "gl" });
	let renderer: Renderer;
	try {
		renderer = new Renderer(canvas, vertSource, presentSource);
	} catch (e) {
		mount.appendChild(el("div", { class: "fatal" }, el("h1", {}, "WebGL2 unavailable"), el("p", {}, e instanceof Error ? e.message : String(e)), el("p", {}, "This sandbox needs a browser with WebGL2 enabled.")));
		return;
	}

	const store = new Store();
	await store.init(renderer, defaultShader);

	// TEMP DEBUG HOOK (remove): expose internals for live inspection.
	(window as unknown as Record<string, unknown>).__shadertoy = { store, renderer };

	mount.appendChild(createApp(store, canvas, () => defaultShader));
}

boot().catch((e) => {
	const mount = document.getElementById("app") ?? document.body;
	mount.appendChild(el("div", { class: "fatal" }, el("h1", {}, "Failed to start"), el("pre", {}, e instanceof Error ? (e.stack ?? e.message) : String(e))));
});
