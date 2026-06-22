// fullscreen.vert -- GLSL ES 1.00 vertex shader shared by every exported pass.
//
// The fragment shaders read gl_FragCoord directly, so this shader only needs to
// place a full-screen primitive in clip space; no varyings are required.
//
// Feed aPosition with clip-space coordinates. Two easy options:
//   * Full-screen TRIANGLE (3 verts, no index buffer):
//       (-1.0, -1.0), (3.0, -1.0), (-1.0, 3.0)
//   * Full-screen QUAD (TRIANGLE_STRIP, 4 verts):
//       (-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)
#version 100
attribute vec2 aPosition;
void main() {
	gl_Position = vec4(aPosition, 0.0, 1.0);
}
