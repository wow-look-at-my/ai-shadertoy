// ============================================================================
// map_bg copy  ::  pass "Cover"   (render target format: rgba8)
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
uniform vec3 iChannelResolution[1];   // px size of each iChannel

// ============================ user shader body ============================
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = fragCoord / iResolution.xy;
	vec2 tex = iChannelResolution[0].xy;
	float imgAsp = tex.x / tex.y;
	float scrAsp = iResolution.x / iResolution.y;
	vec2 vuv = uv;
	if (scrAsp > imgAsp) {
		vuv.y = (uv.y - 0.5) * (imgAsp / scrAsp) + 0.5;
	} else {
		vuv.x = (uv.x - 0.5) * (scrAsp / imgAsp) + 0.5;
	}
	fragColor = vec4(texture2D(iChannel0, vuv).rgb, 1.0);
}
// ============================ generated entry point ============================
void main() {
	vec4 ai_color = vec4(0.0, 0.0, 0.0, 1.0);
	mainImage(ai_color, gl_FragCoord.xy);
	gl_FragColor = ai_color;
}
