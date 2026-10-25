// Automatic layout for the passes render graph.

export interface GraphNode {
	id: string;
	/** Ids of passes this node samples (kind:"pass"). Self-edges/unknown ids are tolerated -- they're filtered out here. */
	deps: string[];
	/** Rendered node height in px (varies with the input-pin count). */
	height: number;
}

export interface NodePos {
	x: number;
	y: number;
}

export interface LayoutOpts {
	nodeWidth: number; // node width in px (fixed)
	hGap: number; // horizontal gap between columns
	vGap: number; // vertical gap between stacked nodes in a column
	margin: number; // top/left padding before the first column/row
}

export interface LayoutResult {
	/** Real node id -> top-left position. */
	pos: Map<string, NodePos>;
	/** For an edge that spans MORE THAN ONE column, the ordered routing waypoints the wire should thread so it doesn't cross the nodes in between. */
	routes: Map<string, NodePos[]>;
}

/** Vertical lane reserved in a column for one edge routed THROUGH it (a "dummy node" in layered-graph terms). */
const LANE_H = 12;

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
	const a = m.get(k);
	if (a) a.push(v);
	else m.set(k, [v]);
}

/** Lay the DAG out left-to-right in dependency layers (columns). Returns each real
 * node's top-left position plus routing waypoints for any edge that spans more
 * than one column. Columns are longest-path depth from a root. Edges spanning >1
 * column are broken by per-column lane "dummies" so they (a) reserve vertical
 * space and (b) get ordered alongside the real nodes. The barycenter pass then
 * keeps both real nodes and routed edges from crossing. */
