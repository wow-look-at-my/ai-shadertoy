// set_uniforms -- set metadata/default values for custom uniforms declared in
// shader source. The source declaration owns the actual input surface.

import { registerTool } from "./registry.ts";
import { TOOL_NAMES } from "./names.ts";
import { text } from "./types.ts";
import { isValidUniformName, rangeForValues, uniformLength } from "../../gl/wrapper.ts";
import type { Uniform, UniformType } from "../../state/types.ts";

const UNIFORM_TYPES: ReadonlySet<string> = new Set(["float", "vec2", "vec3", "vec4", "color"]);
function isUniformType(t: string): t is UniformType {
	return UNIFORM_TYPES.has(t);
}

registerTool({
	name: TOOL_NAMES.setUniforms,
	def: {
		name: TOOL_NAMES.setUniforms,
		description:
			"Adjust UI metadata (range/step/label) for custom uniforms, or programmatically change an EXISTING uniform's value mid-session. This is NOT how you give a new uniform its starting value -- bake that into the declaration in the SAME edit (`uniform float u_speed = 1.5;`), which is one step instead of two and avoids the control sitting at 0 in between. The uniform must already be declared in shader source (names not declared there are ignored by the renderer sync). This is a PATCH: only the uniforms you list are updated -- any uniform you DON'T list keeps its current value/range (omitting one never resets it). value length must match the type (float=1, vec2=2, vec3/color=3, vec4=4).",
		parameters: {
			type: "object",
			properties: {
				uniforms: {
					type: "array",
					description: "Metadata/default values for shader-declared custom uniforms.",
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
		const current = new Map(ctx.project.uniforms.map((u) => [u.name, u]));
		for (const item of raw as Array<Record<string, unknown>>) {
			const name = String(item["name"] ?? "");
			const type = String(item["type"] ?? "float");
			if (!isValidUniformName(name)) {
				errors.push(`invalid/reserved uniform name: ${name}`);
				continue;
			}
			if (!isUniformType(type)) {
				errors.push(`${name}: type must be one of float, vec2, vec3, vec4, color`);
				continue;
			}
			const need = uniformLength(type);
			let value = Array.isArray(item["value"]) ? (item["value"] as unknown[]).map(Number) : [];
			if (value.length < need) value = value.concat(new Array(need - value.length).fill(0));
			value = value.slice(0, need);
			// PATCH within the record too: a field the call omits keeps the control's
			// current range/step/label (a widened slider must survive a value-only patch).
			const prev = current.get(name);
			const keepRange = prev !== undefined && prev.type === type;
			const range = keepRange ? { min: prev.min, max: prev.max, step: prev.step } : rangeForValues(value);
			uniforms.push({
				name,
				type,
				value,
				min: typeof item["min"] === "number" ? (item["min"] as number) : range.min,
				max: typeof item["max"] === "number" ? (item["max"] as number) : range.max,
				step: typeof item["step"] === "number" ? (item["step"] as number) : range.step,
				label: item["label"] ? String(item["label"]) : prev?.label,
			});
		}
		// PATCH semantics: merge the named uniforms over the current list so omitting
		// a uniform never wipes it back to 0. Update-in-place by name; append any
		// genuinely new ones (the renderer sync then drops any not declared in source).
		const incoming = new Map(uniforms.map((u) => [u.name, u]));
		const merged = ctx.project.uniforms.map((u) => incoming.get(u.name) ?? u);
		for (const u of uniforms) if (!merged.some((m) => m.name === u.name)) merged.push(u);

		const result = ctx.setUniforms(merged);
		const decl = uniforms.map((u) => `${u.name} = [${u.value.join(", ")}]`).join("\n");
		const head = result.ok ? "Uniforms updated (others left unchanged)." : `Uniforms updated, but the shader no longer compiles:\n${result.log}`;
		return { content: [text(`${head}\nSet:\n${decl}${errors.length ? `\nSkipped: ${errors.join("; ")}` : ""}`)], isError: !result.ok };
	},
});
