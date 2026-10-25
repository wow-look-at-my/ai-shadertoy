// Unit tests for published model info: parsing a /models entry, merging the
// endpoint's listing with the catalogue, and the request gates it drives.

import { acceptsImages, acceptsParam, parseModelEntry, publishedModel, recordCatalogueEntry, recordModelListing } from "../src/ai/modelinfo.ts";
import { anthropicBody, openaiBody } from "../src/ai/providers.ts";
import { DEFAULT_SETTINGS } from "../src/state/defaults.ts";
import type { ChatConfig, Message } from "../src/state/types.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}

// OpenRouter's entry for the HAR's model, trimmed to the fields that matter.
const DEEPSEEK = {
	id: "deepseek/deepseek-v4.1-flash-1017",
	context_length: 1048576,
	architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"] },
	pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" },
	top_provider: { context_length: 1048576, max_completion_tokens: 393216, is_moderated: false },
	supported_parameters: ["include_reasoning", "max_tokens", "reasoning", "reasoning_effort", "temperature", "tool_choice", "tools"],
	reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["max", "high", "low", "none"], default_effort: "high" },
};

// ---- parsing ----------------------------------------------------------------
{
	const info = parseModelEntry(DEEPSEEK);
	eq(info.contextWindow, 1048576, "context_length is read");
	eq(info.maxOutput, 393216, "top_provider.max_completion_tokens is read");
	eq(Math.abs((info.rate?.in ?? 0) - 0.15) < 1e-9, true, "prompt price becomes USD per million");
	eq(Math.abs((info.rate?.out ?? 0) - 0.6) < 1e-9, true, "completion price becomes USD per million");
	eq(Math.abs((info.rate?.cacheRead ?? 0) - 0.003) < 1e-9, true, "cache-read price is read");
	eq(info.params?.has("tools"), true, "supported_parameters are read");
	eq(info.inputModalities?.has("image"), true, "input modalities are read");
	eq(info.reasoning?.defaultEffort, "high", "the reasoning object is read");
	eq(info.reasoning?.defaultEnabled, true, "with default_enabled");
	eq(parseModelEntry({ id: "bare" }).params, undefined, "a listing with no parameter list says nothing about parameters");
}

// ---- merge: the endpoint's listing first, the catalogue for the rest ---------
{
	recordCatalogueEntry("claude-opus-5", { id: "anthropic/claude-opus-5", context_length: 1000000, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } });
	recordModelListing([{ id: "claude-opus-5", max_input_tokens: 1000000 }]);
	const merged = publishedModel("claude-opus-5");
	eq(merged?.maxOutput, 128000, "the catalogue fills a limit the endpoint's listing leaves out");
	eq(merged?.params, undefined, "accepted parameters come only from the endpoint's own listing");
	eq(acceptsParam("claude-opus-5", "temperature"), true, "an unlisted parameter list never blocks a parameter");
	eq(acceptsImages("never-listed"), true, "an unknown model is assumed to take images");
}

// ---- request gates ------------------------------------------------------------
const cfg = (model: string, over: Partial<ChatConfig> = {}): ChatConfig => ({ ...DEFAULT_SETTINGS.chat, provider: "openrouter", model, ...over });
const SCREENSHOT: Message = { id: "u", role: "user", ts: 0, blocks: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/webp", data: "AAAA" }] };
{
	recordModelListing([DEEPSEEK, { id: "plain/text-model", supported_parameters: ["max_tokens", "tools"], architecture: { input_modalities: ["text"] }, top_provider: { max_completion_tokens: 4096 } }]);

	const ds = openaiBody(cfg(DEEPSEEK.id, { maxTokens: 64000, temperature: 0.5 }), "sys", "", [SCREENSHOT], []);
	eq(JSON.stringify(ds["reasoning"]), '{"enabled":true}', "a model that takes reasoning gets it on");
	eq(ds["temperature"], 0.5, "a model that takes temperature gets it");
	eq(ds["max_tokens"], 64000, "a limit under the model's maximum passes through");
	const dsUser = (ds["messages"] as Array<Record<string, unknown>>)[1]["content"] as Array<Record<string, unknown>>;
	eq(dsUser[1]["type"], "image_url", "a vision model gets the image");

	const plain = openaiBody(cfg("plain/text-model", { maxTokens: 64000, temperature: 0.5 }), "sys", "", [SCREENSHOT], []);
	eq("reasoning" in plain, false, "a model that lists no reasoning parameter gets none");
	eq("temperature" in plain, false, "a model that lists no temperature parameter gets none");
	eq(plain["max_tokens"], 4096, "the limit is held to the model's published maximum");
	const plainUser = (plain["messages"] as Array<Record<string, unknown>>)[1]["content"] as string;
	eq(plainUser, "look\n[image not sent: plain/text-model takes no image input]", "a text-only model gets a note in the image's place");
	eq(SCREENSHOT.blocks[1].type, "image", "the stored message keeps its image");

	recordCatalogueEntry("claude-sonnet-5", { id: "anthropic/claude-sonnet-5", top_provider: { max_completion_tokens: 64000 } });
	eq(anthropicBody({ ...DEFAULT_SETTINGS.chat, provider: "anthropic", model: "claude-sonnet-5", maxTokens: 200000 }, "sys", "", [SCREENSHOT], [])["max_tokens"], 64000, "the Anthropic wire holds the limit to the published maximum too");
}

console.log(`ok - ${passed} assertions passed`);
