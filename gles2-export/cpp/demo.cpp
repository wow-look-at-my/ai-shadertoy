/* demo.cpp -- headless proof-of-life for the GLES2 export.
 *
 * Creates an offscreen OpenGL ES 2.0 context (EGL surfaceless), loads the export
 * via shadertoy_export.gen.h, renders each project to an RGBA8 framebuffer with
 * shadertoy_gles2.h, reads the pixels back and writes a PNG per project.
 *
 * This is a self-contained example you can delete; the reusable pieces are
 * shadertoy_gles2.h (the renderer) and shadertoy_export.gen.h (the data).
 *
 * Build: see Makefile (links -lEGL -lGLESv2). Run: ./demo [project] [WxH] [time]
 *   project : index (0..) or name substring; omitted = render all
 *   WxH     : output size, e.g. 960x540 (default 800x600)
 *   time    : iTime seconds (default 1.5)
 *
 * The video asset (an .mp4) has no decoder here, so it is substituted with a
 * procedural placeholder texture -- the multi-pass graph still renders end to
 * end. Wire a real video frame into that asset slot in your own integration.
 */
#define SHADERTOY_GLES2_IMPLEMENTATION
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_WRITE_IMPLEMENTATION

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>

#include "shadertoy_gles2.h"
#include "shadertoy_export.gen.h"
#include "third_party/stb_image.h"
#include "third_party/stb_image_write.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <cmath>

static EGLDisplay g_dpy = EGL_NO_DISPLAY;
static EGLContext g_ctx = EGL_NO_CONTEXT;

