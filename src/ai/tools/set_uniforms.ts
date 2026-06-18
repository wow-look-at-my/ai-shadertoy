// set_uniforms -- declare the custom uniforms the shader uses; they become live
// UI sliders. Replaces the whole set.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { isValidUniformName } from "../../gl/wrapper.ts";
import type { Uniform } from "../../state/types.ts";

registerTool({
	name: TOOL_NAMES.setUniforms,
	def: {
		name: TOOL_NAMES.setUniforms,
		description:
			"Declare the custom uniforms the shader uses, exposed to the user as live UI controls. This REPLACES the full set. Each becomes a `uniform <type> <name>;` available in mainImage. Use a u_ prefix to avoid colliding with built-ins. value length must match the type (float=1, vec2=2, vec3/color=3, vec4=4).",
		parameters: {
			type: "object",
			properties: {
				uniforms: {
					type: "array",
					description: "Complete list of custom uniforms.",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							type: { type: "string", enum: ["float", "vec2", "vec3", "vec4", "color"] },
							value: { type: "array", items: { type: "number" } },
							min: { type: "number" },
							max: { type: "number" },
							step: { type: "number" },
							label: { type: "string" },
						},
						required: ["name", "type", "value"],
					},
				},
			},
			required: ["uniforms"],
		},
	},
	execute: (ctx, input) => {
		const raw = input["uniforms"];
		if (!Array.isArray(raw)) return { content: [text("uniforms must be an array.")], isError: true };
		const uniforms: Uniform[] = [];
		const errors: string[] = [];
		for (const item of raw as Array<Record<string, unknown>>) {
			const name = String(item["name"] ?? "");
			const type = String(item["type"] ?? "float") as Uniform["type"];
			if (!isValidUniformName(name)) {
				errors.push(`invalid/reserved uniform name: ${name}`);
				continue;
			}
			const need = type === "float" ? 1 : type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
			let value = Array.isArray(item["value"]) ? (item["value"] as unknown[]).map(Number) : [];
			if (value.length < need) value = value.concat(new Array(need - value.length).fill(0));
			value = value.slice(0, need);
			uniforms.push({
				name,
				type,
				value,
				min: typeof item["min"] === "number" ? (item["min"] as number) : 0,
				max: typeof item["max"] === "number" ? (item["max"] as number) : 1,
				step: typeof item["step"] === "number" ? (item["step"] as number) : 0.01,
				label: item["label"] ? String(item["label"]) : undefined,
			});
		}
		const result = ctx.setUniforms(uniforms);
		const decl = uniforms.map((u) => `uniform ${u.type === "color" ? "vec3" : u.type} ${u.name};`).join("\n");
		const head = result.ok ? "Uniforms set." : `Uniforms set, but the shader no longer compiles:\n${result.log}`;
		return { content: [text(`${head}\nDeclared:\n${decl}${errors.length ? `\nSkipped: ${errors.join("; ")}` : ""}`)], isError: !result.ok };
	},
});
