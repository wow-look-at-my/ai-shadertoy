// rename_shader -- rename the current shader (the project name shown in the top
// bar). Gated behind user permission: the agent surfaces an approve/deny prompt
// and only renames if the user approves (see requiresPermission in types.ts).

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";

const MAX_NAME_LEN = 100;

function cleanName(input: Record<string, unknown>): string {
	return String(input["name"] ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_LEN);
}

registerTool({
	name: TOOL_NAMES.renameShader,
	requiresPermission: true,
	permissionPrompt: (input) => {
		const name = cleanName(input);
		return name ? `Rename the current shader to "${name}"?` : "Rename the current shader?";
	},
	def: {
		name: TOOL_NAMES.renameShader,
		description:
			"Rename the current shader (the project name shown in the top bar). This requires the user's approval before it takes effect -- the user is shown an approve/deny prompt, so only call it when a rename is clearly wanted. Keep the name short and descriptive.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "The new shader name (short, descriptive)." },
			},
			required: ["name"],
		},
	},
	execute: (ctx, input) => {
		const name = cleanName(input);
		if (!name) return { content: [text("rename_shader requires a non-empty name.")], isError: true };
		ctx.renameProject(name);
		return { content: [text(`Renamed the shader to "${name}".`)] };
	},
});
