// Default settings and project factories.

import type { Channel, Layer, Pass, ProviderId, Project, Settings, Shape, ShapeKind, Uniform } from "./types.ts";
import { channelsForSource, emptyChannel, ensureMaskCompositePass, makeLayer, makePass, makeShape, MAX_INPUTS } from "./types.ts";
import { isShapeKind } from "../gl/shapes.ts";
import { uid } from "../util/misc.ts";

export interface ProviderInfo {
	label: string;
	/** Which request/response translation providers.ts uses. Everything except
	 * Anthropic speaks OpenAI Chat Completions. */
	wire: "anthropic" | "openai";
	/** Used when the user leaves the base-URL override blank. */
	baseUrl: string;
	/** The endpoint sends no `access-control-allow-origin`, so a browser cannot
	 * read its reply and the CORS proxy has to carry the request. Measured
	 * against the live endpoints, not assumed -- see README. */
	needsProxy: boolean;
	/** Convenient picks for the model combobox; free text is still accepted, and
	 * the refresh button replaces these with the provider's own list. */
	models: string[];
	/** The models endpoint rejects an unauthenticated request, so the combobox
	 * cannot fill itself until a key is entered. OpenRouter and Ollama Cloud
	 * both serve their catalogue openly. */
	needsKeyForModels: boolean;
	/** Chat requires an API key. Only the generic OpenAI-compatible provider can
	 * legitimately run keyless, against a local server. */
	needsKey: boolean;
}

// Anthropic defaults to Opus 4.8 (the most capable current model). Fable 5 is
// intentionally omitted: it forces always-on thinking, whose replay rules the
// simple browser tool-loop here does not implement.
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
	anthropic: {
		label: "Anthropic (Claude)",
		wire: "anthropic",
		baseUrl: "https://api.anthropic.com",
		needsProxy: false,
		models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"],
		needsKeyForModels: true,
		needsKey: true,
	},
	openai: {
		label: "OpenAI-compatible",
		wire: "openai",
		baseUrl: "https://api.openai.com/v1",
		needsProxy: false,
		models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"],
		needsKeyForModels: true,
		needsKey: false,
	},
	openrouter: {
		label: "OpenRouter",
		wire: "openai",
		baseUrl: "https://openrouter.ai/api/v1",
		needsProxy: false,
		models: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-5.6-terra", "google/gemini-3.7-flash", "z-ai/glm-5.3", "deepseek/deepseek-v4-pro"],
		needsKeyForModels: false,
		needsKey: true,
	},
	"ollama-cloud": {
		label: "Ollama Cloud",
		wire: "openai",
		baseUrl: "https://ollama.com/v1",
		needsProxy: true,
		models: ["kimi-k2.7-code", "glm-5.3-flash", "deepseek-v4-pro:0813", "gpt-oss:120b", "qwen3.5:397b", "minimax-m3"],
		needsKeyForModels: false,
		needsKey: true,
	},
};

export const MODEL_PRESETS: Record<ProviderId, string[]> = {
	anthropic: PROVIDERS.anthropic.models,
	openai: PROVIDERS.openai.models,
	openrouter: PROVIDERS.openrouter.models,
	"ollama-cloud": PROVIDERS["ollama-cloud"].models,
};

/** The base URL a request actually uses: the user's override, else the
 * provider's own default. */
export function providerBaseUrl(provider: ProviderId, override: string): string {
	return override.trim() || PROVIDERS[provider].baseUrl;
}

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
	proxyUrl: "https://proxy.pazer.ai/?url={{.url}}",
	renderScale: 1,
	squarePixels: true,
	autoScreenshot: false,
	screenshotMaxDim: 512,
	persistRequested: false,
};

/** A proxy setting saved before templates existed is a bare base URL, and which
 * rule it meant depended on the version that saved it: the pazer proxy reads a
 * `?url=` parameter, everything else was joined as a prefix. Rewrite it into the
 * template that reproduces exactly that, so the Settings field states the rule
 * instead of leaving it implicit. */
export function migrateProxyTemplate(value: string): string {
	const v = value.trim();
	if (!v) return DEFAULT_SETTINGS.proxyUrl;
	if (/\{\{\s*\.(rawurl|url)\s*\}\}/.test(v)) return v;
	const base = v.replace(/\/+$/, "");
	if (/(^|\/\/|\.)proxy\.pazer\.ai(\/|:|$)/i.test(base)) return `${base}/?url={{.url}}`;
	return `${base}/{{.rawurl}}`;
}

export function mergeSettings(partial: Partial<Settings> | null): Settings {
	if (!partial) return structuredClone(DEFAULT_SETTINGS);
	const merged: Settings = {
		...DEFAULT_SETTINGS,
		...partial,
		chat: { ...DEFAULT_SETTINGS.chat, ...(partial.chat ?? {}) },
		imageGen: { ...DEFAULT_SETTINGS.imageGen, ...(partial.imageGen ?? {}) },
	};
	merged.proxyUrl = migrateProxyTemplate(merged.proxyUrl);
	return merged;
}

export const STARTER_UNIFORMS: Uniform[] = [];

/** A fresh project: one "Base" layer wrapping a single "Image" pass (no
 * geometry), matching the classic single-shader starting point. New layers are
 * stacked on top of this. */
export function makeProject(name: string, shaderSource: string): Project {
	const now = Date.now();
	const output = makePass("Image", shaderSource, channelsForSource(shaderSource));
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
	// Legacy `x`/`y` graph-editor coordinates (if present) are dropped: the Passes
	// view now auto-lays the DAG out from its edges (see ui/graphlayout.ts).
	const fallback = makePass(r.name ?? `Pass ${i + 1}`, r.source ?? "", normalizeChannels(r.channels, r.source ?? ""));
	return {
		id: typeof r.id === "string" && r.id ? r.id : fallback.id,
		name: r.name ?? fallback.name,
		source: r.source ?? "",
		channels: normalizeChannels(r.channels, r.source ?? ""),
		format: r.format === "rgba16f" ? "rgba16f" : "rgba8",
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
		layers = [normalizeLayer({ name: "Base", passes: r.passes, outputPassId: r.outputPassId }, 0)];
	} else {
		const output = makePass("Image", r.shaderSource ?? "", normalizeChannels(r.channels));
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
