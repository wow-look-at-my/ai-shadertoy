// Shape registry: the single list of geometry primitives the editor knows about.
// Each entry carries a kind id, a display label, and the default parameters used
// when a shape of that kind is created. The UI pickers and the AI tools both
// enumerate from here, so a new primitive is one entry in this array.
//
// IMPORTANT: the ARRAY ORDER is the integer kind index the geometry shader
// switches on (see shaders/shape.frag.glsl -- `shapeDistance(kind, ...)`). To add
// a shape, append here AND add the matching `case` (same index) to that shader.

import type { Shape, ShapeKind } from "../state/types.ts";

export interface ShapeDef {
	id: ShapeKind;
	label: string;
	/** Defaults merged over makeShape()'s base when a shape of this kind is added. */
	defaults: Partial<Shape>;
}

export const SHAPE_DEFS: ShapeDef[] = [
	{ id: "quad", label: "Quad", defaults: { w: 0.4, h: 0.4, cornerRadius: 0 } },
	{ id: "circle", label: "Circle", defaults: { w: 0.3, h: 0.3, cornerRadius: 0 } },
];

export const SHAPE_KINDS: ShapeKind[] = SHAPE_DEFS.map((s) => s.id);

export const SHAPE_LABELS: Record<ShapeKind, string> = SHAPE_DEFS.reduce(
	(acc, s) => {
		acc[s.id] = s.label;
		return acc;
	},
	{} as Record<ShapeKind, string>,
);

/** The integer the geometry shader switches on for a kind (its registry index). */
export function shapeKindIndex(kind: ShapeKind): number {
	const i = SHAPE_KINDS.indexOf(kind);
	return i < 0 ? 0 : i;
}

export function shapeDef(kind: ShapeKind): ShapeDef | undefined {
	return SHAPE_DEFS.find((s) => s.id === kind);
}

export function isShapeKind(s: string): s is ShapeKind {
	return SHAPE_KINDS.includes(s as ShapeKind);
}
