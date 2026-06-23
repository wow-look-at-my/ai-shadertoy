// Layered (Sugiyama-style) auto-layout for the pass render-graph, plus the shared
// node geometry it needs. Pure + DOM-free so the Passes view (src/ui/rightpanel.ts),
// the store, project migration, and a plain-Node unit test can all share one
// source of truth for node sizes and positions.
//
// The graph is a DAG of pass->pass channel edges (a channel pointing at its own
// pass is feedback, drawn but ignored for layout). Columns = dependency depth
// (longest path), so every forward edge points rightward and the on-screen output
// pass lands in the rightmost column. Within a column, nodes are ordered by the
// barycenter of their neighbours to reduce edge crossings, then the column is
// centred vertically.

import type { Pass } from "../state/types.ts";

// ---- node geometry (shared with the graph view) ----------------------------

export const NODE_W = 196;
export const HEADER_H = 30;
export const ROW_H = 26;
export const ADDROW_H = 24;

/** Y of input port i within a node (relative to the node's top-left). */
export const inPortY = (i: number): number => HEADER_H + ROW_H / 2 + i * ROW_H;
/** Y of the single output port within a node. */
export const outPortY = (pass: Pass): number => HEADER_H + (Math.max(pass.channels.length, 1) * ROW_H) / 2;
/** Total drawn height of a node (its input rows + header + "add input" row). */
export const nodeHeight = (pass: Pass): number => HEADER_H + pass.channels.length * ROW_H + ADDROW_H + 6;

// ---- layout -----------------------------------------------------------------

export interface NodePos {
	x: number;
	y: number;
}

export interface LayoutOptions {
	marginX?: number; // left padding of the first column
	marginY?: number; // top padding
	gapX?: number; // horizontal space between columns
	gapY?: number; // vertical space between stacked nodes
	sweeps?: number; // ordering passes for crossing reduction
}

/** Compute clean positions for a layer's pass graph. Returns a map of pass id ->
 * {x,y}; passes absent from `passes` are simply not in the map. Pure: it reads
 * only `passes` (their `channels` give the edges) and never touches the DOM. */
export function layoutPasses(passes: Pass[], outputPassId: string, opts: LayoutOptions = {}): Map<string, NodePos> {
	const MARGIN_X = opts.marginX ?? 40;
	const MARGIN_Y = opts.marginY ?? 40;
	const GAP_X = opts.gapX ?? 72;
	const GAP_Y = opts.gapY ?? 28;
	const SWEEPS = opts.sweeps ?? 4;

	const pos = new Map<string, NodePos>();
	const n = passes.length;
	if (n === 0) return pos;

	const index = new Map<string, number>();
	passes.forEach((p, i) => index.set(p.id, i));

	// Predecessor / successor lists from pass->pass channel edges. Self-feedback
	// and duplicate edges are dropped (they must not affect depth or ordering).
	const preds: number[][] = passes.map(() => []);
	const succs: number[][] = passes.map(() => []);
	passes.forEach((tgt, ti) => {
		const seen = new Set<number>();
		for (const ch of tgt.channels) {
			if (ch.kind !== "pass" || !ch.passId) continue;
			const si = index.get(ch.passId);
			if (si === undefined || si === ti || seen.has(si)) continue;
			seen.add(si);
			preds[ti].push(si);
			succs[si].push(ti);
		}
	});

	// Longest-path layering: col = max(col(pred) + 1), 0 for roots. Memoized DFS,
	// guarded against (invalid) cycles among distinct passes so it can't loop.
	const col = new Array<number>(n).fill(-1);
	const onStack = new Array<boolean>(n).fill(false);
	const depth = (v: number): number => {
		if (col[v] >= 0) return col[v];
		if (onStack[v]) return 0; // cycle: contribute nothing
		onStack[v] = true;
		let d = 0;
		for (const u of preds[v]) d = Math.max(d, depth(u) + 1);
		onStack[v] = false;
		col[v] = d;
		return d;
	};
	for (let v = 0; v < n; v++) depth(v);

	// Keep the layer's output pass in the rightmost column so the graph reads as a
	// left-to-right pipeline ending at what's shown on screen. Safe only when the
	// output feeds nothing else (otherwise that edge would point backwards).
	let maxCol = 0;
	for (let v = 0; v < n; v++) maxCol = Math.max(maxCol, col[v]);
	const outIdx = index.get(outputPassId);
	if (outIdx !== undefined && succs[outIdx].length === 0 && col[outIdx] < maxCol) col[outIdx] = maxCol;

	// Bucket nodes into columns (in stable array order).
	const columns: number[][] = [];
	for (let v = 0; v < n; v++) (columns[col[v]] ??= []).push(v);
	for (let c = 0; c < columns.length; c++) columns[c] ??= [];

	// order[v] = v's position within its column. Reduce crossings with a few
	// barycenter sweeps (alternating direction), ordering each column by the mean
	// position of its neighbours in the adjacent, already-ordered column.
	const order = new Array<number>(n).fill(0);
	for (const colNodes of columns) colNodes.forEach((v, i) => (order[v] = i));
	const barycenter = (v: number, neigh: number[][]): number => {
		const ns = neigh[v];
		if (ns.length === 0) return order[v];
		let s = 0;
		for (const u of ns) s += order[u];
		return s / ns.length;
	};
	for (let s = 0; s < SWEEPS; s++) {
		const downward = s % 2 === 0;
		const neigh = downward ? preds : succs;
		for (let ci = 0; ci < columns.length; ci++) {
			const c = downward ? ci : columns.length - 1 - ci;
			const colNodes = columns[c];
			if (colNodes.length < 2) continue;
			const key = new Map<number, number>();
			for (const v of colNodes) key.set(v, barycenter(v, neigh));
			colNodes.sort((a, b) => key.get(a)! - key.get(b)! || order[a] - order[b]);
			colNodes.forEach((v, i) => (order[v] = i));
		}
	}

	// Place: x by (compacted) column, y by stacking heights; centre each column
	// vertically against the tallest so the whole graph reads as balanced rows.
	const colHeights = columns.map((colNodes) => colNodes.reduce((sum, v) => sum + nodeHeight(passes[v]), 0) + Math.max(0, colNodes.length - 1) * GAP_Y);
	const maxH = Math.max(0, ...colHeights);
	let slot = 0;
	for (let c = 0; c < columns.length; c++) {
		const colNodes = columns[c];
		if (colNodes.length === 0) continue; // skip empty columns (no horizontal gap)
		colNodes.sort((a, b) => order[a] - order[b]);
		const x = MARGIN_X + slot * (NODE_W + GAP_X);
		let y = MARGIN_Y + (maxH - colHeights[c]) / 2;
		for (const v of colNodes) {
			pos.set(passes[v].id, { x, y });
			y += nodeHeight(passes[v]) + GAP_Y;
		}
		slot++;
	}
	return pos;
}

/** Run {@link layoutPasses} over a layer's graph and write the positions back. */
export function applyLayout(layer: { passes: Pass[]; outputPassId: string }, opts?: LayoutOptions): void {
	const pos = layoutPasses(layer.passes, layer.outputPassId, opts);
	for (const p of layer.passes) {
		const np = pos.get(p.id);
		if (np) {
			p.x = np.x;
			p.y = np.y;
		}
	}
}
