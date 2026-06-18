// Small standalone helpers used across modules.

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
	let timer: number | undefined;
	return (...args: A) => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms) as unknown as number;
	};
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

/** Pull the first fenced code block (optionally filtered by language) out of markdown text. */
export function extractCodeBlock(text: string, langPrefixes: string[] = []): string | null {
	const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	let firstAny: string | null = null;
	while ((m = re.exec(text)) !== null) {
		const lang = (m[1] || "").toLowerCase();
		const body = m[2];
		if (firstAny === null) firstAny = body;
		if (langPrefixes.length === 0) return body;
		if (langPrefixes.some((p) => lang.startsWith(p))) return body;
	}
	return langPrefixes.length === 0 ? firstAny : null;
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

export function pickFile(accept: string): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = accept;
		input.onchange = () => resolve(input.files?.[0] ?? null);
		input.click();
	});
}

export function readFileText(file: File): Promise<string> {
	return file.text();
}
