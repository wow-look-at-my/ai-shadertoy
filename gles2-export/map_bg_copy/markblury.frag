// ============================================================================
// map_bg copy  ::  pass "MarkBlurY"   (render target format: rgba8)
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

// --- Input channels used by this pass (see manifest.json for bindings) ---
uniform sampler2D iChannel0;

// --- Custom uniforms used by this pass (project defaults in manifest.json) ---
uniform float u_markBlur;

// ============================ user shader body ============================

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;
	float r = u_markBlur;
	vec3 sum = vec3(0.0);
	float wsum = 0.0;
	for (int i = -16; i <= 16; i++) {
		float y = float(i) / 16.0;
		float w = exp(-y * y * 2.5);
		vec2 off = vec2(0.0, float(i) * r / 16.0) / iResolution.xy;
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
