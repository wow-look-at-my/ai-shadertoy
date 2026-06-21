#version 300 es
// Present blit: copy the output pass's offscreen texture to the default
// framebuffer (the visible canvas). Every pass renders to its own texture so
// any pass can be sampled by others; this final draw shows the chosen output.
precision highp float;

uniform sampler2D uTex;
uniform vec2 uResolution;

out vec4 fragColor;

void main() {
	fragColor = texture(uTex, gl_FragCoord.xy / uResolution);
}
