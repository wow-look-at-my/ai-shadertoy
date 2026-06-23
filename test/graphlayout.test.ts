// Unit tests for the passes render-graph auto-layout (ui/graphlayout.ts). The
// graph is a DAG; positions are derived from the pass->pass edges, so a
// dependency always lands in an earlier (smaller-x) column than the pass that
// samples it, and an edge spanning more than one column gets routing waypoints so
// it can bend around the nodes in between. DOM-free, so plain Node can run it:
//   node --experimental-strip-types test/graphlayout.test.ts

import { layoutGraph, type GraphNode, type LayoutOpts, type NodePos } from "../src/ui/graphlayout.ts";

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
const colX = (c: number): number => OPTS.margin + c * PITCH;
const node = (id: string, deps: string[] = [], height = 50): GraphNode => ({ id, deps, height });

/** Assert no two same-column nodes overlap vertically. */
function noOverlap(nodes: GraphNode[], pos: Map<string, NodePos>): void {
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
	const empty = layoutGraph([], OPTS);
	eq(empty.pos.size, 0, "empty graph -> empty layout");
	eq(empty.routes.size, 0, "empty graph -> no routes");

	const { pos } = layoutGraph([node("a")], OPTS);
	eq(pos.size, 1, "single node placed");
	eq(pos.get("a")!.x, OPTS.margin, "lone node sits at the left margin");
	eq(pos.get("a")!.y, OPTS.margin, "lone node sits at the top margin");
}

// ---- chain a -> b -> c: three increasing columns ---------------------------
{
	const nodes = [node("a"), node("b", ["a"]), node("c", ["b"])];
	const { pos, routes } = layoutGraph(nodes, OPTS);
	eq(pos.get("a")!.x, colX(0), "a in column 0");
	eq(pos.get("b")!.x, colX(1), "b in column 1 (samples a)");
	eq(pos.get("c")!.x, colX(2), "c in column 2 (samples b)");
	check(pos.get("a")!.x < pos.get("b")!.x && pos.get("b")!.x < pos.get("c")!.x, "chain flows strictly left-to-right");
	eq(routes.size, 0, "adjacent-column chain needs no routing");
}

// ---- every dependency lands left of its dependent (the core invariant) -----
{
	// Diamond: a -> b, a -> c, (b,c) -> d. All edges are single-column.
	const nodes = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];
	const { pos, routes } = layoutGraph(nodes, OPTS);
	for (const n of nodes) for (const dep of n.deps) check(pos.get(dep)!.x < pos.get(n.id)!.x, `dependency ${dep} sits left of dependent ${n.id}`);
	eq(pos.get("b")!.x, pos.get("c")!.x, "siblings b and c share a column");
	eq(pos.get("d")!.x, colX(2), "join node d in the last column");
	eq(routes.size, 0, "diamond has no multi-column edges to route");
	noOverlap(nodes, pos);
}

// ---- skip edge gets a routing waypoint that avoids the middle node ----------
{
	// a -> b -> c, plus a -> c directly: a@0, b@1, c@2; the a->c edge spans col 1.
	const nodes = [node("a"), node("b", ["a"]), node("c", ["b", "a"])];
	const { pos, routes } = layoutGraph(nodes, OPTS);
	eq(pos.get("c")!.x, colX(2), "c lands in column 2 (longest path via b)");
	check(!routes.has("a>b") && !routes.has("b>c"), "single-column edges are not routed");
	const route = routes.get("a>c");
	check(!!route, "the skip edge a->c is routed");
	eq(route!.length, 2, "two waypoints per skipped column (a->c skips column 1)");
	eq(route![0].x, colX(1), "first waypoint at the skipped column's left edge");
	eq(route![1].x, colX(1) + OPTS.nodeWidth, "second waypoint at the skipped column's right edge");
	eq(route![0].y, route![1].y, "the spanning waypoints share a height -> a flat run across the column");
	// The lane must be clear, i.e. outside the middle node b's band, across the
	// whole column width (both waypoints are at the same clear height).
	const b = pos.get("b")!;
	const wy = route![0].y;
	check(wy <= b.y + 1e-9 || wy >= b.y + 50 - 1e-9, "routing lane avoids the middle node's vertical span");
}

// ---- longer skip gets one waypoint per skipped column ----------------------
{
	// chain a->b->c->d plus a->d (spans columns 1 and 2).
	const nodes = [node("a"), node("b", ["a"]), node("c", ["b"]), node("d", ["c", "a"])];
	const { pos, routes } = layoutGraph(nodes, OPTS);
	eq(pos.get("d")!.x, colX(3), "d in the last column");
	const route = routes.get("a>d");
	check(!!route, "the two-column skip edge a->d is routed");
	eq(route!.length, 4, "a->d skips two columns -> two waypoints each (4 total)");
	eq(route![0].x, colX(1), "column 1 left edge");
	eq(route![1].x, colX(1) + OPTS.nodeWidth, "column 1 right edge");
	eq(route![2].x, colX(2), "column 2 left edge");
	eq(route![3].x, colX(2) + OPTS.nodeWidth, "column 2 right edge");
}

// ---- independent passes stack in one column without overlap ----------------
{
	const nodes = [node("a", [], 40), node("b", [], 60), node("c", [], 30)];
	const { pos } = layoutGraph(nodes, OPTS);
	for (const id of ["a", "b", "c"]) eq(pos.get(id)!.x, OPTS.margin, `${id} (no deps) in column 0`);
	noOverlap(nodes, pos);
}

// ---- feedback (self-edge) is ignored for layering --------------------------
{
	const nodes = [node("a"), node("b", ["b", "a"])];
	const { pos, routes } = layoutGraph(nodes, OPTS);
	eq(pos.get("a")!.x, OPTS.margin, "a in column 0 despite b's self-edge");
	eq(pos.get("b")!.x, colX(1), "self-loop does not move b past column 1");
	eq(routes.size, 0, "a self-edge is not routed");

	const solo = layoutGraph([node("z", ["z"])], OPTS);
	eq(solo.pos.get("z")!.x, OPTS.margin, "lone feedback node stays in column 0");
}

// ---- unknown / dangling dependency ids are tolerated -----------------------
{
	const { pos } = layoutGraph([node("a", ["ghost"]), node("b", ["a"])], OPTS);
	eq(pos.get("a")!.x, OPTS.margin, "dep on a missing node is ignored (a stays at column 0)");
	eq(pos.get("b")!.x, colX(1), "real edge still places b in column 1");
}

// ---- cyclic input terminates and positions every node ----------------------
{
	const { pos } = layoutGraph([node("a", ["b"]), node("b", ["a"])], OPTS);
	eq(pos.size, 2, "cycle still yields a position per node (no hang)");
	check(Number.isFinite(pos.get("a")!.x) && Number.isFinite(pos.get("b")!.x), "cycle positions are finite");
}

// ---- deterministic ---------------------------------------------------------
{
	const nodes = [node("a"), node("b", ["a"]), node("c", ["b", "a"]), node("d", ["c", "a"])];
	const a = layoutGraph(nodes, OPTS);
	const b = layoutGraph(nodes, OPTS);
	for (const n of nodes) {
		eq(a.pos.get(n.id)!.x, b.pos.get(n.id)!.x, `${n.id} x is deterministic`);
		eq(a.pos.get(n.id)!.y, b.pos.get(n.id)!.y, `${n.id} y is deterministic`);
	}
	eq(JSON.stringify([...a.routes]), JSON.stringify([...b.routes]), "routes are deterministic");
}

console.log(`ok - ${passed} assertions passed`);
