// Default shader. Edit this directly, or ask the AI in the chat to change it.
// Shadertoy convention: write the final colour to fragColor. fragCoord is in
// pixels. The harness adds #version, precision, uniforms and main() for you.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
	// Centered, aspect-corrected coordinates in roughly [-1, 1].
	vec2 uv = fragCoord / iResolution.xy;
	vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

	float t = iTime * 0.3;
	float d = length(p);
	float a = atan(p.y, p.x);

	// Interfering ripples + a rotating wave for some motion.
	float v = sin(d * 10.0 - t * 4.0 + sin(a * 3.0 + t));
	v += sin((p.x + p.y) * 6.0 + t * 2.0);
	v *= 0.5;

	// Cosine palette (Inigo Quilez style) cycling over the wave field.
	vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + v * 3.14159 + t);

	// Vignette toward the edges.
	col *= smoothstep(1.1, 0.2, d);

	fragColor = vec4(col, 1.0);
}
