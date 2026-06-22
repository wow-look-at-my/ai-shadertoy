// ============================================================================
// map_bg copy  ::  pass "Image"   (render target format: rgba8)
// Exported from ai-shadertoy and ported to GLSL ES 1.00 (OpenGL ES 2.0).
// Pair with common/fullscreen.vert. See this project's manifest.json for the
// channel wiring, render order and custom-uniform default values.
// ============================================================================
#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp int;
#else
precision mediump float;
precision mediump int;
#endif

// --- Shadertoy built-in uniforms (drive these from your render loop) ---
uniform vec3  iResolution;        // viewport resolution in px (z = pixel aspect, use 1.0)
uniform float iTime;              // playback time in seconds
uniform float iTimeDelta;         // seconds elapsed since the previous frame
uniform float iFrameRate;         // frames per second
uniform int   iFrame;             // playback frame index
uniform vec4  iMouse;             // xy = current px (while pressed), zw = last click px
uniform vec4  iDate;              // (year, month, day, seconds-in-day)

// --- This pass's input channels (see manifest.json for what feeds each) ---
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3 iChannelResolution[4];   // px size of each iChannel

// --- Custom uniforms (shared across all passes of this project) ---
uniform float u_markBlur;
uniform float u_bgBlur;
uniform vec3 u_bgColor;
uniform float u_bgTolerance;
uniform float u_bgSat;
uniform float u_bgFlatten;
uniform float u_bgValue;
uniform float u_markSat;
uniform float u_markFlatten;
uniform float u_markValue;

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

// Video backdrop (iChannel1), aspect-correct "cover" fit so it fills
// the viewport without stretching. Animates by itself each frame.
vec3 gradientBackdrop(vec2 uv) {
	vec2 tex = iChannelResolution[1].xy;
	float imgAsp = tex.x / tex.y;
	float scrAsp = iResolution.x / iResolution.y;
	vec2 vuv = uv;
	if (scrAsp > imgAsp) {
		// fill width, crop height
		vuv.y = (uv.y - 0.5) * (imgAsp / scrAsp) + 0.5;
	} else {
		vuv.x = (uv.x - 0.5) * (scrAsp / imgAsp) + 0.5;
	}
	return texture2D(iChannel1, vuv).rgb;
}

// Gaussian blur of the video backdrop at a given pixel radius.
vec3 videoBlur(vec2 uv, float radiusPx) {
	if (radiusPx < 0.25) return gradientBackdrop(uv);
	vec2 texel = radiusPx / iResolution.xy;
	vec3 sum = vec3(0.0);
	float wsum = 0.0;
	const int R = 4;
	for (int y = -R; y <= R; y++) {
		for (int x = -R; x <= R; x++) {
			vec2 o = vec2(float(x), float(y)) / float(R);
			float w = exp(-dot(o, o) * 2.0);
			sum += gradientBackdrop(uv + o * texel) * w;
			wsum += w;
		}
	}
	return sum / wsum;
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

	// Marking mask from the SHARP, never-blurred map sample: how much
	// brighter the map is than the background shade. Crisp road/label
	// edges -- the map itself is never blurred, only the video fill is.
	float bgLum = dot(u_bgColor, vec3(0.299, 0.587, 0.114));
	float mark = clamp((dot(raw, vec3(0.299, 0.587, 0.114)) - bgLum) * 4.0, 0.0, 1.0);

	// Markings reveal a LIGHTLY blurred video (so the train etc. isn't
	// razor-sharp), with brightness remapped 0..1 -> 0.4..1 so roads
	// always read clearly regardless of how dark the footage is.
	vec3 gradSharp = texture2D(iChannel3, uv).rgb;
	gradSharp = desaturate(gradSharp, u_markSat);
	gradSharp = mix(gradSharp, vec3(dot(gradSharp, vec3(0.333))), u_markFlatten);
	// Brightness remap 0..1 -> 0.4..1 so roads always read clearly...
	gradSharp = gradSharp * 0.6 + 0.4;
	// ...then the value scalar LAST, so u_markValue=0 -> fully black roads.
	gradSharp *= u_markValue;

	// Frosted-glass background: STRONGLY blurred video from the
	// separable BlurX/BlurY chain (iChannel2), then desaturated.
	vec3 gradSoft = texture2D(iChannel2, uv).rgb;
	gradSoft = desaturate(gradSoft, u_bgSat);
	gradSoft = mix(gradSoft, vec3(dot(gradSoft, vec3(0.333))), u_bgFlatten);
	// Darken/milk the frosted background a touch so sharp markings pop.
	gradSoft = mix(gradSoft, gradSoft * 0.6 + 0.12, u_bgFlatten);
	// Overall value (brightness) scalar for the frosted background.
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
