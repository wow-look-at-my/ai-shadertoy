// Shared helpers for the geometry tools: parse AI-supplied shape fields into a
// Shape patch (degrees -> radians, colour arrays, clamping) and describe shapes
// for tool output. Not a tool itself -- imported by create_object / edit_object / read.

import type { Shape } from "../../state/types.ts";
import { SHAPE_LABELS } from "../../gl/shapes.ts";

function num(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/** Parse an RGBA colour from an array of 0..1 numbers (alpha defaults to 1). */
export function parseColor(v: unknown): [number, number, number, number] | undefined {
	if (!Array.isArray(v) || v.length < 3) return undefined;
	const c = v.map((x) => Math.min(1, Math.max(0, Number(x) || 0)));
	return [c[0], c[1], c[2], v.length >= 4 ? c[3] : 1];
}

/** Build a partial Shape from AI input. `rotation` is in DEGREES (friendlier for
 * the model); it is stored as radians. Only fields actually provided are set. */
export function parseShapePatch(input: Record<string, unknown>): Partial<Shape> {
	const patch: Partial<Shape> = {};
	const x = num(input["x"]);
	if (x !== undefined) patch.x = x;
	const y = num(input["y"]);
	if (y !== undefined) patch.y = y;
	const w = num(input["w"]);
	if (w !== undefined) patch.w = Math.max(0, w);
	const h = num(input["h"]);
	if (h !== undefined) patch.h = Math.max(0, h);
	const rot = num(input["rotation"]);
	if (rot !== undefined) patch.rotation = (rot * Math.PI) / 180;
	const color = parseColor(input["color"]);
	if (color) patch.color = color;
	const cr = num(input["cornerRadius"]);
	if (cr !== undefined) patch.cornerRadius = Math.min(1, Math.max(0, cr));
	const f = num(input["feather"]);
	if (f !== undefined) patch.feather = Math.max(0, f);
	const fo = num(input["falloff"]);
	if (fo !== undefined) patch.falloff = Math.min(1, Math.max(0, fo));
	return patch;
}

export function describeShape(s: Shape, i: number): string {
	const deg = Math.round((s.rotation * 180) / Math.PI);
	const col = s.color.map((c) => +c.toFixed(2)).join(", ");
	const corner = s.kind === "quad" && s.cornerRadius > 0 ? `, corner ${s.cornerRadius.toFixed(2)}` : "";
	const grad = s.falloff > 0 ? `, falloff ${s.falloff.toFixed(2)}` : "";
	return `[${i}] ${SHAPE_LABELS[s.kind]} at (${s.x.toFixed(2)}, ${s.y.toFixed(2)}) size ${s.w.toFixed(2)}x${s.h.toFixed(2)}${deg ? `, rot ${deg} deg` : ""}, rgba(${col})${corner}${grad}`;
}

/** The shared `x/y/w/h/rotation/color/cornerRadius/feather` schema fields. */
export const SHAPE_SCHEMA_FIELDS = {
	x: { type: "number", description: "Centre X, 0..1 across the canvas width (0 = left, 1 = right)." },
	y: { type: "number", description: "Centre Y, 0..1 up the canvas height (0 = bottom, 1 = top)." },
	w: { type: "number", description: "Width as a fraction of the canvas width (e.g. 0.4)." },
	h: { type: "number", description: "Height as a fraction of the canvas height." },
	rotation: { type: "number", description: "Rotation in DEGREES (clockwise)." },
	color: { type: "array", items: { type: "number" }, description: "Fill colour [r,g,b] or [r,g,b,a], each 0..1." },
	cornerRadius: { type: "number", description: "Quad only: rounded-corner radius, 0..1 of the smaller half-extent." },
	feather: { type: "number", description: "Edge softness in pixels (0 = crisp)." },
	falloff: { type: "number", description: "Radial falloff 0..1. 0 = solid fill; >0 ramps alpha from 1 at the centre to 0 at the edge (1 = full radial gradient) -- use it to make the shape a soft mask." },
} as const;
