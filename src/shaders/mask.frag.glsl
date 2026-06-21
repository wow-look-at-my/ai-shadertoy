#version 300 es
// Layer mask composite: attenuate a layer by its mask. The mask's alpha is the
// layer's per-pixel opacity, so the result is a straight linear blend between the
// layers below (`under`) and this layer's composite -- both premultiplied, so the
// mix is correct without un-premultiplying.
precision highp float;

uniform sampler2D uUnder;     // composite of the layers below (premultiplied)
uniform sampler2D uComposite; // this layer's composite over `under` (premultiplied)
uniform sampler2D uMask;      // the mask layer's output; its alpha is the coverage
uniform vec2 uResolution;

out vec4 fragColor;

void main() {
	vec2 uv = gl_FragCoord.xy / uResolution;
	vec4 under = texture(uUnder, uv);
	vec4 comp = texture(uComposite, uv);
	float m = clamp(texture(uMask, uv).a, 0.0, 1.0);
	fragColor = mix(under, comp, m);
}