export function layoutGraph(nodes: GraphNode[], opts: LayoutOpts): LayoutResult {
	const { nodeWidth, hGap, vGap, margin } = opts;
	const pos = new Map<string, NodePos>();
	const routes = new Map<string, NodePos[]>();
	if (!nodes.length) return { pos, routes };

	const ids = new Set(nodes.map((n) => n.id));
	const order = new Map(nodes.map((n, i) => [n.id, i] as const)); // stable original index
	// Keep only real, existing, non-self dependencies, then drop the back-edges of any cycle (mutual feedback) so the graph is a DAG.
	const deps = new Map(nodes.map((n) => [n.id, n.deps.filter((d) => d !== n.id && ids.has(d))] as const));
	dropBackEdges(nodes, deps);

	// --- columns: longest path from a root, via relaxation. ---
	const col = new Map<string, number>(nodes.map((n) => [n.id, 0] as [string, number]));
	for (let round = 0; round < nodes.length; round++) {
		let changed = false;
		for (const n of nodes) {
			let c = 0;
			for (const d of deps.get(n.id)!) c = Math.max(c, col.get(d)! + 1);
			if (c !== col.get(n.id)!) {
				col.set(n.id, c);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const maxCol = Math.max(...nodes.map((n) => col.get(n.id)!));

	// augment with lane "dummies": an edge crossing intermediate columns becomes
	// a chain of adjacent-column links, one lane node per skipped column.
	interface Slot {
		id: string;
		col: number;
		height: number;
		order: number;
		dummy: boolean;
	}
	const slots: Slot[] = nodes.map((n) => ({ id: n.id, col: col.get(n.id)!, height: n.height, order: order.get(n.id)!, dummy: false }));
	const next = new Map<string, string[]>(); // augmented adjacency, column c -> c+1
	const prev = new Map<string, string[]>();
	const routeChains = new Map<string, string[]>(); // `${from}>${to}` -> lane-node ids
	let laneSeq = 0;
	for (const n of nodes) {
		const cv = col.get(n.id)!;
		for (const d of deps.get(n.id)!) {
			const cu = col.get(d)!;
			if (cu >= cv) continue; // cannot happen once back-edges are dropped; a guard against a drawn-straight edge
			if (cv - cu === 1) {
				push(next, d, n.id);
				push(prev, n.id, d);
				continue;
			}
			// Keep the chain near its endpoints initially; the barycenter sweep refines it.
			const ord = order.get(d)! + order.get(n.id)! / (nodes.length + 1);
			const chain: string[] = [];
			let from = d;
			for (let c = cu + 1; c < cv; c++) {
				const id = `__lane${laneSeq++}`;
				slots.push({ id, col: c, height: LANE_H, order: ord, dummy: true });
				push(next, from, id);
				push(prev, id, from);
				chain.push(id);
				from = id;
			}
			push(next, from, n.id);
			push(prev, n.id, from);
			routeChains.set(`${d}>${n.id}`, chain);
		}
	}

	// Bucket slots by column, stable initial order.
	const columns: Slot[][] = Array.from({ length: maxCol + 1 }, () => []);
	for (const s of slots) columns[s.col].push(s);
	for (const c of columns) c.sort((a, b) => a.order - b.order);

	// order within columns: barycenter sweeps (alternating direction) over the augmented adjacency.
	const indexMap = (column: Slot[]): Map<string, number> => new Map(column.map((s, i) => [s.id, i] as const));
	const sortCol = (column: Slot[], adj: Map<string, string[]>, adjIdx: Map<string, number>): void => {
		const key = new Map<string, number>();
		column.forEach((s, i) => {
			const nbrs = adj.get(s.id);
			let sum = 0;
			let cnt = 0;
			if (nbrs) for (const m of nbrs) { const j = adjIdx.get(m); if (j !== undefined) { sum += j; cnt++; } }
			key.set(s.id, cnt ? sum / cnt : i);
		});
		column.sort((a, b) => key.get(a.id)! - key.get(b.id)! || a.order - b.order);
	};
	for (let sweep = 0; sweep < 6; sweep++) {
		if (sweep % 2 === 0) {
			for (let c = 1; c < columns.length; c++) sortCol(columns[c], prev, indexMap(columns[c - 1]));
		} else {
			for (let c = columns.length - 2; c >= 0; c--) sortCol(columns[c], next, indexMap(columns[c + 1]));
		}
	}

	// coordinates: stack each column, centering shorter columns vertically. Real slots yield a top-left.
	const colHeight = columns.map((c) => c.reduce((s, sl) => s + sl.height, 0) + Math.max(0, c.length - 1) * vGap);
	const tallest = Math.max(0, ...colHeight);
	const laneAt = new Map<string, [NodePos, NodePos]>();
	columns.forEach((c, ci) => {
		const x = margin + ci * (nodeWidth + hGap);
		let y = margin + (tallest - colHeight[ci]) / 2;
		for (const s of c) {
			if (s.dummy) {
				const ly = y + s.height / 2;
				laneAt.set(s.id, [{ x, y: ly }, { x: x + nodeWidth, y: ly }]);
			} else {
				pos.set(s.id, { x, y });
			}
			y += s.height + vGap;
		}
	});
	for (const [key, chain] of routeChains) routes.set(key, chain.flatMap((id) => laneAt.get(id)!));
	return { pos, routes };
}

/** Remove the back-edges of every cycle in `deps` (in place). A depth-first walk
 * in stable node order marks an edge as "back" when it points at a node still on
 * the current path. Those edges read the previous frame at draw time, so the
 * layout treats them as non-edges. */
function dropBackEdges(nodes: GraphNode[], deps: Map<string, readonly string[]>): void {
	const state = new Map<string, 1 | 2>();
	const visit = (id: string): void => {
		state.set(id, 1);
		const kept: string[] = [];
		for (const d of deps.get(id) ?? []) {
			const s = state.get(d);
			if (s === 1) continue; // back-edge: d is an ancestor on the current path
			if (s === undefined) visit(d);
			kept.push(d);
		}
		deps.set(id, kept);
		state.set(id, 2);
	};
	for (const n of nodes) if (!state.has(n.id)) visit(n.id);
}
