// Unit tests for the passes render-graph auto-layout (ui/graphlayout.ts). The
// graph is a DAG; positions are derived from the pass->pass edges, so a
// dependency always lands in an earlier (smaller-x) column than the pass that
// samples it. DOM-free, so plain Node can exercise it:
//   node --experimental-strip-types test/graphlayout.test.ts

import { layoutGraph, type GraphNode, type LayoutOpts } from "../src/ui/graphlayout.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function eq(a: unknown, b: unknown, msg: string): void {
	check(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);
}

const OPTS: LayoutOpts = { nodeWidth: 100, hGap: 40, vGap: 20, margin: 10 };
const PITCH = OPTS.nodeWidth + OPTS.hGap; // 140
const node = (id: string, deps: string[] = [], height = 50): GraphNode => ({ id, deps, height });

/** Assert no two same-column nodes overlap vertically. */
function noOverlap(nodes: GraphNode[], pos: Map<string, { x: number; y: number }>): void {
	const byX = new Map<number, GraphNode[]>();
	for (const n of nodes) {
		const x = pos.get(n.id)!.x;
		const col = byX.get(x) ?? [];
		col.push(n);
		byX.set(x, col);
	}
	for (const [, col] of byX) {
		col.sort((a, b) => pos.get(a.id)!.y - pos.get(b.id)!.y);
		for (let i = 1; i < col.length; i++) {
			const prev = col[i - 1];
			const cur = col[i];
			check(pos.get(prev.id)!.y + prev.height <= pos.get(cur.id)!.y + 1e-9, `column nodes ${prev.id}/${cur.id} must not overlap vertically`);
		}
	}
}

// ---- empty + single --------------------------------------------------------
{
	eq(layoutGraph([], OPTS).size, 0, "empty graph -> empty layout");

	const pos = layoutGraph([node("a")], OPTS);
	eq(pos.size, 1, "single node placed");
	eq(pos.get("a")!.x, OPTS.margin, "lone node sits at the left margin");
	eq(pos.get("a")!.y, OPTS.margin, "lone node sits at the top margin");
}

// ---- chain a -> b -> c: three increasing columns ---------------------------
{
	const nodes = [node("a"), node("b", ["a"]), node("c", ["b"])];
	const pos = layoutGraph(nodes, OPTS);
	eq(pos.get("a")!.x, OPTS.margin + 0 * PITCH, "a in column 0");
	eq(pos.get("b")!.x, OPTS.margin + 1 * PITCH, "b in column 1 (samples a)");
	eq(pos.get("c")!.x, OPTS.margin + 2 * PITCH, "c in column 2 (samples b)");
	check(pos.get("a")!.x < pos.get("b")!.x && pos.get("b")!.x < pos.get("c")!.x, "chain flows strictly left-to-right");
}

// ---- every dependency lands left of its dependent (the core invariant) -----
{
	// Diamond: a -> b, a -> c, (b,c) -> d.
	const nodes = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];
	const pos = layoutGraph(nodes, OPTS);
	for (const n of nodes) for (const dep of n.deps) check(pos.get(dep)!.x < pos.get(n.id)!.x, `dependency ${dep} sits left of dependent ${n.id}`);
	eq(pos.get("b")!.x, pos.get("c")!.x, "siblings b and c share a column");
	eq(pos.get("d")!.x, OPTS.margin + 2 * PITCH, "join node d in the last column");
	noOverlap(nodes, pos);
}

// ---- independent passes stack in one column without overlap ----------------
{
	const nodes = [node("a", [], 40), node("b", [], 60), node("c", [], 30)];
	const pos = layoutGraph(nodes, OPTS);
	for (const id of ["a", "b", "c"]) eq(pos.get(id)!.x, OPTS.margin, `${id} (no deps) in column 0`);
	noOverlap(nodes, pos);
}

// ---- feedback (self-edge) is ignored for layering --------------------------
{
	// b feeds back into itself AND samples a; the self-edge must not push b right.
	const nodes = [node("a"), node("b", ["b", "a"])];
	const pos = layoutGraph(nodes, OPTS);
	eq(pos.get("a")!.x, OPTS.margin, "a in column 0 despite b's self-edge");
	eq(pos.get("b")!.x, OPTS.margin + PITCH, "self-loop does not move b past column 1");

	// A lone self-loop stays at column 0.
	const solo = layoutGraph([node("z", ["z"])], OPTS);
	eq(solo.get("z")!.x, OPTS.margin, "lone feedback node stays in column 0");
}

// ---- unknown / dangling dependency ids are tolerated -----------------------
{
	const pos = layoutGraph([node("a", ["ghost"]), node("b", ["a"])], OPTS);
	eq(pos.get("a")!.x, OPTS.margin, "dep on a missing node is ignored (a stays at column 0)");
	eq(pos.get("b")!.x, OPTS.margin + PITCH, "real edge still places b in column 1");
}

// ---- cyclic input terminates and positions every node ----------------------
{
	// Not a real DAG (a<->b); the relaxation cap must still terminate and place both.
	const pos = layoutGraph([node("a", ["b"]), node("b", ["a"])], OPTS);
	eq(pos.size, 2, "cycle still yields a position per node (no hang)");
	check(Number.isFinite(pos.get("a")!.x) && Number.isFinite(pos.get("b")!.x), "cycle positions are finite");
}

// ---- deterministic ---------------------------------------------------------
{
	const nodes = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];
	const a = layoutGraph(nodes, OPTS);
	const b = layoutGraph(nodes, OPTS);
	for (const n of nodes) {
		eq(a.get(n.id)!.x, b.get(n.id)!.x, `${n.id} x is deterministic`);
		eq(a.get(n.id)!.y, b.get(n.id)!.y, `${n.id} y is deterministic`);
	}
}

console.log(`ok - ${passed} assertions passed`);
