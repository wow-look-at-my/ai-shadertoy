// Persistence.

import type { ExportBundle, ImageAsset, Project, Settings } from "./types.ts";
import { normalizeProject } from "./defaults.ts";

const DB_NAME = "ai-shadertoy";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_ASSETS = "assets";
const LS_SETTINGS = "ai-shadertoy:settings";
const LS_CURRENT = "ai-shadertoy:current";

let dbPromise: Promise<IDBDatabase> | null = null;

// A failed open is not cached: the next call tries again instead of failing
// every later write for the life of the page.
function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
			if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS, { keyPath: "id" });
		};
		req.onblocked = () => reject(new Error("The database is open in another tab at an older version; close that tab and reload."));
		req.onsuccess = () => {
			const db = req.result;
			// Another tab upgrading the schema needs this connection closed; the
			// next call reopens at the new version.
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			resolve(db);
		};
		req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
	});
	dbPromise.catch(() => {
		dbPromise = null;
	});
	return dbPromise;
}

/** Run `fn` inside one transaction over `stores`, resolving with the last
 * request's result once the transaction COMMITS. A commit-time abort (how a
 * quota overrun surfaces) rejects, which `req.onsuccess` alone would hide. */
function tx<T>(stores: string | string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(stores, mode);
				let result: T | undefined;
				const req = fn(t);
				if (req) req.onsuccess = () => (result = req.result);
				t.oncomplete = () => resolve(result as T);
				t.onerror = () => reject(t.error ?? new Error("indexedDB transaction failed"));
				t.onabort = () => reject(t.error ?? new Error("indexedDB transaction aborted"));
			}),
	);
}

function getAll<T>(store: string): Promise<T[]> {
	return tx<T[]>(store, "readonly", (t) => t.objectStore(store).getAll() as IDBRequest<T[]>);
}

export const db = {
	saveProject: (p: Project) => tx(STORE_PROJECTS, "readwrite", (t) => t.objectStore(STORE_PROJECTS).put(p)),
	// Normalize on read so legacy single-pass records.
	loadProjects: () => getAll<unknown>(STORE_PROJECTS).then((rows) => rows.map(normalizeProject)),
	deleteProject: (id: string) => tx(STORE_PROJECTS, "readwrite", (t) => t.objectStore(STORE_PROJECTS).delete(id)),
	saveAsset: (a: ImageAsset) => tx(STORE_ASSETS, "readwrite", (t) => t.objectStore(STORE_ASSETS).put(a)),
	loadAssets: () => getAll<ImageAsset>(STORE_ASSETS),
	deleteAsset: (id: string) => tx(STORE_ASSETS, "readwrite", (t) => t.objectStore(STORE_ASSETS).delete(id)),
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
	}
}

export function getCurrentProjectId(): string | null {
	try {
		return localStorage.getItem(LS_CURRENT);
	} catch {
		return null; // storage disabled
	}
}
export function setCurrentProjectId(id: string): void {
	try {
		localStorage.setItem(LS_CURRENT, id);
	} catch {
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

/** Check a bundle's shape BEFORE anything is deleted, so a truncated or
 * hand-edited file cannot wipe the database and then fail halfway. Pure. */
export function validateBundle(raw: unknown): { projects: Project[]; assets: ImageAsset[]; settings?: Partial<Settings> } {
	const b = (raw ?? {}) as Partial<ExportBundle>;
	if (b.kind !== "ai-shadertoy-export") throw new Error("Not an ai-shadertoy export file.");
	if (!Array.isArray(b.projects)) throw new Error("Export file has no projects list.");
	if (!Array.isArray(b.assets)) throw new Error("Export file has no assets list.");
	const assets: ImageAsset[] = [];
	b.assets.forEach((a, i) => {
		const r = (a ?? {}) as Partial<ImageAsset>;
		if (typeof r.id !== "string" || !r.id || typeof r.dataUrl !== "string" || !r.dataUrl) throw new Error(`Asset ${i + 1} in the export file has no id or data.`);
		assets.push({ ...r, id: r.id, dataUrl: r.dataUrl, name: typeof r.name === "string" && r.name ? r.name : `asset ${i + 1}` } as ImageAsset);
	});
	const settings = b.settings && typeof b.settings === "object" ? (b.settings as Partial<Settings>) : undefined;
	return { projects: b.projects.map(normalizeProject), assets, settings };
}

/** Write a validated bundle. In `replace` mode the delete and the writes share
 * one transaction, so the database is never left half-imported. */
export async function importBundle(raw: unknown, mode: "merge" | "replace"): Promise<{ projects: number; assets: number; settings?: Partial<Settings> }> {
	const { projects, assets, settings } = validateBundle(raw);
	await tx([STORE_PROJECTS, STORE_ASSETS], "readwrite", (t) => {
		const ps = t.objectStore(STORE_PROJECTS);
		const as = t.objectStore(STORE_ASSETS);
		if (mode === "replace") {
			ps.clear();
			as.clear();
		}
		for (const p of projects) ps.put(p);
		for (const a of assets) as.put(a);
	});
	return { projects: projects.length, assets: assets.length, settings };
}
