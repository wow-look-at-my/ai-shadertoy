// Text-tools mode parsing. Models without native tool calling emit XML tags in
// their reply (see textToolInstructions in system-prompt.ts); we parse them
// here into the same ToolCall shape the native path produces. Forgiving by
// design: tolerant of attributes, stray whitespace, and code fences.

import type { ToolCall } from "./types.ts";
import { TOOL_NAMES } from "./tools/names.ts";
import { uid } from "../util/misc.ts";

function stripFence(s: string): string {
	const m = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```$/.exec(s.trim());
	return m ? m[1] : s;
}

function innerTag(s: string, tag: string): string {
	const m = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}>`, "i").exec(s);
	if (!m) return "";
	// drop a single leading/trailing newline the model may add for readability
	return m[1].replace(/^\n/, "").replace(/\n$/, "");
}

function tryJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return { _raw: s };
	}
}

function parseInner(name: string, inner: string): unknown {
	const trimmed = inner.trim();
	switch (name) {
		case TOOL_NAMES.writeShader:
			return { source: stripFence(trimmed) };
		case TOOL_NAMES.editShader:
			return { old: innerTag(inner, "old"), new: innerTag(inner, "new"), replace_all: /<replace_all>\s*true/i.test(inner) };
		case TOOL_NAMES.setUniforms:
			return { uniforms: tryJson(trimmed) };
		case TOOL_NAMES.getShader:
		case TOOL_NAMES.listAssets:
		case TOOL_NAMES.screenshot:
			return {};
		default:
			return tryJson(trimmed);
	}
}

function tagRegex(name: string): RegExp {
	return new RegExp(`<${name}\\s*/>|<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
}

/** Parse a model reply for tool-call XML tags, restricted to `allowed` names. */
export function parseTextToolCalls(text: string, allowed: Set<string>): ToolCall[] {
	const found: Array<{ index: number; call: ToolCall }> = [];
	for (const name of allowed) {
		const re = tagRegex(name);
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			found.push({ index: m.index, call: { id: uid("xml_"), name, input: parseInner(name, m[1] ?? "") } });
		}
	}
	return found.sort((a, b) => a.index - b.index).map((f) => f.call);
}

/** Remove tool-call tags from assistant text so chat shows only the prose. */
export function stripTextToolTags(text: string): string {
	let out = text;
	for (const name of Object.values(TOOL_NAMES)) out = out.replace(tagRegex(name), "");
	return out.replace(/\n{3,}/g, "\n\n").trim();
}
