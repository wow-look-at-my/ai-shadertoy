// Automatic layout for the passes render graph. The graph is a DAG: data flows
// from a dependency to the pass that samples it (kind:"pass" channel), so a pass
// always sits to the RIGHT of the passes it reads (a pass sampling its own output
// is feedback -- a self-edge we ignore for layout). Node positions are DERIVED
// from this structure every render; passes carry no stored coordinates and the
// user cannot drag nodes around. DOM-free and pure so it can be unit-tested.

export interface GraphNode {
	id: string;
	/** Ids of passes this node samples (kind:"pass"). Self-edges/unknown ids are
	 * tolerated -- they're filtered out here. */
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

/** Lay the DAG out left-to-right in dependency layers (columns). Returns a map of
 * node id -> top-left position. Columns are longest-path depth from a root; nodes
 * within a column are ordered by a barycenter heuristic to reduce edge crossings,
 * then stacked and vertically centered against the tallest column. */
export function layoutGraph(nodes: GraphNode[], opts: LayoutOpts): Map<string, NodePos> {
	const { nodeWidth, hGap, vGap, margin } = opts;
	const pos = new Map<string, NodePos>();
	if (!nodes.length) return pos;

	const ids = new Set(nodes.map((n) => n.id));
	const order = new Map(nodes.map((n, i) => [n.id, i] as const)); // stable original index
	const height = new Map(nodes.map((n) => [n.id, n.height] as const));
	// Keep only real, existing, non-self dependencies.
	const deps = new Map(nodes.map((n) => [n.id, n.deps.filter((d) => d !== n.id && ids.has(d))] as const));

	// --- columns: longest path from a root, via relaxation (cycle-safe: a
	// back-edge can never extend the path past `nodes.length` rounds). ---
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

	// Bucket node ids by column, stable original order within each.
	const maxCol = Math.max(...nodes.map((n) => col.get(n.id)!));
	const columns: string[][] = Array.from({ length: maxCol + 1 }, () => []);
	for (const n of nodes) columns[col.get(n.id)!].push(n.id);
	for (const c of columns) c.sort((a, b) => order.get(a)! - order.get(b)!);

	// --- order within columns: a few barycenter sweeps (alternating direction)
	// to reduce edge crossings. Adjacency to the column being aligned against. ---
	const dependents = new Map<string, string[]>(nodes.map((n) => [n.id, []] as const));
	for (const n of nodes) for (const d of deps.get(n.id)!) dependents.get(d)!.push(n.id);
	const indexMap = (column: string[]): Map<string, number> => new Map(column.map((id, i) => [id, i] as const));

	for (let sweep = 0; sweep < 4; sweep++) {
		if (sweep % 2 === 0) {
			for (let c = 1; c < columns.length; c++) {
				const prev = indexMap(columns[c - 1]);
				sortByBarycenter(columns[c], order, (id) => barycenter(deps.get(id)!, prev));
			}
		} else {
			for (let c = columns.length - 2; c >= 0; c--) {
				const next = indexMap(columns[c + 1]);
				sortByBarycenter(columns[c], order, (id) => barycenter(dependents.get(id)!, next));
			}
		}
	}

	// --- coordinates: stack each column, centering shorter columns vertically. ---
	const colHeight = columns.map((c) => c.reduce((s, id) => s + height.get(id)!, 0) + Math.max(0, c.length - 1) * vGap);
	const tallest = Math.max(0, ...colHeight);
	columns.forEach((c, ci) => {
		const x = margin + ci * (nodeWidth + hGap);
		let y = margin + (tallest - colHeight[ci]) / 2;
		for (const id of c) {
			pos.set(id, { x, y });
			y += height.get(id)! + vGap;
		}
	});
	return pos;
}

/** Mean index of `neighbors` within an adjacent column, or null when this node has
 * no neighbors there (callers keep such nodes in place). */
function barycenter(neighbors: string[], index: Map<string, number>): number | null {
	let sum = 0;
	let count = 0;
	for (const nb of neighbors) {
		const i = index.get(nb);
		if (i !== undefined) {
			sum += i;
			count++;
		}
	}
	return count ? sum / count : null;
}

/** Stable sort a column by each node's barycenter; nodes with no neighbor in the
 * adjacent column keep their current slot (key = current index). */
function sortByBarycenter(column: string[], order: Map<string, number>, bary: (id: string) => number | null): void {
	const key = new Map<string, number>();
	column.forEach((id, i) => {
		const b = bary(id);
		key.set(id, b === null ? i : b);
	});
	column.sort((a, b) => key.get(a)! - key.get(b)! || order.get(a)! - order.get(b)!);
}
