// What a provider's /models listing publishes about each model: limits,
// prices and capabilities.

/** USD per tokens. */
export interface PublishedRate {
	in: number;
	out: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface PublishedModel {
	contextWindow?: number;
	maxOutput?: number;
	rate?: PublishedRate;
	/** Request parameters the model accepts; undefined when the listing does not say. */
	params?: ReadonlySet<string>;
	/** Input kinds the model takes ("text", "image", ...); undefined when the listing does not say. */
	inputModalities?: ReadonlySet<string>;
	reasoning?: { mandatory: boolean; defaultEnabled: boolean; efforts: string[]; defaultEffort?: string };
}

const PER_M = 1_000_000;

function positive(v: unknown): number | undefined {
	return typeof v === "number" && v > 0 ? v : undefined;
}

/** A per-token price as a string or number, converted to USD per tokens. */
function perMillion(v: unknown): number | undefined {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n * PER_M : undefined;
}

function strings(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
}

/** One listing entry as published model info. */
export function parseModelEntry(entry: Record<string, unknown>): PublishedModel {
	const top = (entry["top_provider"] ?? {}) as Record<string, unknown>;
	const out: PublishedModel = {};
	const contextWindow = positive(entry["context_length"]) ?? positive(top["context_length"]) ?? positive(entry["max_input_tokens"]);
	if (contextWindow !== undefined) out.contextWindow = contextWindow;
	const maxOutput = positive(top["max_completion_tokens"]) ?? positive(entry["max_tokens"]);
	if (maxOutput !== undefined) out.maxOutput = maxOutput;
	const pricing = entry["pricing"] as Record<string, unknown> | undefined;
	const rateIn = perMillion(pricing?.["prompt"]);
	const rateOut = perMillion(pricing?.["completion"]);
	if (rateIn !== undefined && rateOut !== undefined) {
		// An unlisted cache price means cached tokens are billed at the plain input rate.
		out.rate = { in: rateIn, out: rateOut, cacheRead: perMillion(pricing?.["input_cache_read"]) ?? rateIn, cacheWrite: perMillion(pricing?.["input_cache_write"]) ?? rateIn };
	}
	const params = strings(entry["supported_parameters"]);
	if (params) out.params = new Set(params);
	const modalities = strings((entry["architecture"] as Record<string, unknown> | undefined)?.["input_modalities"]);
	if (modalities) out.inputModalities = new Set(modalities);
	const r = entry["reasoning"] as Record<string, unknown> | undefined;
	if (r && typeof r === "object") {
		out.reasoning = { mandatory: r["mandatory"] === true, defaultEnabled: r["default_enabled"] === true, efforts: strings(r["supported_efforts"]) ?? [] };
		if (typeof r["default_effort"] === "string") out.reasoning.defaultEffort = r["default_effort"];
	}
	return out;
}

// What the chat endpoint's own /models listing says (it alone knows which parameters that endpoint accepts), and what
// the shared catalogue says (it fills limits, prices and input kinds the endpoint's listing leaves out).
const listed = new Map<string, PublishedModel>();
const catalogue = new Map<string, PublishedModel>();

export const CATALOGUE_URL = "https://modelinfo.pazer.ai/v1/models";

const key = (model: string): string => model.trim().toLowerCase();

/** Record every model the chat endpoint's /models listing returned, by id. */
export function recordModelListing(items: unknown[]): void {
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const id = entry["id"] ?? entry["name"];
		if (typeof id === "string" && id) listed.set(key(id), parseModelEntry(entry));
	}
}

/** Record the catalogue's entry for a model. */
export function recordCatalogueEntry(model: string, entry: Record<string, unknown>): void {
	catalogue.set(key(model), parseModelEntry(entry));
}

/** Fetch the catalogue's entry for a model (modelinfo.pazer.ai answers to any of a model's names). A model it does not know records nothing. */
export async function fetchCatalogueEntry(model: string): Promise<void> {
	const path = model.trim().split("/").map(encodeURIComponent).join("/");
	const res = await fetch(`${CATALOGUE_URL}/${path}`);
	if (res.status === 404) return;
	if (!res.ok) throw new Error(`modelinfo ${res.status} for ${model}`);
	recordCatalogueEntry(model, (await res.json()) as Record<string, unknown>);
}

/** Everything known about a model: the endpoint's listing first, the catalogue for what it leaves out. */
export function publishedModel(model: string): PublishedModel | undefined {
	const own = listed.get(key(model));
	const shared = catalogue.get(key(model));
	if (!own && !shared) return undefined;
	const out: PublishedModel = { ...shared, ...own };
	// Which parameters are accepted is a property of the endpoint, so only its own listing answers it.
	if (own?.params) out.params = own.params;
	else delete out.params;
	if (own?.reasoning) out.reasoning = own.reasoning;
	else delete out.reasoning;
	return out;
}

/** False only when the endpoint's listing says the model does not accept `param`. */
export function acceptsParam(model: string, param: string): boolean {
	const params = publishedModel(model)?.params;
	return !params || params.has(param);
}

/** False only when a listing says the model takes no image input. */
export function acceptsImages(model: string): boolean {
	const modalities = publishedModel(model)?.inputModalities;
	return !modalities || modalities.has("image");
}
