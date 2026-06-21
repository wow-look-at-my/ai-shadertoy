// Persistence. Projects and image assets live in IndexedDB (they can be large
// -- conversations carry screenshots, assets carry full images). Settings and
// the current-project pointer live in localStorage for synchronous startup.
// Everything is exportable/importable as a single JSON bundle.

import type { ExportBundle, ImageAsset, Project, Settings } from "./types.ts";
import { normalizeProject } from "./defaults.ts";

const DB_NAME = "ai-shadertoy";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_ASSETS = "assets";
const LS_SETTINGS = "ai-shadertoy:settings";
const LS_CURRENT = "ai-shadertoy:current";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
			if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS, { keyPath: "id" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
	});
	return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(store, mode);
				const req = fn(t.objectStore(store));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			}),
	);
}

function getAll<T>(store: string): Promise<T[]> {
	return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export const db = {
	saveProject: (p: Project) => tx(STORE_PROJECTS, "readwrite", (s) => s.put(p)),
	// Normalize on read so legacy single-pass records (and any partial/imported
	// shapes) become current-shape Projects before the app touches them.
	loadProjects: () => getAll<unknown>(STORE_PROJECTS).then((rows) => rows.map(normalizeProject)),
	deleteProject: (id: string) => tx(STORE_PROJECTS, "readwrite", (s) => s.delete(id)),
	saveAsset: (a: ImageAsset) => tx(STORE_ASSETS, "readwrite", (s) => s.put(a)),
	loadAssets: () => getAll<ImageAsset>(STORE_ASSETS),
	deleteAsset: (id: string) => tx(STORE_ASSETS, "readwrite", (s) => s.delete(id)),
};

// ---- settings (localStorage) ------------------------------------------------

export function loadSettingsRaw(): Partial<Settings> | null {
	try {
		const raw = localStorage.getItem(LS_SETTINGS);
		return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
	} catch {
		return null;
	}
}

export function saveSettings(s: Settings): void {
	try {
		localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
	} catch {
		/* quota or disabled storage: ignore */
	}
}

export function getCurrentProjectId(): string | null {
	return localStorage.getItem(LS_CURRENT);
}
export function setCurrentProjectId(id: string): void {
	try {
		localStorage.setItem(LS_CURRENT, id);
	} catch {
		/* ignore */
	}
}

// ---- persistent storage -----------------------------------------------------

export async function requestPersistence(): Promise<boolean> {
	try {
		if (navigator.storage?.persist) {
			if (await navigator.storage.persisted()) return true;
			return await navigator.storage.persist();
		}
	} catch {
		/* ignore */
	}
	return false;
}

export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
	try {
		if (navigator.storage?.estimate) {
			const e = await navigator.storage.estimate();
			return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
		}
	} catch {
		/* ignore */
	}
	return null;
}

// ---- export / import --------------------------------------------------------

function stripKeys(settings: Settings): Settings {
	const clone = structuredClone(settings);
	clone.chat.apiKey = "";
	clone.imageGen.apiKey = "";
	return clone;
}

export async function buildExport(opts: { includeSettings: boolean; includeKeys: boolean }): Promise<ExportBundle> {
	const projects = await db.loadProjects();
	const assets = await db.loadAssets();
	const bundle: ExportBundle = { kind: "ai-shadertoy-export", version: 1, exportedAt: Date.now(), projects, assets };
	if (opts.includeSettings) {
		const raw = loadSettingsRaw();
		if (raw) bundle.settings = opts.includeKeys ? (raw as Settings) : stripKeys(raw as Settings);
	}
	return bundle;
}

export async function importBundle(bundle: ExportBundle, mode: "merge" | "replace"): Promise<{ projects: number; assets: number }> {
	if (bundle.kind !== "ai-shadertoy-export") throw new Error("Not an ai-shadertoy export file.");
	if (mode === "replace") {
		const existing = await db.loadProjects();
		for (const p of existing) await db.deleteProject(p.id);
		const ea = await db.loadAssets();
		for (const a of ea) await db.deleteAsset(a.id);
	}
	for (const p of bundle.projects) await db.saveProject(normalizeProject(p));
	for (const a of bundle.assets) await db.saveAsset(a);
	return { projects: bundle.projects.length, assets: bundle.assets.length };
}
