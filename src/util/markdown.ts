// A deliberately tiny Markdown renderer. All raw text is HTML-escaped first,
// so model output can never inject markup.

import { escapeHtml } from "./misc.ts";
import { el } from "./dom.ts";

// Placeholders keep already-rendered spans (code, links) out of later passes.
const HOLD = "\u0000";

function inline(text: string): string {
	const held: string[] = [];
	const hold = (html: string): string => {
		held.push(html);
		return `${HOLD}${held.length - 1}${HOLD}`;
	};
	let s = escapeHtml(text);
	// Inline code first so its contents are not further transformed.
	s = s.replace(/`([^`]+)`/g, (_, c: string) => hold(`<code>${c}</code>`));
	// Explicit links before autolinks, so the autolink pass cannot swallow the `)` that closes a markdown link.
	s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
	s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => pre + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
	s = s.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "<strong>$1</strong>");
	// Emphasis needs a non-space right inside each `*`, so `a * b * c` stays prose.
	s = s.replace(/(^|[^*])\*(\S(?:[^*\n]*\S)?)\*(?!\*)/g, "$1<em>$2</em>");
	return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]);
}

const FENCE = /^```/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+/;
const NUMBERED = /^\s*\d+\.\s+/;

export function markdownToHtml(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;

	const list = (re: RegExp, tag: "ul" | "ol"): void => {
		const items: string[] = [];
		while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
		out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
	};

	while (i < lines.length) {
		const line = lines[i];

		// Fenced code block: the opener is any line starting with ``` (whatever
		// follows is the info string); the body runs to the next such line or EOF.
		if (FENCE.test(line)) {
			const lang = line.slice(3).trim().split(/\s+/)[0].toLowerCase();
			const body: string[] = [];
			i++;
			while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
			i++; // closing fence (or past EOF)
			out.push(`<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(body.join("\n"))}</code></pre>`);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length + 2;
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			i++;
			continue;
		}

		if (BULLET.test(line)) {
			list(BULLET, "ul");
			continue;
		}
		if (NUMBERED.test(line)) {
			list(NUMBERED, "ol");
			continue;
		}

		if (line.trim() === "") {
			i++;
			continue;
		}

		// Paragraph: consume until a blank line or a block start.
		const para: string[] = [line];
		i++;
		while (i < lines.length && lines[i].trim() !== "" && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
			para.push(lines[i++]);
		}
		out.push(`<p>${inline(para.join(" "))}</p>`);
	}

	return out.join("");
}

export function renderMarkdown(text: string): HTMLElement {
	return el("div", { class: "md", html: markdownToHtml(text) });
}
