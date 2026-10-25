// Unit test for the set_uniforms tool's PATCH (merge) semantics.

import "../src/ai/tools/set_uniforms.ts"; // self-registers the tool
import { getTool } from "../src/ai/tools/registry.ts";
import type { ToolContext } from "../src/ai/tools/types.ts";
import type { Uniform } from "../src/state/types.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function near(a: number, b: number, msg: string): void {
	check(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);
}
function val(us: Uniform[], name: string): number[] {
	return us.find((u) => u.name === name)?.value ?? [];
}

const tool = getTool("set_uniforms");
if (!tool) throw new Error("FAIL: set_uniforms did not register");

/** A fake ToolContext that captures the list handed to setUniforms. */
function fakeCtx(uniforms: Uniform[]): { ctx: ToolContext; captured: () => Uniform[] } {
	let last: Uniform[] = [];
	const ctx = {
		project: { uniforms },
		setUniforms: (u: Uniform[]) => {
			last = u;
			return { ok: true, log: "" };
		},
	} as unknown as ToolContext;
	return { ctx, captured: () => last };
}

{
	const current: Uniform[] = [
		{ name: "u_a", type: "float", value: [0.5], min: 0, max: 1, step: 0.01 },
		{ name: "u_b", type: "float", value: [0.3], min: 0, max: 1, step: 0.01 },
		{ name: "u_c", type: "vec3", value: [0.1, 0.2, 0.3], min: 0, max: 1, step: 0.01 },
	];
	const { ctx, captured } = fakeCtx(current);
	const res = tool!.execute(ctx, { uniforms: [{ name: "u_a", type: "float", value: [0.7] }] });
	check(!("isError" in res && res.isError), "patching one uniform succeeds");
	const merged = captured();
	near(val(merged, "u_a")[0], 0.7, "the named uniform is updated");
	near(val(merged, "u_b")[0], 0.3, "an omitted uniform keeps its value (not reset to 0)");
	near(val(merged, "u_c")[2], 0.3, "an omitted vec3 keeps all its components");
}

// ---- a new uniform (declared in source, no metadata yet) is appended --------
{
	const current: Uniform[] = [{ name: "u_a", type: "float", value: [0.5], min: 0, max: 1, step: 0.01 }];
	const { ctx, captured } = fakeCtx(current);
	tool!.execute(ctx, { uniforms: [{ name: "u_new", type: "float", value: [0.9], min: 0, max: 2 }] });
	const merged = captured();
	near(val(merged, "u_a")[0], 0.5, "existing uniform preserved when a new one is added");
	near(val(merged, "u_new")[0], 0.9, "the newly named uniform is included");
}

// ---- value length is normalized to the type (vec3 needs components) ---
{
	const { ctx, captured } = fakeCtx([]);
	tool!.execute(ctx, { uniforms: [{ name: "u_t", type: "vec3", value: [0.5] }] });
	const merged = captured();
	check(val(merged, "u_t").length === 3, "a vec3 value is padded to three components");
}

// ---- a value-only patch keeps the control's widened range and label ----------
{
	const current: Uniform[] = [{ name: "u_speed", type: "float", value: [3], min: 0, max: 10, step: 0.1, label: "Speed" }];
	const { ctx, captured } = fakeCtx(current);
	tool!.execute(ctx, { uniforms: [{ name: "u_speed", type: "float", value: [7] }] });
	const u = captured().find((x) => x.name === "u_speed")!;
	near(u.value[0], 7, "the value is patched");
	near(u.max, 10, "an omitted max keeps the widened range (not reset to 1)");
	near(u.step, 0.1, "an omitted step is kept");
	check(u.label === "Speed", "an omitted label is kept");
}

// ---- a bad type is reported, not stored -------------------------------------
{
	const { ctx, captured } = fakeCtx([]);
	const res = tool!.execute(ctx, { uniforms: [{ name: "u_i", type: "int", value: [1] }] });
	check(captured().length === 0, "an unknown uniform type is not stored");
	check(/type must be one of/.test(JSON.stringify(res)), "the reply names the type error");
}

console.log(`set_uniforms.test.ts: ${passed} checks passed`);
