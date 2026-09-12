// Settings modal. Everything here lives in localStorage on the user's machine;
// API keys never leave the browser except in calls the user's own key authorizes.

import { el, render } from "../util/dom.ts";
import { icon } from "../util/icons.ts";
import { debounce } from "../util/misc.ts";
import { DEFAULT_SETTINGS, MODEL_PRESETS, PROVIDERS } from "../state/defaults.ts";
import { listModels, testConnection } from "../ai/providers.ts";
import type { ProviderId, Settings, ToolMode } from "../state/types.ts";
import type { Store } from "../state/store.ts";

export interface SettingsModal {
	root: HTMLElement;
	open: () => void;
}

export function createSettings(store: Store): SettingsModal {
	const provider = el("select", {}, ...(Object.keys(PROVIDERS) as ProviderId[]).map((id) => el("option", { value: id }, PROVIDERS[id].label)));
	const toolMode = el("select", {}, el("option", { value: "native" }, "Native (function calling)"), el("option", { value: "text" }, "Text tags (no native tools)"));
	// Model id: free-text combobox backed by <datalist>. Autofill/capitalize/
	// correct/spellcheck off so a model id is never mangled or flagged. The key
	// fields below are plain text (not type=password), so the browser no longer
	// mistakes this for a login username and won't pop a credential dropdown here.
	const model = el("input", { type: "text", attrs: { list: "model-presets", placeholder: "model id", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" } });
	const modelList = el("datalist", { id: "model-presets" });
	// API keys are secrets but NOT browser passwords. A type=password field drags
	// in the whole password-manager apparatus: save prompts, strong-password
	// suggestions, and the credential dropdown that latched onto the model combobox
	// above. Plain text inputs with autofill/suggestions off keep the browser out.
	const apiKey = el("input", { type: "text", placeholder: "sk-... / your API key", attrs: { autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" } });
	const baseUrl = el("input", { type: "text", placeholder: "(optional) override base URL" });
	const maxTokens = el("input", { type: "number", attrs: { min: "256", max: "128000", step: "256" } });
	const temperature = el("input", { type: "number", attrs: { min: "0", max: "2", step: "0.05" } });
	const useProxy = el("input", { type: "checkbox" });
	const proxyUrl = el("input", { type: "text", placeholder: "https://proxy.pazer.ai/?url={{.url}}" });
	const proxyHint = el("span", { class: "hint" });
	const autoScreenshot = el("input", { type: "checkbox" });
	const shotDim = el("input", { type: "number", attrs: { min: "128", max: "1024", step: "64" } });

	const igEnabled = el("input", { type: "checkbox" });
	const igBaseUrl = el("input", { type: "text", placeholder: "https://api.openai.com/v1" });
	const igKey = el("input", { type: "text", placeholder: "(blank = reuse chat key)", attrs: { autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" } });
	const igModel = el("input", { type: "text", placeholder: "gpt-image-1" });
	const igSize = el("input", { type: "text", placeholder: "512x512" });
	const igProxy = el("input", { type: "checkbox" });

	const tempHint = el("span", { class: "hint" });

	// One Settings snapshot from the current (unsaved) form, shared by the Test
	// button and the model fetch.
	const currentProbe = (): Settings => ({
		...store.settings,
		chat: { ...store.settings.chat, provider: provider.value as ProviderId, model: model.value.trim(), baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim(), useProxy: useProxy.checked, toolMode: toolMode.value as ToolMode },
		proxyUrl: proxyUrl.value.trim() || DEFAULT_SETTINGS.proxyUrl,
	});

	// Model combobox. The <datalist> is the native combobox: it suggests
	// completions as you type while still accepting any free-text value. We seed
	// it with static presets and merge in whatever the provider's /models lists.
	let fetchedModels: string[] = [];
	const modelRefreshBtn = el("button", { class: "btn icon", type: "button", title: "Fetch available models from the provider" }, icon("refresh"));
	const modelStatus = el("span", { class: "hint" });

	const applyModelOptions = () => {
		const p = provider.value as ProviderId;
		const merged = [...new Set([...fetchedModels, ...MODEL_PRESETS[p]])];
		modelList.replaceChildren(...merged.map((m) => el("option", { value: m })));
	};
	// OpenRouter and Ollama Cloud serve their model list unauthenticated, so the
	// combobox can fill itself before a key is entered.
	const canFetchModels = () => apiKey.value.trim().length > 0 || (provider.value === "openai" && baseUrl.value.trim().length > 0) || !PROVIDERS[provider.value as ProviderId].needsKeyForModels;
	const refreshModels = async () => {
		if (!canFetchModels()) {
			modelStatus.textContent = "";
			return;
		}
		modelRefreshBtn.disabled = true;
		modelStatus.className = "hint";
		modelStatus.textContent = "Loading models…";
		try {
			fetchedModels = await listModels(currentProbe());
			applyModelOptions();
			modelStatus.textContent = fetchedModels.length ? `${fetchedModels.length} models loaded — start typing to filter` : "Provider returned no models";
		} catch (e) {
			modelStatus.textContent = `Couldn't list models: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			modelRefreshBtn.disabled = false;
		}
	};
	const refreshModelsDebounced = debounce(() => void refreshModels(), 700);
	modelRefreshBtn.addEventListener("click", () => void refreshModels());
	apiKey.addEventListener("input", refreshModelsDebounced);
	baseUrl.addEventListener("input", refreshModelsDebounced);

	// A provider whose endpoint sends no CORS headers cannot be called directly
	// from a page, so picking it ticks the proxy on rather than leaving the user
	// to find the toggle after a failed request. Ticking the real checkbox (and
	// saying why) keeps it visible and still overridable.
	const applyProxyRequirement = () => {
		const info = PROVIDERS[provider.value as ProviderId];
		if (info.needsProxy) useProxy.checked = true;
		proxyHint.textContent = info.needsProxy ? `${info.label} sends no CORS headers, so the proxy carries its requests.` : "Use if direct browser calls are blocked by CORS.";
	};

	const refreshModelList = () => {
		const p = provider.value as ProviderId;
		fetchedModels = []; // provider changed; the previous list no longer applies
		applyModelOptions();
		// The old provider's model id is left in the box and would fail on the new
		// one. Replace it only when it is some provider's preset -- an id the user
		// typed is theirs and stays put.
		const current = model.value.trim();
		const isSomePreset = Object.values(MODEL_PRESETS).some((list) => list.includes(current));
		if (isSomePreset && !PROVIDERS[p].models.includes(current)) model.value = PROVIDERS[p].models[0];
		tempHint.textContent = p === "anthropic" ? "Ignored on Claude 4.6 and newer (thinking replaces it; 4.7+ reject it)." : "";
		baseUrl.placeholder = `(optional) ${PROVIDERS[p].baseUrl}`;
		modelStatus.textContent = "";
	};
	provider.addEventListener("change", () => {
		refreshModelList();
		applyProxyRequirement();
		void refreshModels();
	});

	const testBtn = el("button", { class: "btn", type: "button" }, "Test connection");
	const testResult = el("span", { class: "test-result" });
	testBtn.addEventListener("click", async () => {
		testBtn.disabled = true;
		testResult.className = "test-result busy";
		testResult.textContent = "Testing…";
		try {
			const r = await testConnection(currentProbe());
			testResult.className = `test-result ${r.ok ? "ok" : "err"}`;
			render(testResult, icon(r.ok ? "check" : "close", { size: 14 }), " " + r.message);
		} catch (e) {
			testResult.className = "test-result err";
			render(testResult, icon("close", { size: 14 }), " " + (e instanceof Error ? e.message : String(e)));
		} finally {
			testBtn.disabled = false;
		}
	});

	const field = (label: string, control: HTMLElement, hint?: string) => el("label", { class: "field" }, el("span", { class: "field-label" }, label), control, hint ? el("span", { class: "hint" }, hint) : "");
	// Checkbox + label on one line, hint underneath.
	const checkField = (label: string, control: HTMLElement, hint?: string | HTMLElement) =>
		el("div", { class: "field check-field" }, el("label", { class: "check-row" }, control, el("span", { class: "field-label" }, label)), hint ? (typeof hint === "string" ? el("span", { class: "hint" }, hint) : hint) : "");
	const modelField = el("div", { class: "field" }, el("span", { class: "field-label" }, "Model"), el("div", { class: "model-row" }, model, modelRefreshBtn), modelStatus);

	const body = el(
		"div",
		{ class: "modal-body" },
		el("h3", {}, "Chat model"),
		field("Provider", provider),
		modelField,
		field("API key", apiKey, "Stored only in your browser (localStorage)."),
		field("Base URL", baseUrl, "For OpenAI-compatible gateways (OpenRouter, local, etc.)."),
		field("Tool calling", toolMode, "Text tags = forgiving XML in the reply, for models/endpoints without function calling."),
		el("div", { class: "row2" }, field("Max tokens", maxTokens), field("Temperature", temperature)),
		tempHint,
		el("div", { class: "test-row" }, testBtn, testResult),
		el("h3", {}, "Networking"),
		checkField("Route chat through CORS proxy", useProxy, proxyHint),
		field("CORS proxy URL", proxyUrl, "A template: {{.url}} takes the encoded target (query-style proxies), {{.rawurl}} takes it verbatim (prefix-style). No token = the target is appended."),
		el("h3", {}, "Vision feedback"),
		checkField("Attach a render to every shader change", autoScreenshot, "Off by default: the AI pulls a render only when it wants one (screenshot:true or capture_screenshot). Turn this on to attach a render to every shader change."),
		field("Screenshot max edge (px)", shotDim),
		el("h3", {}, "Image generation (optional)"),
		checkField("Enable generate_texture tool", igEnabled),
		field("Images base URL", igBaseUrl),
		field("Images API key", igKey),
		el("div", { class: "row2" }, field("Image model", igModel), field("Image size", igSize)),
		checkField("Route image gen through proxy", igProxy),
	);

	const overlay = el(
		"div",
		{ class: "modal-overlay" },
		el(
			"div",
			{ class: "modal" },
			el("div", { class: "modal-head" }, el("h2", {}, "Settings"), el("button", { class: "btn icon", on: { click: close } }, icon("close"))),
			body,
			el(
				"div",
				{ class: "modal-foot" },
				el("button", { class: "btn", on: { click: close } }, "Cancel"),
				el("button", { class: "btn primary", on: { click: save } }, "Save"),
			),
		),
	);
	overlay.hidden = true;
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) close();
	});

	function open(): void {
		const s = store.settings;
		provider.value = s.chat.provider;
		toolMode.value = s.chat.toolMode;
		refreshModelList();
		model.value = s.chat.model;
		apiKey.value = s.chat.apiKey;
		baseUrl.value = s.chat.baseUrl;
		maxTokens.value = String(s.chat.maxTokens);
		temperature.value = String(s.chat.temperature);
		useProxy.checked = s.chat.useProxy;
		proxyUrl.value = s.proxyUrl;
		applyProxyRequirement();
		autoScreenshot.checked = s.autoScreenshot;
		shotDim.value = String(s.screenshotMaxDim);
		igEnabled.checked = s.imageGen.enabled;
		igBaseUrl.value = s.imageGen.baseUrl;
		igKey.value = s.imageGen.apiKey;
		igModel.value = s.imageGen.model;
		igSize.value = s.imageGen.size;
		igProxy.checked = s.imageGen.useProxy;
		testResult.textContent = "";
		testResult.className = "test-result";
		testBtn.disabled = false;
		modelStatus.textContent = "";
		overlay.hidden = false;
		void refreshModels(); // auto-populate the combobox when there's enough config
	}
	function close(): void {
		overlay.hidden = true;
	}
	function save(): void {
		store.updateSettings({
			chat: {
				provider: provider.value as ProviderId,
				model: model.value.trim(),
				apiKey: apiKey.value.trim(),
				baseUrl: baseUrl.value.trim(),
				maxTokens: clampNum(maxTokens.value, 256, 128000, 16384),
				temperature: clampNum(temperature.value, 0, 2, 0.7),
				useProxy: useProxy.checked,
				toolMode: toolMode.value as ToolMode,
			},
			proxyUrl: proxyUrl.value.trim() || DEFAULT_SETTINGS.proxyUrl,
			autoScreenshot: autoScreenshot.checked,
			screenshotMaxDim: clampNum(shotDim.value, 128, 1024, 512),
			imageGen: {
				enabled: igEnabled.checked,
				baseUrl: igBaseUrl.value.trim() || "https://api.openai.com/v1",
				apiKey: igKey.value.trim(),
				model: igModel.value.trim() || "gpt-image-1",
				size: igSize.value.trim() || "512x512",
				useProxy: igProxy.checked,
			},
		});
		close();
	}

	overlay.appendChild(modelList);
	return { root: overlay, open };
}

function clampNum(raw: string, lo: number, hi: number, fallback: number): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(lo, Math.min(hi, n));
}
