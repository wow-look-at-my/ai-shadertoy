// Unit tests for the pass-graph auto-layout (src/util/graphlayout.ts). DOM-free,
// so plain Node can exercise it:
//   node --experimental-strip-types test/graphlayout.test.ts

import { applyLayout, layoutPasses, nodeHeight, NODE_W } from "../src/util/graphlayout.ts";
import { makePass } from "../src/state/types.ts";
import type { Channel, Pass } from "../src/state/types.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}

const passEdge = (id: string): Channel => ({ kind: "pass", passId: id, filter: "linear", wrap: "clamp" });
const builtinEdge = (): Channel => ({ kind: "builtin", builtin: "checker", filter: "linear", wrap: "repeat" });
const node = (name: string, channels: Channel[]): Pass => makePass(name, "", channels);

// Two nodes overlap if their on-screen rectangles intersect (standard AABB test).
function overlaps(a: Pass, b: Pass, pa: { x: number; y: number }, pb: { x: number; y: number }): boolean {
	const ax2 = pa.x + NODE_W,
		ay2 = pa.y + nodeHeight(a);
	const bx2 = pb.x + NODE_W,
		by2 = pb.y + nodeHeight(b);
	return pa.x < bx2 && ax2 > pb.x && pa.y < by2 && ay2 > pb.y;
}

// ---- the screenshot case: map -> BlurX -> HeavyBlur -> Image ----------------
{
	const blurX = node("BlurX", [builtinEdge()]); // root: samples a built-in, not a pass
	const heavy = node("HeavyBlur", [passEdge(blurX.id)]); // depends on BlurX
	const image = node("Image", [builtinEdge(), passEdge(heavy.id)]); // depends on HeavyBlur
	// Deliberately scrambled array order -- layout must order by dependency, not index.
	const passes = [heavy, image, blurX];

	const pos = layoutPasses(passes, image.id);
	check(pos.size === 3, "every pass gets a position");
	const bx = pos.get(blurX.id)!,
		hb = pos.get(heavy.id)!,
		im = pos.get(image.id)!;

	check(bx.x < hb.x, "BlurX is left of HeavyBlur (it feeds it)");
	check(hb.x < im.x, "HeavyBlur is left of Image (it feeds it)");
	check(im.x === Math.max(bx.x, hb.x, im.x), "the output pass (Image) is rightmost");
	check(new Set([bx.x, hb.x, im.x]).size === 3, "the chain lays out in three distinct columns");

	// Every pass->pass edge points strictly rightward (no backward/crossing tangle).
	for (const tgt of passes)
		for (const ch of tgt.channels)
			if (ch.kind === "pass" && ch.passId) check(pos.get(ch.passId)!.x < pos.get(tgt.id)!.x, `edge ${ch.passId} -> ${tgt.id} points rightward`);
}

// ---- diamond: shared root, two parallel passes, a join ----------------------
{
	const a = node("A", [builtinEdge()]);
	const b = node("B", [passEdge(a.id)]);
	const c = node("C", [passEdge(a.id)]);
	const d = node("D", [passEdge(b.id), passEdge(c.id)]);
	const passes = [d, c, b, a];

	const pos = layoutPasses(passes, d.id);
	const pa = pos.get(a.id)!,
		pb = pos.get(b.id)!,
		pc = pos.get(c.id)!,
		pd = pos.get(d.id)!;

	check(pa.x < pb.x && pb.x === pc.x && pc.x < pd.x, "diamond: A | B,C | D columns left-to-right");
	check(pd.x === Math.max(pa.x, pb.x, pc.x, pd.x), "join pass D is rightmost");
	check(pb.y !== pc.y, "the two parallel passes get distinct rows");
	check(!overlaps(b, c, pb, pc), "parallel passes in the same column do not overlap");
}

// ---- self-feedback is drawn but ignored by layout (no infinite loop) --------
{
	const fb = node("Feedback", []);
	fb.channels = [passEdge(fb.id)]; // a channel pointing at its own pass
	const pos = layoutPasses([fb], fb.id);
	check(pos.size === 1, "a self-feedback pass still gets exactly one position");
	check(Number.isFinite(pos.get(fb.id)!.x) && Number.isFinite(pos.get(fb.id)!.y), "self-feedback layout is finite (no cycle blowup)");
}

// ---- applyLayout writes positions back onto the passes ----------------------
{
	const blurX = node("BlurX", [builtinEdge()]);
	const image = node("Image", [passEdge(blurX.id)]);
	const layer = { passes: [image, blurX], outputPassId: image.id };
	applyLayout(layer);
	check(blurX.x < image.x, "applyLayout mutates pass.x by dependency order");
	check(blurX.y === image.y, "a straight two-node chain lays out on one row");
}

// ---- empty graph is a no-op ------------------------------------------------
{
	check(layoutPasses([], "nope").size === 0, "empty pass list yields no positions");
}

console.log(`ok - ${passed} assertions passed`);
