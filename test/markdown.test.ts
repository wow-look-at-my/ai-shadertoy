// Unit tests for the chat markdown renderer's pure HTML pass. DOM-free:
//   node --experimental-strip-types test/markdown.test.ts

import { markdownToHtml } from "../src/util/markdown.ts";

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${String(a)}, want ${String(b)})`);
	passed++;
}
function has(html: string, needle: string, msg: string): void {
	if (!html.includes(needle)) throw new Error(`FAIL: ${msg} (missing ${needle} in ${html})`);
	passed++;
}

// A fence opener with anything after the backticks used to match neither the
// fence rule nor the paragraph rule, and the loop never advanced.
for (const opener of ["````", "``` glsl", "```c#", "```glsl // shader"]) {
	const html = markdownToHtml(`${opener}\nfloat x;\n\`\`\``);
	has(html, "<pre data-lang=", `"${opener}" opens a code block`);
	has(html, "float x;", `"${opener}" keeps the body`);
}
eq(markdownToHtml("```glsl\nvec2 uv;\n```"), '<pre data-lang="glsl"><code>vec2 uv;</code></pre>', "a plain fence renders lang + escaped body");
has(markdownToHtml("```\na < b && c\n```"), "a &lt; b &amp;&amp; c", "code is HTML-escaped");
has(markdownToHtml("```\nunterminated"), "unterminated", "an unclosed fence runs to EOF");

// Links: the explicit form keeps its label, and a bare URL is linked without
// swallowing a closing parenthesis.
eq(markdownToHtml("see [docs](https://example.com/a) now"), '<p>see <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a> now</p>', "markdown link");
eq(markdownToHtml("(https://x.io/p)"), '<p>(<a href="https://x.io/p" target="_blank" rel="noopener noreferrer">https://x.io/p</a>)</p>', "bare URL in parentheses");

// Inline code is verbatim and never re-processed; numbers in prose survive.
eq(markdownToHtml("use `a * b` and `**x**` at 3 and 4"), "<p>use <code>a * b</code> and <code>**x**</code> at 3 and 4</p>", "inline code + digits");

// Emphasis needs a word right inside the marker.
eq(markdownToHtml("a * b * c"), "<p>a * b * c</p>", "spaced asterisks are not emphasis");
eq(markdownToHtml("*hi* and **yo**"), "<p><em>hi</em> and <strong>yo</strong></p>", "emphasis and strong");

// Blocks.
eq(markdownToHtml("# T\n- a\n- b\n\n1. x\n2. y\npara"), "<h3>T</h3><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol><p>para</p>", "heading, lists, paragraph");
eq(markdownToHtml("<img onerror=alert(1)>"), "<p>&lt;img onerror=alert(1)&gt;</p>", "raw HTML is escaped");

console.log(`markdown.test.ts: ${passed} checks passed`);
