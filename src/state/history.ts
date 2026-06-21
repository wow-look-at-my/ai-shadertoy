// Generic undo/redo history over immutable state snapshots. Deliberately
// DOM-free and dependency-free so it can be unit-tested with plain Node
// (`node --experimental-strip-types`).
//
// Model: `present` always mirrors the last committed state. Each undoable
// mutation calls commit() with the new live state; commit pushes the PREVIOUS
// `present` onto the undo stack (so undoing returns to it) and adopts a clone of
// the new state as `present`. Undo/redo move snapshots between the two stacks.
//
// Two features make this feel "really good" rather than mechanical:
//   - Coalescing: rapid edits of the same kind (e.g. each keystroke-debounce
//     while typing in one pass, or a slider drag) merge into a single entry
//     instead of flooding the stack, so one Ctrl+Z reverts the whole gesture.
//   - Grouping: an entire agent turn can be wrapped in begin/endGroup so all of
//     its tool edits collapse into one undo step the user can revert at once.

export interface HistoryEntry<S> {
	snapshot: S;
	/** Human-readable description of the action between the two states
	 * (e.g. "Edit Image code"); shown in the Undo/Redo tooltips. */
	label: string;
}

export interface HistoryOptions {
	/** Max undo entries kept; older ones are dropped. */
	limit: number;
	/** Window (ms) within which same-tag coalescing edits merge. */
	coalesceMs: number;
}

export class History<S> {
	private present: S;
	private undoStack: HistoryEntry<S>[] = [];
	private redoStack: HistoryEntry<S>[] = [];
	private lastTag: string | null = null;
	private lastTime = 0;

	// Grouping state: while groupDepth > 0, commits advance `present` but defer
	// pushing a single combined entry until the outermost endGroup().
	private groupDepth = 0;
	private groupBaseline: S | null = null;
	private groupLabel = "";
	private groupDirty = false;

	private onChange: (() => void) | null = null;
	private readonly clone: (s: S) => S;
	private readonly opts: HistoryOptions;

	constructor(initial: S, clone: (s: S) => S, opts: HistoryOptions) {
		this.clone = clone;
		this.opts = opts;
		this.present = clone(initial);
	}

	/** Register a callback fired whenever the stacks change (for UI button state). */
	setOnChange(cb: () => void): void {
		this.onChange = cb;
	}

	/** Discard all history and adopt `state` as the new baseline (e.g. on project
	 * switch -- undo must never cross from one project into another). */
	reset(state: S): void {
		this.present = this.clone(state);
		this.undoStack = [];
		this.redoStack = [];
		this.lastTag = null;
		this.groupDepth = 0;
		this.groupBaseline = null;
		this.groupDirty = false;
		this.emit();
	}

	/** Record a committed mutation. `current` is the new live state (cloned
	 * defensively). `tag` identifies the kind+target of the edit for coalescing;
	 * pass `coalesce: true` to merge with an immediately preceding same-tag edit. */
	commit(current: S, label: string, tag: string, coalesce = false): void {
		if (this.groupDepth > 0) {
			if (this.groupBaseline === null) this.groupBaseline = this.present;
			this.present = this.clone(current);
			this.groupDirty = true;
			return;
		}

		const now = Date.now();
		if (coalesce && this.undoStack.length > 0 && this.lastTag === tag && now - this.lastTime < this.opts.coalesceMs) {
			// Same gesture continuing: keep the existing baseline entry, just move
			// `present` forward so a later undo returns to before the gesture began.
			this.present = this.clone(current);
			this.lastTime = now;
			this.emit();
			return;
		}

		this.undoStack.push({ snapshot: this.present, label });
		if (this.undoStack.length > this.opts.limit) this.undoStack.shift();
		this.redoStack = [];
		this.present = this.clone(current);
		this.lastTag = tag;
		this.lastTime = now;
		this.emit();
	}

	/** Open a group; nested calls are reference-counted. All commits until the
	 * matching endGroup() collapse into one entry labelled `label`. */
	beginGroup(label: string): void {
		if (this.groupDepth === 0) {
			this.groupBaseline = null;
			this.groupLabel = label;
			this.groupDirty = false;
		}
		this.groupDepth++;
	}

	/** Close a group. On the outermost close, if anything changed, push one
	 * combined undo entry spanning the whole group. */
	endGroup(): void {
		if (this.groupDepth === 0) return;
		this.groupDepth--;
		if (this.groupDepth > 0) return;
		if (this.groupDirty && this.groupBaseline !== null) {
			this.undoStack.push({ snapshot: this.groupBaseline, label: this.groupLabel });
			if (this.undoStack.length > this.opts.limit) this.undoStack.shift();
			this.redoStack = [];
			this.lastTag = null; // a group never coalesces with later edits
			this.emit();
		}
		this.groupBaseline = null;
		this.groupDirty = false;
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}
	canRedo(): boolean {
		return this.redoStack.length > 0;
	}
	/** Label of the action a single undo would revert, or null if none. */
	undoLabel(): string | null {
		return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null;
	}
	/** Label of the action a single redo would re-apply, or null if none. */
	redoLabel(): string | null {
		return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
	}

	/** Step back one entry; returns the snapshot to apply, or null if at the
	 * oldest state. The returned object is owned by the caller for reading only. */
	undo(): S | null {
		const entry = this.undoStack.pop();
		if (!entry) return null;
		this.redoStack.push({ snapshot: this.present, label: entry.label });
		this.present = entry.snapshot;
		this.lastTag = null;
		this.emit();
		return this.present;
	}

	/** Step forward one entry; returns the snapshot to apply, or null if at the
	 * newest state. */
	redo(): S | null {
		const entry = this.redoStack.pop();
		if (!entry) return null;
		this.undoStack.push({ snapshot: this.present, label: entry.label });
		this.present = entry.snapshot;
		this.lastTag = null;
		this.emit();
		return this.present;
	}

	private emit(): void {
		this.onChange?.();
	}
}
