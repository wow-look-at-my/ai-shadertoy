// Default settings and project factories.

import type { Channel, Layer, Pass, ProviderId, Project, Settings, Shape, ShapeKind, Uniform } from "./types.ts";
import { channelsForSource, emptyChannel, ensureMaskCompositePass, makeLayer, makePass, makeShape, MAX_INPUTS } from "./types.ts";
import { isShapeKind } from "../gl/shapes.ts";
import { applyLayout } from "../util/graphlayout.ts";
import { uid } from "../util/misc.ts";

// Model presets per provider. Free-text entry is still allowed in Settings; these
// are just the convenient picks. Anthropic defaults to Opus 4.8 (the most capable
// current model). Fable 5 is intentionally omitted: it forces always-on thinking,
// whose replay rules the simple browser tool-loop here does not implement.
export const MODEL_PRESETS: Record<ProviderId, string[]> = {
	anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"],
	openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"],
};

export const DEFAULT_SETTINGS: Settings = {
	chat: {
		provider: "anthropic",
		baseUrl: "",
		apiKey: "",
		model: "claude-opus-4-8",
		maxTokens: 16384,
		temperature: 0.7,
		useProxy: false,
		toolMode: "native",
	},
	imageGen: {
		enabled: false,
		baseUrl: "https://api.openai.com/v1",
		apiKey: "",
		model: "gpt-image-1",
		size: "512x512",
		useProxy: false,
	},
	proxyUrl: "https://proxy.pazer.ai/",
	renderScale: 1,
	autoScreenshot: false,
	screenshotMaxDim: 512,
	persistRequested: false,
};

export function mergeSettings(partial: Partial<Settings> | null): Settings {
	if (!partial) return structuredClone(DEFAULT_SETTINGS);
	return {
		...DEFAULT_SETTINGS,
		...partial,
		chat: { ...DEFAULT_SETTINGS.chat, ...(partial.chat ?? {}) },
		imageGen: { ...DEFAULT_SETTINGS.imageGen, ...(partial.imageGen ?? {}) },
	};
}

export const STARTER_UNIFORMS: Uniform[] = [];

/** A fresh project: one "Base" layer wrapping a single "Image" pass (no
 * geometry), matching the classic single-shader starting point. New layers are
 * stacked on top of this. */
export function makeProject(name: string, shaderSource: string): Project {
	const now = Date.now();
	const output = makePass("Image", shaderSource, channelsForSource(shaderSource), 320, 60);
	const base = makeLayer("Base", [output], output.id, []);
	return {
		id: uid("p_"),
		name,
		layers: [base],
		uniforms: [],
		messages: [],
		createdAt: now,
		updatedAt: now,
	};
}

// ---- migration -------------------------------------------------------------

interface LegacyProject {
	id?: string;
	name?: string;
	shaderSource?: string; // very old: a single shader
	channels?: unknown; // very old: that shader's four channels
	uniforms?: Uniform[];
	messages?: Project["messages"];
	createdAt?: number;
	updatedAt?: number;
	passes?: unknown; // mid-era: a flat render graph (one implicit layer)
	outputPassId?: string;
	layers?: unknown; // current: a stack of layers
}

