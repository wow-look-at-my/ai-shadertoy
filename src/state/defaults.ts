// Default settings and project factories.

import type { Channel, Pass, ProviderId, Project, Settings, Uniform } from "./types.ts";
import { defaultChannels, emptyChannel, makePass, MAX_INPUTS } from "./types.ts";
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

export function makeProject(name: string, shaderSource: string): Project {
	const now = Date.now();
	const output = makePass("Image", shaderSource, defaultChannels(), 320, 60);
	return {
		id: uid("p_"),
		name,
		passes: [output],
		outputPassId: output.id,
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
	shaderSource?: string;
	channels?: [Channel, Channel, Channel, Channel];
	uniforms?: Uniform[];
	messages?: Project["messages"];
	createdAt?: number;
	updatedAt?: number;
	passes?: unknown;
	outputPassId?: string;
}

function normalizeChannels(raw: unknown): Channel[] {
	// Variable-length input list (0..MAX_INPUTS). Legacy projects stored exactly
	// four; those are preserved as four. A missing list defaults to four.
	if (!Array.isArray(raw)) return defaultChannels(4);
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
	const fallback = makePass(r.name ?? `Pass ${i + 1}`, r.source ?? "", normalizeChannels(r.channels), 40 + i * 240, 60);
	return {
		id: typeof r.id === "string" && r.id ? r.id : fallback.id,
		name: r.name ?? fallback.name,
		source: r.source ?? "",
		channels: normalizeChannels(r.channels),
		format: r.format === "rgba16f" ? "rgba16f" : "rgba8",
		x: typeof r.x === "number" ? r.x : fallback.x,
		y: typeof r.y === "number" ? r.y : fallback.y,
	};
}

/** Coerce a persisted/imported record into a current-shape Project. Legacy
 * projects stored a single `shaderSource` + `channels`; those become a single
 * "Image" output pass. Forward-compatible: already-migrated projects pass
 * through with their fields validated. */
export function normalizeProject(raw: unknown): Project {
	const r = (raw ?? {}) as LegacyProject;
	const now = Date.now();
	let passes: Pass[];
	let outputPassId: string;
	if (Array.isArray(r.passes) && r.passes.length) {
		passes = r.passes.map((p, i) => normalizePass(p, i));
		outputPassId = passes.some((p) => p.id === r.outputPassId) ? r.outputPassId! : passes[passes.length - 1].id;
	} else {
		const output = makePass("Image", r.shaderSource ?? "", normalizeChannels(r.channels), 320, 60);
		passes = [output];
		outputPassId = output.id;
	}
	return {
		id: r.id ?? uid("p_"),
		name: r.name ?? "Untitled shader",
		passes,
		outputPassId,
		uniforms: Array.isArray(r.uniforms) ? r.uniforms : [],
		messages: Array.isArray(r.messages) ? r.messages : [],
		createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
		updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : now,
	};
}
