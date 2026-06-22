// ============================================================================
// Untitled shader  ::  pass "Image"   (render target format: rgba8)
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

// --- Custom uniforms used by this pass (project defaults in manifest.json) ---
uniform float u_speed;
uniform float u_slices;
uniform float u_warp;
uniform vec3 u_palShift;
uniform float u_relief;
uniform float u_ambient;
uniform float u_shininess;
uniform float u_specStrength;
uniform float u_lightDist;

// ============================ user shader body ============================
// Kaleidoscopic fractal plasma v2 (Phong-lit)
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }

vec3 palette(float t){
    return 0.5 + 0.5*cos(6.28318*(u_palShift + vec3(0.0,0.33,0.67) + t));
}

// Fractal "height" field at a folded point, used as a heightmap for lighting.
float fieldAt(vec2 p, float t){
    vec2 z = p;
    float field = 0.0;
    float amp = 1.0;
    for(int i=0;i<6;i++){
        z = abs(z) / dot(z,z) - u_warp;  // inversion fold
        z *= rot(t*0.1 + float(i)*0.5);
        field += amp * length(z);
        amp *= 0.55;
    }
    return field;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

    float t = iTime * u_speed;

    // Kaleidoscope fold
    float a = atan(p.y, p.x);
    float r = length(p);
    float seg = 6.28318 / u_slices;
    a = mod(a, seg);
    a = abs(a - seg*0.5);
    p = vec2(cos(a), sin(a)) * r;

    // Slow zoom + rotation
    p *= 1.4 + 0.4*sin(t*0.3);
    p *= rot(t*0.2);

    // Fractal field as a heightmap
    float field = fieldAt(p, t);

    // --- Build a surface normal from the height gradient ---
    float e = 0.0025;
    float hx = fieldAt(p + vec2(e,0.0), t) - fieldAt(p - vec2(e,0.0), t);
    float hy = fieldAt(p + vec2(0.0,e), t) - fieldAt(p - vec2(0.0,e), t);
    // gradient -> normal; u_relief scales bump steepness
    vec2 grad = vec2(hx, hy) / (2.0*e);
    vec3 N = normalize(vec3(-grad * u_relief, 1.0));

    // --- Phong lighting ---
    // Light orbits overhead; view straight on.
    vec3 L = normalize(vec3(cos(t*0.7)*u_lightDist, sin(t*0.7)*u_lightDist, 1.0));
    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 R = reflect(-L, N);

    float diff = max(dot(N, L), 0.0);
    float spec = pow(max(dot(R, V), 0.0), u_shininess);

    // Base material colour from the fractal field
    float v = sin(field*2.0 - t*2.0);
    vec3 base = palette(field*0.15 + v*0.2 + t*0.05);

    vec3 col = base * (u_ambient + (1.0 - u_ambient) * diff);
    col += vec3(1.0, 0.97, 0.9) * spec * u_specStrength; // warm-white highlight
    col += exp(-3.5*abs(v)) * base * 0.15;               // faint thread glow

    // Vignette
    col *= smoothstep(1.3, 0.1, length((uv-0.5)*vec2(iResolution.x/iResolution.y,1.0)));

    col = pow(col, vec3(0.85)); // lift
    fragColor = vec4(col, 1.0);
}
// ============================ generated entry point ============================
void main() {
	vec4 ai_color = vec4(0.0, 0.0, 0.0, 1.0);
	mainImage(ai_color, gl_FragCoord.xy);
	gl_FragColor = ai_color;
}
