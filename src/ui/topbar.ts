// Top bar: project name + switcher, new/duplicate, import/export, settings.

import { el, render } from "../util/dom.ts";
import { downloadFile, pickFile } from "../util/misc.ts";
import { buildExport } from "../state/persist.ts";
import type { ExportBundle } from "../state/types.ts";
import type { Store } from "../state/store.ts";

export interface TopbarDeps {
	store: Store;
	defaultShader: () => string;
	openSettings: () => void;
}

export function createTopbar(deps: TopbarDeps): HTMLElement {
	const { store } = deps;

	const nameInput = el("input", {
		class: "proj-name",
		type: "text",
		title: "Project name",
		on: {
			change: () => store.renameProject(nameInput.value.trim() || "Untitled shader"),
		},
	});

	const switcher = el("select", {
		class: "proj-switch",
		title: "Switch project",
		on: { change: () => void store.switchProject(switcher.value) },
	});

	const refresh = () => {
		nameInput.value = store.project.name;
		render(
			switcher,
			...store.projects.map((p) => el("option", { value: p.id, attrs: { selected: p.id === store.project.id ? "selected" : undefined } }, p.name || "Untitled")),
		);
		switcher.value = store.project.id;
	};
	store.on("project", refresh);
	store.on("projects", refresh);

	const busyDot = el("span", { class: "busy-dot", title: "Agent working" });
	busyDot.hidden = true;
	store.on("busy", (b) => (busyDot.hidden = !b));

	const bar = el(
		"header",
		{ class: "topbar" },
		el("span", { class: "brand" }, el("strong", {}, "AI Shadertoy"), busyDot),
		nameInput,
		switcher,
		el("button", { class: "btn", title: "New project", on: { click: () => void store.newProject(deps.defaultShader()) } }, "+ New"),
		el("button", { class: "btn", title: "Duplicate current project", on: { click: () => void store.duplicateProject() } }, "Duplicate"),
		el("button", {
			class: "btn",
			title: "Delete current project",
			on: {
				click: () => {
					if (confirm(`Delete project "${store.project.name}"? This cannot be undone.`)) void store.deleteProject(store.project.id, deps.defaultShader());
				},
			},
		}, "Delete"),
		el("span", { class: "spacer" }),
		el("button", { class: "btn", title: "Export all projects + assets to a JSON file", on: { click: () => void doExport() } }, "Export"),
		el("button", { class: "btn", title: "Import from a JSON file", on: { click: () => void doImport(store) } }, "Import"),
		el("button", { class: "btn primary", title: "Settings (API key, model, proxy)", on: { click: deps.openSettings } }, "Settings"),
	);

	refresh();
	return bar;
}

async function doExport(): Promise<void> {
	const includeKeys = confirm("Include API keys in the export?\n\nOK = include keys (keep the file private).\nCancel = exclude keys (safe to share).");
	const bundle = await buildExport({ includeSettings: true, includeKeys });
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	downloadFile(`ai-shadertoy-${stamp}.json`, JSON.stringify(bundle, null, 2));
}

async function doImport(store: Store): Promise<void> {
	const file = await pickFile("application/json,.json");
	if (!file) return;
	let bundle: ExportBundle;
	try {
		bundle = JSON.parse(await file.text()) as ExportBundle;
	} catch {
		alert("Could not parse that file as JSON.");
		return;
	}
	const replace = confirm("Import mode:\n\nOK = REPLACE everything with the file's contents.\nCancel = MERGE the file into your current data.");
	try {
		const res = await store.importData(bundle, replace ? "replace" : "merge");
		alert(`Imported ${res.projects} project(s) and ${res.assets} asset(s).`);
	} catch (e) {
		alert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}
