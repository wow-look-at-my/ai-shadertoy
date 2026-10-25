// Unit tests for the undo/redo History class.

import { History } from "../src/state/history.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function eq(a: unknown, b: unknown, msg: string): void {
	check(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);
}

const clone = <S>(s: S): S => structuredClone(s);
const make = (initial = 0, limit = 200, coalesceMs = 100000) => new History<number>(initial, clone, { limit, coalesceMs });

// busy-wait so Date.now() strictly advances (for the coalesce-window expiry test).
function spin(ms: number): void {
	const t = Date.now();
	while (Date.now() - t < ms) {
	}
}

// ---- basics ----------------------------------------------------------------
{
	const h = make(0);
	eq(h.canUndo(), false, "empty: nothing to undo");
	eq(h.canRedo(), false, "empty: nothing to redo");
	eq(h.undo(), null, "undo on empty returns null");

	h.commit(1, "a", "t1");
	h.commit(2, "b", "t2");
	eq(h.canUndo(), true, "after commits can undo");
	eq(h.undoLabel(), "b", "top undo label is last action");

	eq(h.undo(), 1, "undo -> previous state");
	eq(h.redoLabel(), "b", "redo label after undo");
	eq(h.undo(), 0, "undo -> initial state");
	eq(h.canUndo(), false, "back at initial: nothing to undo");

	eq(h.redo(), 1, "redo -> 1");
	eq(h.redo(), 2, "redo -> 2");
	eq(h.canRedo(), false, "fully redone: nothing to redo");
}

// ---- redo invalidated by a new commit --------------------------------------
{
	const h = make(0);
	h.commit(1, "a", "t1");
	h.commit(2, "b", "t2");
	h.undo(); // back to a set limit, redo available
	eq(h.canRedo(), true, "redo available after undo");
	h.commit(9, "c", "t3"); // new branch
	eq(h.canRedo(), false, "new commit clears redo");
	eq(h.undo(), 1, "undo after new commit returns to 1");
}

// ---- coalescing ------------------------------------------------------------
{
	const h = make(0);
	h.commit(1, "type", "code:p1", true);
	h.commit(2, "type", "code:p1", true); // same tag within window: merges
	h.commit(3, "type", "code:p1", true); // still merges
	eq(h.undo(), 0, "coalesced edits collapse to one undo back to baseline");
	eq(h.canUndo(), false, "only one entry was created by coalescing");
	eq(h.redo(), 3, "redo restores the latest coalesced value");
}
{
	const h = make(0);
	h.commit(1, "x", "tagA", true);
	h.commit(2, "y", "tagB", true); // different tag: separate entry
	eq(h.undo(), 1, "different tag does not coalesce (1)");
	eq(h.undo(), 0, "different tag does not coalesce (2)");
}
{
	const h = make(0);
	h.commit(1, "x", "t", false);
	h.commit(2, "x", "t", false); // coalesce flag off: never merges
	eq(h.undo(), 1, "coalesce=false keeps entries separate");
}
{
	const h = make(0, 200, 5); // 5ms window
	h.commit(1, "x", "t", true);
	spin(12); // let the window lapse
	h.commit(2, "x", "t", true); // same tag but expired -> separate entry
	eq(h.undo(), 1, "expired window does not coalesce (1)");
	eq(h.undo(), 0, "expired window does not coalesce (2)");
}

// ---- grouping --------------------------------------------------------------
{
	const h = make(0);
	h.beginGroup("AI turn");
	h.commit(1, "tool1", "x");
	h.commit(2, "tool2", "y");
	h.commit(3, "tool3", "z");
	h.endGroup();
	eq(h.undoLabel(), "AI turn", "group collapses to one labelled entry");
	eq(h.undo(), 0, "undoing the group returns to the pre-group baseline");
	eq(h.redo(), 3, "redoing the group restores the final state");
}
{
	const h = make(0);
	h.commit(1, "a", "t1");
	h.beginGroup("empty turn");
	h.endGroup(); // no commits inside
	eq(h.undoLabel(), "a", "an empty group adds no entry");
	eq(h.undo(), 0, "empty group is a no-op for history");
}
{
	const h = make(0);
	h.beginGroup("outer");
	h.beginGroup("inner"); // nested: reference-counted
	h.commit(5, "c", "x");
	h.endGroup(); // inner close: not yet flushed
	eq(h.canUndo(), false, "nested group not flushed until outermost close");
	h.endGroup(); // outer close: flush
	eq(h.undoLabel(), "outer", "outermost label wins for nested groups");
	eq(h.undo(), 0, "nested group undoes to baseline");
}

// ---- limit -----------------------------------------------------------------
{
	const h = make(0, 3); // keep entries
	for (let i = 1; i <= 6; i++) h.commit(i, `c${i}`, `t${i}`);
	let depth = 0;
	while (h.canUndo()) {
		h.undo();
		depth++;
		if (depth > 10) break; // guard against infinite loops
	}
	eq(depth, 3, "stack capped at the limit");
}

// ---- reset -----------------------------------------------------------------
{
	const h = make(0);
	h.commit(1, "a", "t1");
	h.commit(2, "b", "t2");
	h.reset(42);
	eq(h.canUndo(), false, "reset clears undo");
	eq(h.canRedo(), false, "reset clears redo");
	h.commit(43, "c", "t3");
	eq(h.undo(), 42, "after reset, undo returns to the new baseline");
}

// ---- onChange --------------------------------------------------------------
{
	const h = make(0);
	let calls = 0;
	h.setOnChange(() => calls++);
	h.commit(1, "a", "t1");
	h.undo();
	h.redo();
	check(calls >= 3, "onChange fires on commit/undo/redo");
}

console.log(`ok - ${passed} assertions passed`);
