#version 300 es
// Full-screen triangle covering the viewport; no vertex attributes needed.
// Shared by every render pass and by the final present blit.
void main() {
	vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