static bool egl_init() {
	PFNEGLGETPLATFORMDISPLAYEXTPROC getPD =
		(PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
	g_dpy = getPD ? getPD(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL)
	              : eglGetDisplay(EGL_DEFAULT_DISPLAY);
	EGLint major = 0, minor = 0;
	if (!eglInitialize(g_dpy, &major, &minor)) { fprintf(stderr, "eglInitialize failed\n"); return false; }
	eglBindAPI(EGL_OPENGL_ES_API);
	const EGLint cfgAttr[] = {
		EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
		EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
		EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
		EGL_NONE
	};
	EGLConfig cfg; EGLint n = 0;
	if (!eglChooseConfig(g_dpy, cfgAttr, &cfg, 1, &n) || n < 1) { fprintf(stderr, "no EGL config\n"); return false; }
	const EGLint ctxAttr[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
	g_ctx = eglCreateContext(g_dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
	if (g_ctx == EGL_NO_CONTEXT) { fprintf(stderr, "eglCreateContext failed\n"); return false; }
	if (!eglMakeCurrent(g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, g_ctx)) { fprintf(stderr, "eglMakeCurrent failed\n"); return false; }
	fprintf(stderr, "GL_VERSION : %s\nGL_RENDERER: %s\n", glGetString(GL_VERSION), glGetString(GL_RENDERER));
	return true;
}

/* Upload an RGBA buffer as a CLAMP/LINEAR texture (NPOT-safe). */
static GLuint upload_rgba(const unsigned char *px, int w, int h) {
	GLuint t; glGenTextures(1, &t); glBindTexture(GL_TEXTURE_2D, t);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
	return t;
}

/* A recognizable placeholder for assets we can't decode here (e.g. video). */
static StAssetTex placeholder_texture(int w, int h) {
	std::vector<unsigned char> px((size_t)w * h * 4);
	for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
		size_t i = ((size_t)y * w + x) * 4;
		float u = (float)x / w, v = (float)y / h;
		px[i + 0] = (unsigned char)(255 * (0.5f + 0.5f * sinf(u * 12.0f)));
		px[i + 1] = (unsigned char)(255 * v);
		px[i + 2] = (unsigned char)(255 * (1.0f - u));
		px[i + 3] = 255;
	}
	StAssetTex t; t.tex = upload_rgba(px.data(), w, h); t.w = w; t.h = h;
	return t;
}

static std::string slug(const char *s) {
	std::string out;
	for (; *s; ++s) {
		char c = *s;
		if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
		out += ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) ? c : '_';
	}
	return out;
}

int main(int argc, char **argv) {
	const char *want = NULL;
	int W = 800, H = 600;
	float t = 1.5f;
	std::string assetsDir = "../assets", outDir = ".";
	for (int i = 1; i < argc; i++) {
		int w2, h2;
		if (sscanf(argv[i], "%dx%d", &w2, &h2) == 2) { W = w2; H = h2; }
		else if (strncmp(argv[i], "--assets=", 9) == 0) assetsDir = argv[i] + 9;
		else if (strncmp(argv[i], "--out=", 6) == 0) outDir = argv[i] + 6;
		else { char *end; float f = strtof(argv[i], &end); if (*end == 0 && end != argv[i]) t = f; else want = argv[i]; }
	}

	if (!egl_init()) return 1;

	/* Decode each asset once (shared across projects). */
	std::vector<StAssetTex> assetTex(ST_ASSET_COUNT);
	for (int i = 0; i < ST_ASSET_COUNT; i++) {
		const StAsset &a = ST_ASSETS[i];
		std::string path = assetsDir + "/" + a.file;
		if (a.kind == ST_IMAGE) {
			int w, h, ch;
			unsigned char *px = stbi_load(path.c_str(), &w, &h, &ch, 4);
			if (px) {
				assetTex[i].tex = upload_rgba(px, w, h);
				assetTex[i].w = w; assetTex[i].h = h;
				stbi_image_free(px);
				fprintf(stderr, "asset %-16s loaded %dx%d from %s\n", a.id, w, h, path.c_str());
			} else {
				assetTex[i] = placeholder_texture(a.width, a.height);
				fprintf(stderr, "asset %-16s MISSING (%s) -> placeholder\n", a.id, path.c_str());
			}
		} else {
			assetTex[i] = placeholder_texture(a.width, a.height);
			fprintf(stderr, "asset %-16s video -> placeholder (no decoder)\n", a.id);
		}
	}

	stbi_flip_vertically_on_write(1); /* GL origin is bottom-left */

	int rendered = 0;
	for (int p = 0; p < ST_PROJECT_COUNT; p++) {
		const StProject &proj = ST_PROJECTS[p];
		if (want) {
			char idx[8]; snprintf(idx, sizeof idx, "%d", p);
			if (strcmp(want, idx) != 0 && !strstr(proj.name, want)) continue;
		}

		StRenderer r;
		if (!stRendererInit(&r, &proj, ST_VERTEX_SRC, assetTex.data(), W, H)) {
			fprintf(stderr, "project '%s' init failed\n", proj.name);
			return 2;
		}
		r.iTime = t;
		r.iFrame = (int)(t * 60.0f);
		stRenderFrame(&r);

		std::vector<unsigned char> px((size_t)W * H * 4);
		glBindFramebuffer(GL_FRAMEBUFFER, r.fbos[proj.outputPass]);
		glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px.data());
		glBindFramebuffer(GL_FRAMEBUFFER, 0);

		std::string file = outDir + "/render_" + slug(proj.name) + ".png";
		if (!stbi_write_png(file.c_str(), W, H, 4, px.data(), W * 4)) {
			fprintf(stderr, "failed to write %s\n", file.c_str());
			return 3;
		}
		fprintf(stderr, "rendered '%s' (%d passes) -> %s\n", proj.name, proj.passCount, file.c_str());
		stRendererDestroy(&r);
		rendered++;
	}

	for (auto &a : assetTex) glDeleteTextures(1, &a.tex);
	eglMakeCurrent(g_dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
	eglTerminate(g_dpy);
	fprintf(stderr, "%d project(s) rendered.\n", rendered);
	return rendered > 0 ? 0 : 4;
}
