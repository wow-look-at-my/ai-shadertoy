// ============================================================================
// map_bg  ::  pass "Image"   (render target format: rgba8)
// Exported from ai-shadertoy and ported to GLSL ES 1.00 (OpenGL ES 2.0).
// Pair with common/fullscreen.vert. Only the uniforms and channels this pass
// actually references are declared; see manifest.json for the wiring/defaults.
// ============================================================================
#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

// --- Shadertoy built-in uniforms used by this pass ---
uniform vec3  iResolution;        // viewport resolution in px (z = pixel aspect, use 1.0)
uniform float iTime;              // playback time in seconds

// --- Input channels used by this pass (see manifest.json for bindings) ---
uniform sampler2D iChannel0;
uniform vec3 iChannelResolution[1];   // px size of each iChannel

// --- Custom uniforms used by this pass (project defaults in manifest.json) ---
uniform vec3 u_bgColor;
uniform float u_bgTolerance;
uniform float u_bgBlur;
uniform float u_markBlur;
uniform float u_bgSat;
uniform float u_bgValue;
uniform float u_bgFlatten;

// ============================ user shader body ============================
// Default shader. Edit this directly, or ask the AI in the chat to change it.
// Shadertoy convention: write the final colour to fragColor. fragCoord is in
// pixels. The harness adds #version, precision, uniforms and main() for you.

// How strongly a colour reads as "background" (1 = exactly the bg shade).
float bgWeight(vec3 c) {
	float dist = length(c - u_bgColor);
	return 1.0 - smoothstep(u_bgTolerance * 0.5, u_bgTolerance, dist);
}

vec3 desaturate(vec3 c, float sat) {
	float l = dot(c, vec3(0.299, 0.587, 0.114));
	return mix(vec3(l), c, sat);
}

// Box-ish Gaussian blur of given pixel radius around uv.
vec3 blurSample(vec2 uv, float radiusPx) {
	if (radiusPx < 0.25) return texture2D(iChannel0, uv).rgb;
	vec2 texel = radiusPx / iResolution.xy;
	vec3 sum = vec3(0.0);
	float wsum = 0.0;
	const int R = 4; // 9x9 taps
	for (int y = -R; y <= R; y++) {
		for (int x = -R; x <= R; x++) {
			vec2 o = vec2(float(x), float(y)) / float(R);
			float w = exp(-dot(o, o) * 2.0);
			sum += texture2D(iChannel0, uv + o * texel).rgb * w;
			wsum += w;
		}
	}
	return sum / wsum;
}

// Colorful gradient backdrop (the original IQ-palette ripple field).
vec3 gradientBackdrop(vec2 uv) {
	vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);
	float t = iTime * 0.3;
	float d = length(p);
	float a = atan(p.y, p.x);
	float v = sin(d * 10.0 - t * 4.0 + sin(a * 3.0 + t));
	v += sin((p.x + p.y) * 6.0 + t * 2.0);
	v *= 0.5;
	vec3 c = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + v * 3.14159 + t);
	c *= smoothstep(1.1, 0.2, d);
	return c;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;

	// Aspect-correct fit of the image into the viewport.
	vec2 tex = iChannelResolution[0].xy;
	float imgAsp = tex.x / tex.y;
	float scrAsp = iResolution.x / iResolution.y;
	vec2 tuv = uv;
	if (scrAsp > imgAsp) {
		tuv.x = (uv.x - 0.5) * (scrAsp / imgAsp) + 0.5;
	} else {
		tuv.y = (uv.y - 0.5) * (imgAsp / scrAsp) + 0.5;
	}

	// Classify using a small neighbourhood so thin markings still
	// register as "not background" and stay sharp.
	vec3 raw = texture2D(iChannel0, tuv).rgb;
	vec2 tx = 1.0 / iResolution.xy;
	float markNear = 0.0;
	markNear = max(markNear, 1.0 - bgWeight(texture2D(iChannel0, tuv + vec2( tx.x, 0.0)).rgb));
	markNear = max(markNear, 1.0 - bgWeight(texture2D(iChannel0, tuv + vec2(-tx.x, 0.0)).rgb));
	markNear = max(markNear, 1.0 - bgWeight(texture2D(iChannel0, tuv + vec2(0.0,  tx.y)).rgb));
	markNear = max(markNear, 1.0 - bgWeight(texture2D(iChannel0, tuv + vec2(0.0, -tx.y)).rgb));
	float bg = bgWeight(raw) * (1.0 - markNear);

	// Compute both versions with FIXED radii (consistent across pixels),
	// then blend by the background mask. This avoids the directional
	// streaking caused by a per-pixel-varying blur radius.
	vec3 sharp = blurSample(tuv, u_markBlur);
	vec3 soft  = blurSample(tuv, u_bgBlur);
	// Marking mask = how much brighter the (lightly blurred) map is than
	// the background shade. 1 on roads/labels, 0 on background.
	vec3 sharp2 = mix(sharp, soft, bg * 0.25);
	float bgLum = dot(u_bgColor, vec3(0.299, 0.587, 0.114));
	float mark = clamp((dot(sharp2, vec3(0.299, 0.587, 0.114)) - bgLum) * 4.0, 0.0, 1.0);

	// The raw gradient (full saturation, sharp) -- shows through markings.
	vec3 gradSharp = gradientBackdrop(uv);

	// Frosted-glass background: blurred + desaturated gradient.
	vec2 g = 1.0 / iResolution.xy;
	vec3 gradSoft = gradientBackdrop(uv);
	gradSoft += gradientBackdrop(uv + g * u_bgBlur * vec2( 1.0,  1.0));
	gradSoft += gradientBackdrop(uv + g * u_bgBlur * vec2(-1.0,  1.0));
	gradSoft += gradientBackdrop(uv + g * u_bgBlur * vec2( 1.0, -1.0));
	gradSoft += gradientBackdrop(uv + g * u_bgBlur * vec2(-1.0, -1.0));
	gradSoft /= 5.0;
	gradSoft = desaturate(gradSoft, u_bgSat);
	gradSoft = mix(gradSoft, vec3(dot(gradSoft, vec3(0.333))), u_bgFlatten);
	// Darken/milk the frosted background a touch so sharp markings pop.
	gradSoft = mix(gradSoft, gradSoft * 0.6 + 0.12, u_bgFlatten);
	// Overall brightness (value) of the frosted background.
	gradSoft *= u_bgValue;

	// Markings are a window to the clean gradient; background is frosted.
	vec3 col = mix(gradSoft, gradSharp, mark);

	fragColor = vec4(col, 1.0);
}
// ============================ generated entry point ============================
void main() {
	vec4 ai_color = vec4(0.0, 0.0, 0.0, 1.0);
	mainImage(ai_color, gl_FragCoord.xy);
	gl_FragColor = ai_color;
}
