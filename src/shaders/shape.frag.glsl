#version 300 es
// Per-kind shape coverage. The outline of each instanced quad is cut out by a
// signed-distance function chosen by the kind index.
//
// TO ADD A NEW SHAPE: append a `case` to shapeDistance() below AND a matching
// entry (in the SAME ORDER) to SHAPE_DEFS in gl/shapes.ts. The case index here
// equals the shape's position in that registry, so the two stay in lockstep.
// `d` is a signed distance in PIXELS (negative inside the shape).
precision highp float;

in vec2 v_local;
in vec2 v_half;
in vec4 v_color;
flat in int v_kind;
in float v_radius;
in float v_feather;

uniform float uOpacity; // layer opacity, folded into the geometry

out vec4 fragColor;

float shapeDistance(int kind, vec2 p, vec2 halfExtent, float r) {
	float d = 1.0;
	if (kind == 0) {
		// quad / rounded rectangle
		vec2 q = abs(p) - halfExtent + r;
		d = min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
	} else if (kind == 1) {
		// circle / ellipse (gradient-normalized implicit distance)
		vec2 e = p / halfExtent;
		float f = dot(e, e) - 1.0;
		vec2 g = 2.0 * p / (halfExtent * halfExtent);
		d = f / max(length(g), 1e-6);
	}
	return d;
}

void main() {
	float d = shapeDistance(v_kind, v_local, v_half, v_radius);
	float aa = fwidth(d) + 2.0 * v_feather + 1e-4;
	float cov = clamp(0.5 - d / aa, 0.0, 1.0);
	float a = v_color.a * cov * uOpacity;
	fragColor = vec4(v_color.rgb * a, a); // premultiplied alpha
}
