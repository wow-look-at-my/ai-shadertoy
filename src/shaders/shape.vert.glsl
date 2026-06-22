#version 300 es
// Instanced shape geometry. One unit quad is drawn per shape, transformed to the
// shape's centre / size / rotation; the shape's actual outline is cut out
// per-fragment by a signed-distance function in shape.frag.glsl (selected by the
// kind index). Rotation is applied in PIXEL space so a non-square canvas never
// shears it. Shapes are rasterized into a layer's "geometry" texture, which the
// layer's node graph then composites.
precision highp float;

layout(location = 0) in vec2 a_corner; // unit quad corner in [-0.5, 0.5]
layout(location = 1) in vec4 a_box;    // xy = centre (0..1 of W,H), zw = size (fraction of W,H)
layout(location = 2) in vec4 a_color;  // straight RGBA, 0..1
layout(location = 3) in vec4 a_misc;   // x = rotation (rad), y = kind index, z = cornerRadius (0..1), w = feather (px)
layout(location = 4) in vec4 a_extra;  // x = radial falloff (0..1), yzw reserved

uniform vec2 uResolution;

out vec2 v_local;     // pixel offset from the centre, UN-rotated (the SDF domain)
out vec2 v_half;      // pixel half-extents
out vec4 v_color;
flat out int v_kind;
out float v_radius;   // corner radius in pixels
out float v_feather;  // feather in pixels
out float v_falloff;  // radial falloff (0..1)

void main() {
	vec2 halfExtent = vec2(a_box.z * uResolution.x, a_box.w * uResolution.y) * 0.5;
	vec2 lp = a_corner * 2.0 * halfExtent; // spans [-halfExtent, halfExtent]
	float s = sin(a_misc.x);
	float c = cos(a_misc.x);
	vec2 rp = mat2(c, s, -s, c) * lp;      // rigid rotation, pixel space
	vec2 centre = a_box.xy * uResolution;  // origin bottom-left, like fragCoord
	vec2 px = centre + rp;
	gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);

	v_local = lp;
	v_half = halfExtent;
	v_color = a_color;
	v_kind = int(a_misc.y + 0.5);
	v_radius = a_misc.z * min(halfExtent.x, halfExtent.y);
	v_feather = a_misc.w;
	v_falloff = a_extra.x;
}
