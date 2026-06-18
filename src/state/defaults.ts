// Default settings and project factories.

import type { ProviderId, Project, Settings, Uniform } from "./types.ts";
import { defaultChannels } from "./types.ts";
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
	return {
		id: uid("p_"),
		name,
		shaderSource,
		uniforms: [],
		channels: defaultChannels(),
		messages: [],
		createdAt: now,
		updatedAt: now,
	};
}
