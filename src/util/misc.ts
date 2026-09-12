// Small standalone helpers used across modules.

export interface Debounced<A extends unknown[]> {
	(...args: A): void;
	/** Run a pending call now (a no-op when nothing is pending). */
	flush(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
	let timer: number | undefined;
	let last: A | undefined;
	const run = (): void => {
		timer = undefined;
		const args = last;
		last = undefined;
		if (args) fn(...args);
	};
	const d = ((...args: A) => {
		last = args;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(run, ms) as unknown as number;
	}) as Debounced<A>;
	d.flush = () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		run();
	};
	return d;
}

export function uid(prefix = ""): string {
	return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function clamp(x: number, lo: number, hi: number): number {
	return x < lo ? lo : x > hi ? hi : x;
}

/** Ensure a URL has a scheme. Users routinely type "gateway.example.com"; add
 * http:// for local hosts (no TLS) and https:// otherwise. Empty stays empty. */
export function withScheme(url: string): string {
	const u = url.trim();
	if (!u) return u;
	if (/^https?:\/\//i.test(u)) return u;
	if (u.startsWith("//")) return `https:${u}`;
	if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(u)) return `http://${u}`;
	return `https://${u}`;
}

/** Route a request through the CORS proxy. The setting is a TEMPLATE naming
 * where the target goes, so any proxy shape works:
 *
 *   {{.url}}     the target, percent-encoded -- what a query parameter needs
 *                (`https://proxy.pazer.ai/?url={{.url}}`)
 *   {{.rawurl}}  the target verbatim -- what a path-prefix proxy needs
 *                (`https://cors.example.com/{{.rawurl}}`)
 *
 * A template with neither token is read as the bare prefix form and gets the
 * target appended, so a proxy URL written before templates existed still works.
 * An empty setting is not a proxy: the target goes out untouched. */
export function proxied(target: string, template: string): string {
	const base = withScheme(template.trim());
	if (!base) return target;
	const filled = base.replace(/\{\{\s*\.(rawurl|url)\s*\}\}/g, (_m, token: string) => (token === "rawurl" ? target : encodeURIComponent(target)));
	if (filled !== base) return filled;
	return `${base.replace(/\/+$/, "")}/${target}`;
}

/** True when a proxy setting names its substitution point. The Settings field
 * uses this to show which rule a given value will follow. */
export function hasProxyToken(template: string): boolean {
	return /\{\{\s*\.(rawurl|url)\s*\}\}/.test(template);
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function downloadFile(name: string, content: string | Blob, mime = "application/json"): void {
	const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy text to the clipboard. Prefers the async Clipboard API (secure
 * contexts), falling back to a hidden textarea + execCommand so it still works
 * on plain-http origins / older browsers. Resolves true on success. */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Permission denied or no secure context -- fall through to the legacy path.
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

/** Open the file dialog. Resolves with the chosen files, or an empty array when
 * the dialog is dismissed (the `cancel` event), so a caller never hangs. */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = accept;
		input.multiple = multiple;
		input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
		input.oncancel = () => resolve([]);
		input.click();
	});
}

export function pickFile(accept: string): Promise<File | null> {
	return pickFiles(accept, false).then((files) => files[0] ?? null);
}
