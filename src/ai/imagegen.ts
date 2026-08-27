// Optional text-to-image generation via an OpenAI-compatible
// /images/generations endpoint. Used by the generate_texture tool to create
// textures the shader can sample. Independent of the chat provider so it can
// point at DALL-E, a local SD server, or any compatible API.

import type { Settings } from "../state/types.ts";
import { ProviderError } from "./providers.ts";
import { proxied, withScheme } from "../util/misc.ts";

export interface GeneratedImage {
	dataUrl: string;
	mediaType: string;
	width: number;
	height: number;
}

function parseSize(size: string): { w: number; h: number } {
	const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(size.trim());
	if (m) return { w: Number(m[1]), h: Number(m[2]) };
	return { w: 512, h: 512 };
}

export async function generateImage(settings: Settings, prompt: string): Promise<GeneratedImage> {
	const cfg = settings.imageGen;
	const key = cfg.apiKey || settings.chat.apiKey;
	if (!key) throw new ProviderError("No API key configured for image generation.");
	const base = withScheme(cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
	let url = `${base}/images/generations`;
	if (cfg.useProxy) url = proxied(url, settings.proxyUrl);
	const { w, h } = parseSize(cfg.size);

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify({ model: cfg.model, prompt, size: cfg.size, n: 1, response_format: "b64_json" }),
		});
	} catch (e) {
		throw new ProviderError(`Image generation network error: ${e instanceof Error ? e.message : String(e)}`, undefined, "Image endpoint may not allow browser (CORS) requests; try the proxy.");
	}
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new ProviderError(`Image generation HTTP ${res.status}: ${text}`, res.status);
	}
	const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
	const item = json.data?.[0];
	if (item?.b64_json) {
		return { dataUrl: `data:image/png;base64,${item.b64_json}`, mediaType: "image/png", width: w, height: h };
	}
	if (item?.url) {
		// Fall back to fetching a returned URL (may itself be CORS-limited).
		const imgRes = await fetch(item.url);
		const blob = await imgRes.blob();
		const dataUrl = await blobToDataUrl(blob);
		return { dataUrl, mediaType: blob.type || "image/png", width: w, height: h };
	}
	throw new ProviderError("Image generation returned no image data.");
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => resolve(r.result as string);
		r.onerror = () => reject(new Error("failed to read generated image"));
		r.readAsDataURL(blob);
	});
}
