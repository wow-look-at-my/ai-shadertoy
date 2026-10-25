// On-canvas shape gizmo: click a shape in the ACTIVE layer to select it, then
// drag the body to move, the corner handles to resize.

import { el } from "../util/dom.ts";
import type { Shape } from "../state/types.ts";
import type { Store } from "../state/store.ts";

type HandleId = "tl" | "tr" | "br" | "bl" | "rotate";

// Local-corner signs for each resize handle (local +x right, +y down in CSS).
const CORNER_SIGN: Record<Exclude<HandleId, "rotate">, [number, number]> = {
	tl: [-1, -1],
	tr: [1, -1],
	br: [1, 1],
	bl: [-1, 1],
};

export function createShapeGizmo(store: Store, canvas: HTMLCanvasElement): HTMLElement {
	const overlay = el("div", { class: "gizmo-overlay" });
	const mkHandle = (id: HandleId, cls: string) => el("div", { class: `gizmo-handle ${cls}`, dataset: { handle: id } });
	const handles = [mkHandle("tl", "corner tl"), mkHandle("tr", "corner tr"), mkHandle("br", "corner br"), mkHandle("bl", "corner bl")];
	const rotStem = el("div", { class: "gizmo-rot-stem" });
	const rotHandle = mkHandle("rotate", "rotate");
	const box = el("div", { class: "gizmo-box" }, rotStem, ...handles, rotHandle);
	box.style.display = "none";
	overlay.appendChild(box);

	let dragging = false;

	const editMode = () => store.activeLayer().shapes.length > 0;
	const currentShape = (): Shape | null => (store.selectedShapeId ? store.activeLayer().shapes.find((s) => s.id === store.selectedShapeId) ?? null : null);
	const dims = () => ({ cw: canvas.clientWidth || 1, ch: canvas.clientHeight || 1 });

	// ---- geometry helpers (CSS space) --------------------------------------

	const centerOf = (s: Shape, cw: number, ch: number): [number, number] => [s.x * cw, (1 - s.y) * ch];
	const halfOf = (s: Shape, cw: number, ch: number): [number, number] => [(s.w * cw) / 2, (s.h * ch) / 2];
	// Screen directions of the shape's local +x / +y axes (phi = CSS rotation = -rotation).
	const axes = (rotation: number): { ax: [number, number]; ay: [number, number] } => {
		const phi = -rotation;
		const c = Math.cos(phi),
			s = Math.sin(phi);
		return { ax: [c, s], ay: [-s, c] };
	};
	// Pointer (dx,dy from center) -> local coords, un-rotating the box.
	const toLocal = (dx: number, dy: number, rotation: number): [number, number] => {
		const phi = -rotation;
		const c = Math.cos(phi),
			s = Math.sin(phi);
		return [dx * c + dy * s, -dx * s + dy * c];
	};

	function hitTest(s: Shape, px: number, py: number, cw: number, ch: number): boolean {
		const [cx, cy] = centerOf(s, cw, ch);
		const [hw, hh] = halfOf(s, cw, ch);
		const [lx, ly] = toLocal(px - cx, py - cy, s.rotation);
		const tol = 4; // a few px of slack for thin shapes
		if (s.kind === "circle") return (lx / Math.max(hw, 1)) ** 2 + (ly / Math.max(hh, 1)) ** 2 <= 1.08;
		return Math.abs(lx) <= hw + tol && Math.abs(ly) <= hh + tol;
	}

	function localPointer(e: PointerEvent): { px: number; py: number; cw: number; ch: number } {
		const r = canvas.getBoundingClientRect();
		return { px: e.clientX - r.left, py: e.clientY - r.top, cw: r.width || 1, ch: r.height || 1 };
	}

	// ---- rendering ----------------------------------------------------------

	function reposition(): void {
		const s = currentShape();
		if (!s) return;
		const { cw, ch } = dims();
		const [cx, cy] = centerOf(s, cw, ch);
		const [hw, hh] = halfOf(s, cw, ch);
		box.style.left = `${cx}px`;
		box.style.top = `${cy}px`;
		box.style.width = `${Math.max(2, hw * 2)}px`;
		box.style.height = `${Math.max(2, hh * 2)}px`;
		box.style.transform = `translate(-50%, -50%) rotate(${-s.rotation}rad)`;
		box.classList.toggle("is-circle", s.kind === "circle");
	}

	function rebuild(): void {
		overlay.style.pointerEvents = editMode() ? "auto" : "none";
		const s = currentShape();
		box.style.display = s ? "block" : "none";
		if (s) reposition();
	}

	// ---- drag handling ------------------------------------------------------

	function beginDrag(handle: HandleId | null, e: PointerEvent): void {
		const s = currentShape();
		if (!s) return;
		const layerId = store.activeLayer().id;
		e.preventDefault();
		dragging = true;
		overlay.classList.add("dragging");

		const start = localPointer(e);
		const { cw, ch } = start;
		const [cx0, cy0] = centerOf(s, cw, ch);
		const [hw0, hh0] = halfOf(s, cw, ch);

		// Move: remember the grab offset from the centre.
		const grabDX = cx0 - start.px;
		const grabDY = cy0 - start.py;

		// Resize: the opposite (fixed) corner in screen space, plus the local axes.
		let fixed: [number, number] = [cx0, cy0];
		const { ax, ay } = axes(s.rotation);
		if (handle && handle !== "rotate") {
			const [sgnX, sgnY] = CORNER_SIGN[handle];
			fixed = [cx0 - sgnX * hw0 * ax[0] - sgnY * hh0 * ay[0], cy0 - sgnX * hw0 * ax[1] - sgnY * hh0 * ay[1]];
		}

		const move = (ev: PointerEvent): void => {
			const r = canvas.getBoundingClientRect();
			const px = ev.clientX - r.left;
			const py = ev.clientY - r.top;
			const w = r.width || 1;
			const h = r.height || 1;
			if (handle === "rotate") {
				const [cx, cy] = centerOf(s, w, h);
				const dx = px - cx;
				const dy = py - cy;
				if (dx * dx + dy * dy < 4) return;
				store.updateShape(layerId, s.id, { rotation: -Math.atan2(dx, -dy) }, true);
			} else if (handle) {
				const dxv = px - fixed[0];
				const dyv = py - fixed[1];
				const newHW = Math.abs(dxv * ax[0] + dyv * ax[1]) / 2;
				const newHH = Math.abs(dxv * ay[0] + dyv * ay[1]) / 2;
				const ncx = fixed[0] + dxv / 2;
				const ncy = fixed[1] + dyv / 2;
				store.updateShape(layerId, s.id, { x: ncx / w, y: 1 - ncy / h, w: Math.max(0.01, (newHW * 2) / w), h: Math.max(0.01, (newHH * 2) / h) }, true);
			} else {
				const ncx = px + grabDX;
				const ncy = py + grabDY;
				const clamp = (v: number) => Math.max(-0.5, Math.min(1.5, v));
				store.updateShape(layerId, s.id, { x: clamp(ncx / w), y: clamp(1 - ncy / h) }, true);
			}
			reposition();
		};
		const up = (): void => {
			dragging = false;
			overlay.classList.remove("dragging");
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	}

	overlay.addEventListener("pointerdown", (e) => {
		if (!editMode()) return;
		const handle = (e.target as HTMLElement)?.dataset?.handle as HandleId | undefined;
		if (handle) {
			beginDrag(handle, e);
			return;
		}
		// Body / empty: hit-test the active layer's shapes (topmost paint first).
		const { px, py, cw, ch } = localPointer(e);
		const shapes = store.activeLayer().shapes;
		let hit: Shape | null = null;
		for (let i = shapes.length - 1; i >= 0; i--) {
			if (hitTest(shapes[i], px, py, cw, ch)) {
				hit = shapes[i];
				break;
			}
		}
		if (hit) {
			store.selectShape(hit.id);
			beginDrag(null, e);
		} else {
			store.clearShapeSelection();
		}
	});

	// Hover cursor: move over a shape, default otherwise.
	overlay.addEventListener("pointermove", (e) => {
		if (dragging || (e.target as HTMLElement)?.dataset?.handle) return;
		const { px, py, cw, ch } = localPointer(e);
		const shapes = store.activeLayer().shapes;
		let over = false;
		for (let i = shapes.length - 1; i >= 0; i--) if (hitTest(shapes[i], px, py, cw, ch)) { over = true; break; }
		overlay.style.cursor = over ? "move" : "default";
	});

	store.on("project", rebuild);
	store.on("selectedLayer", rebuild);
	store.on("selectedShape", rebuild);
	store.on("restore", rebuild);
	// Keep the box glued to the shape even when it changes from elsewhere (field
	// edits, AI, canvas resize). Cheap: restyles a few existing nodes.
	store.on("stats", () => {
		if (!dragging && currentShape()) reposition();
	});

	rebuild();
	return overlay;
}
