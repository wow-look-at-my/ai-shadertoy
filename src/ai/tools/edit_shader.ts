// edit_shader -- the primary way to change an existing shader: replace an
// exact snippet instead of retyping the whole thing.

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
			"Make a targeted edit to a pass's shader by replacing an exact snippet -- the primary way to change an existing shader (don't retype the whole thing). `old` must appear in that pass's source (whitespace included); it is replaced by `new`. Targets the top layer's output pass by default; set `layer` (name/id/stack index) and/or `pass` (a pass name; see read what:passes) to edit a specific pass. Make several edits in one turn by calling this multiple times. If `old` is not unique, include more surrounding lines or set replace_all. After your edits compile you get the compile log (set screenshot:true to get the rendered frame too).",
		parameters: {
			type: "object",
			properties: {
				old: { type: "string", description: "Exact snippet from the pass's current source to replace." },
				new: { type: "string", description: "Replacement text." },
				layer: { type: "string", description: "Layer ref (name/id/stack index; default: the top layer)." },
				pass: { type: "string", description: "Pass name to edit (default: the layer's output pass)." },
				replace_all: { type: "boolean", description: "Replace every occurrence (default false = the single match)." },
				screenshot: { type: "boolean", description: "Attach the rendered frame to the result so you can see it (default false). Set true when you want to check this change visually." },
			},
			required: ["old", "new"],
		},
	},
	execute: (ctx, input) => {
		const oldStr = String(input["old"] ?? "");
		const newStr = String(input["new"] ?? "");
		const replaceAll = input["replace_all"] === true;
		if (!oldStr) return { content: [text("edit_shader requires a non-empty 'old' snippet.")], isError: true };

		const layer = ctx.resolveLayer(input["layer"] !== undefined ? String(input["layer"]) : undefined);
		if (!layer) return { content: [text(`No layer "${String(input["layer"])}". read what:layers to list them.`)], isError: true };
		const passArg = input["pass"] ? String(input["pass"]) : undefined;
		const pass = ctx.resolvePass(layer, passArg);
		if (!pass) return { content: [text(`No pass named "${passArg}" in layer "${layer.name}". read what:passes to see the passes.`)], isError: true };

		const src = pass.source;
		let target = oldStr;
		let count = countOccurrences(src, target);
		if (count === 0) {
			// Forgiving: the model may have added stray leading/trailing whitespace.
			const trimmed = oldStr.trim();
			if (trimmed && trimmed !== oldStr) {
				const n = countOccurrences(src, trimmed);
				if (n === 1 || (n > 1 && replaceAll)) {
					target = trimmed;
					count = n;
				} else if (n > 1) {
					return { content: [text(`That snippet (ignoring surrounding whitespace) appears ${n} times in pass "${pass.name}". Add surrounding lines to make it unique, or set replace_all: true.`)], isError: true };
				}
			}
		}
		if (count === 0) {
			return { content: [text(`Couldn't find that snippet in pass "${pass.name}". Check it against the current source (read what:pass). Current source:\n\n${src}`)], isError: true };
		}
		if (count > 1 && !replaceAll) {
			return { content: [text(`That snippet appears ${count} times in pass "${pass.name}". Add surrounding lines to make it unique, or set replace_all: true.`)], isError: true };
		}

		// A function replacer keeps `$&`, `$1` etc. in the model's GLSL literal.
		const updated = replaceAll ? src.split(target).join(newStr) : src.replace(target, () => newStr);
		ctx.setPassSource(pass.id, updated, true);
		return ctx.shaderResult(`Edited pass "${pass.name}" (${replaceAll ? `${count} replacements` : "1 replacement"}).`, input["screenshot"] === true);
	},
});
