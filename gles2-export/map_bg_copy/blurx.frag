// ============================================================================
// map_bg copy  ::  pass "BlurX"   (render target format: rgba8)
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
uniform vec3 iChannelResolution[1];   // px size of each iChannel

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

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;
	float r = u_bgBlur;
	vec3 sum = vec3(0.0);
	float wsum = 0.0;
	for (int i = -16; i <= 16; i++) {
		float x = float(i) / 16.0;
		float w = exp(-x * x * 2.5);
		vec2 off = vec2(float(i) * r / 16.0, 0.0) / iResolution.xy;
		sum += texture2D(iChannel0, uv + off).rgb * w;
		wsum += w;
	}
	fragColor = vec4(sum / wsum, 1.0);
}
// ============================ generated entry point ============================
void main() {
	vec4 ai_color = vec4(0.0, 0.0, 0.0, 1.0);
	mainImage(ai_color, gl_FragCoord.xy);
	gl_FragColor = ai_color;
}
