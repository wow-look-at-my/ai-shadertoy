// edit_shader -- the primary way to change an existing shader: replace an exact
// snippet instead of retyping the whole thing. Forgiving about stray whitespace.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		count++;
		i = haystack.indexOf(needle, i + needle.length);
	}
	return count;
}

registerTool({
	name: TOOL_NAMES.editShader,
	def: {
		name: TOOL_NAMES.editShader,
		description:
			"Make a targeted edit to a pass's shader by replacing an exact snippet -- the primary way to change an existing shader (don't retype the whole thing). `old` must appear in that pass's source (whitespace included); it is replaced by `new`. Targets the output pass by default; set `pass` to a pass name (see list_passes) to edit a different pass. Make several edits in one turn by calling this multiple times. If `old` is not unique, include more surrounding lines or set replace_all. After your edits compile you get a screenshot and the compile log.",
		parameters: {
			type: "object",
			properties: {
				old: { type: "string", description: "Exact snippet from the pass's current source to replace." },
				new: { type: "string", description: "Replacement text." },
				pass: { type: "string", description: "Pass name to edit (default: the output pass)." },
				replace_all: { type: "boolean", description: "Replace every occurrence (default false = the single match)." },
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result so you can verify it (default false; you are always shown the render when you finish)." },
			},
			required: ["old", "new"],
		},
	},
	execute: (ctx, input) => {
		const oldStr = String(input["old"] ?? "");
		const newStr = String(input["new"] ?? "");
		const replaceAll = input["replace_all"] === true;
		if (!oldStr) return { content: [text("edit_shader requires a non-empty 'old' snippet.")], isError: true };

		const passArg = input["pass"] ? String(input["pass"]) : undefined;
		const pass = ctx.resolvePass(passArg);
		if (!pass) return { content: [text(`No pass named "${passArg}". Use list_passes to see the passes.`)], isError: true };

		const src = pass.source;
		let target = oldStr;
		let count = countOccurrences(src, target);
		if (count === 0) {
			// Forgiving: the model may have added stray leading/trailing whitespace.
			const trimmed = oldStr.trim();
			if (trimmed && countOccurrences(src, trimmed) === 1) {
				target = trimmed;
				count = 1;
			}
		}
		if (count === 0) {
			return { content: [text(`Couldn't find that snippet in pass "${pass.name}". Check it against the current source (use get_shader). Current source:\n\n${src}`)], isError: true };
		}
		if (count > 1 && !replaceAll) {
			return { content: [text(`That snippet appears ${count} times in pass "${pass.name}". Add surrounding lines to make it unique, or set replace_all: true.`)], isError: true };
		}

		const updated = replaceAll ? src.split(target).join(newStr) : src.replace(target, newStr);
		ctx.setPassSource(pass.id, updated, true);
		return ctx.shaderResult(`Edited pass "${pass.name}" (${replaceAll ? `${count} replacements` : "1 replacement"}).`, input["screenshot"] === true);
	},
});