function clampNum(v: unknown, lo: number, hi: number, d: number): number {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

function normalizeChannels(raw: unknown, source = ""): Channel[] {
	// Variable-length input list (0..MAX_INPUTS). Explicit legacy arrays are
	// preserved; missing arrays are inferred from the shader's iChannel references.
	if (!Array.isArray(raw)) return channelsForSource(source).slice(0, MAX_INPUTS);
	const n = Math.min(raw.length, MAX_INPUTS);
	const out: Channel[] = [];
	for (let i = 0; i < n; i++) {
		const c = raw[i] as Partial<Channel> | undefined;
		out.push(c && typeof c === "object" ? { ...emptyChannel(), ...c } : emptyChannel());
	}
	return out;
}

function normalizePass(raw: unknown, i: number): Pass {
	const r = (raw ?? {}) as Partial<Pass>;
	const fallback = makePass(r.name ?? `Pass ${i + 1}`, r.source ?? "", normalizeChannels(r.channels, r.source ?? ""), 40 + i * 240, 60);
	return {
		id: typeof r.id === "string" && r.id ? r.id : fallback.id,
		name: r.name ?? fallback.name,
		source: r.source ?? "",
		channels: normalizeChannels(r.channels, r.source ?? ""),
		format: r.format === "rgba16f" ? "rgba16f" : "rgba8",
		x: typeof r.x === "number" ? r.x : fallback.x,
		y: typeof r.y === "number" ? r.y : fallback.y,
	};
}

function normalizeShape(raw: unknown): Shape {
	const r = (raw ?? {}) as Partial<Shape>;
	const kind: ShapeKind = typeof r.kind === "string" && isShapeKind(r.kind) ? r.kind : "quad";
	const color = Array.isArray(r.color) ? r.color : [];
	const c = (idx: number, d: number) => clampNum(color[idx], 0, 1, d);
	const s = makeShape(kind, {
		x: clampNum(r.x, -2, 3, 0.5),
		y: clampNum(r.y, -2, 3, 0.5),
		w: clampNum(r.w, 0, 4, 0.4),
		h: clampNum(r.h, 0, 4, 0.4),
		rotation: Number.isFinite(Number(r.rotation)) ? Number(r.rotation) : 0,
		color: [c(0, 0.9), c(1, 0.3), c(2, 0.4), c(3, 1)],
		cornerRadius: clampNum(r.cornerRadius, 0, 1, 0),
		feather: clampNum(r.feather, 0, 500, 0),
		falloff: clampNum(r.falloff, 0, 1, 0),
	});
	if (typeof r.id === "string" && r.id) s.id = r.id;
	return s;
}

function normalizeLayer(raw: unknown, i: number): Layer {
	const r = (raw ?? {}) as Partial<Layer>;
	const passesRaw = Array.isArray(r.passes) && r.passes.length ? r.passes : [{ name: "Image", source: "" }];
	const passes = passesRaw.map((p, j) => normalizePass(p, j));
	const outputPassId = passes.some((p) => p.id === r.outputPassId) ? r.outputPassId! : passes[passes.length - 1].id;
	const shapes = Array.isArray(r.shapes) ? r.shapes.map(normalizeShape) : [];
	const layer: Layer = {
		id: typeof r.id === "string" && r.id ? r.id : uid("layer_"),
		name: typeof r.name === "string" && r.name ? r.name : `Layer ${i + 1}`,
		visible: r.visible !== false,
		opacity: clampNum(r.opacity, 0, 1, 1),
		passes,
		outputPassId,
		shapes,
	};
	if (r.mask && typeof r.mask === "object") {
		layer.mask = normalizeLayer(r.mask, 0);
		ensureMaskCompositePass(layer);
	}
	// Node positions are owned by the dependency auto-layout, never persisted state,
	// so always (re)derive them on load -- ignoring whatever x/y happen to be stored.
	applyLayout(layer);
	return layer;
}

/** Coerce a persisted/imported record into a current-shape Project. Three eras:
 * `layers` (current) pass through normalized; a flat `passes`/`outputPassId`
 * graph becomes one "Base" layer; the oldest single `shaderSource` becomes one
 * "Base" layer with one "Image" pass. */
export function normalizeProject(raw: unknown): Project {
	const r = (raw ?? {}) as LegacyProject;
	const now = Date.now();
	let layers: Layer[];
	if (Array.isArray(r.layers) && r.layers.length) {
		layers = r.layers.map((l, i) => normalizeLayer(l, i));
	} else if (Array.isArray(r.passes) && r.passes.length) {
		// Mid-era flat graph -> one "Base" layer (normalizeLayer lays it out).
		layers = [normalizeLayer({ name: "Base", passes: r.passes, outputPassId: r.outputPassId }, 0)];
	} else {
		const output = makePass("Image", r.shaderSource ?? "", normalizeChannels(r.channels), 320, 60);
		layers = [makeLayer("Base", [output], output.id, [])];
	}
	return {
		id: r.id ?? uid("p_"),
		name: r.name ?? "Untitled shader",
		layers,
		uniforms: Array.isArray(r.uniforms) ? r.uniforms : [],
		messages: Array.isArray(r.messages) ? r.messages : [],
		createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
		updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : now,
	};
}
