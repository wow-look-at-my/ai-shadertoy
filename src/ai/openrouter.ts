// OpenRouter PKCE sign-in helpers.

import type { ChatConfig } from "../state/types.ts";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_VERIFIER_KEY = "openrouter-code-verifier";
export const OPENROUTER_DRAFT_KEY = "openrouter-settings-draft";

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(): Uint8Array {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytes;
}

export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

export interface PkcePair {
	verifier: string;
	challenge: string;
}

export async function createPkcePair(random: () => Uint8Array = randomBytes): Promise<PkcePair> {
	const verifier = base64url(random());
	return { verifier, challenge: await pkceChallenge(verifier) };
}

/** The authorize URL. The callback is this page without a query or hash. */
export function openRouterAuthUrl(pageUrl: string, challenge: string): string {
	const callback = new URL(pageUrl);
	if (callback.protocol !== "http:" && callback.protocol !== "https:") throw new Error("OpenRouter sign-in needs an http(s) page.");
	callback.search = "";
	callback.hash = "";
	const url = new URL(OPENROUTER_AUTH_URL);
	url.searchParams.set("callback_url", callback.toString());
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("key_label", "AI Shadertoy");
	return url.toString();
}

export interface CodeExchange {
	url: string;
	init: RequestInit;
}

export function openRouterExchangeRequest(code: string, verifier: string): CodeExchange {
	return {
		url: OPENROUTER_KEYS_URL,
		init: {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
		},
	};
}

export async function exchangeOpenRouterCode(code: string, verifier: string, doFetch: typeof fetch = fetch): Promise<string> {
	const request = openRouterExchangeRequest(code, verifier);
	const res = await doFetch(request.url, request.init);
	if (!res.ok) throw new Error(`OpenRouter sign-in failed (HTTP ${res.status}).`);
	const json = (await res.json()) as { key?: unknown };
	if (typeof json.key !== "string" || !json.key) throw new Error("OpenRouter sign-in returned no API key.");
	return json.key;
}

/** Take the callback code out of the page URL, leaving the rest intact. */
export function takeCallbackCode(pageUrl: string): { code: string; url: string } | null {
	const url = new URL(pageUrl);
	const code = url.searchParams.get("code");
	if (!code) return null;
	url.searchParams.delete("code");
	return { code, url: url.toString() };
}

export interface SignInCallback {
	key?: string;
	url: string;
	error?: string;
}

/** Serialize the live form into the session draft for the redirect. */
export function draftSettings(chat: ChatConfig): string {
	return JSON.stringify(chat);
}

/** Read a settings draft, or null when there is none. */
export function readSettingsDraft(raw: string | null): Partial<ChatConfig> | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<ChatConfig>) : null;
	} catch {
		return null;
	}
}

/** Lay a draft over the stored chat, merging per-provider keys. */
export function mergeSettingsDraft(chat: ChatConfig, draft: Partial<ChatConfig> | null): ChatConfig {
	if (!draft) return chat;
	return { ...chat, ...draft, apiKeys: { ...chat.apiKeys, ...(draft.apiKeys ?? {}) } };
}

/** Exchange a callback code when the page URL carries one. A failure keeps the
 * stored key untouched and reports the reason instead. */
export async function completeOpenRouterSignIn(pageUrl: string, verifier: string | null, doFetch: typeof fetch = fetch): Promise<SignInCallback | null> {
	const callback = takeCallbackCode(pageUrl);
	if (!callback) return null;
	if (!verifier) return { url: callback.url, error: "OpenRouter sign-in expired. Start again." };
	try {
		const key = await exchangeOpenRouterCode(callback.code, verifier, doFetch);
		return { key, url: callback.url };
	} catch (e) {
		return { url: callback.url, error: e instanceof Error ? e.message : String(e) };
	}
}
