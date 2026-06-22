# ai-shadertoy -> GLES2 shader export

This folder is a **standalone export** of an ai-shadertoy project dump, ported to
**GLSL ES 1.00 (OpenGL ES 2.0)** so the shaders drop straight into a GLES2 C++
renderer. It is self-contained and has nothing to do with the parent web app's
build -- it is a scratch deliverable on a throwaway branch.

Every fragment shader here has been compile-checked as GLSL ES 1.00 with
`glslangValidator` (and a negative control confirms the validator rejects
GLES3-only constructs under `#version 100`, so the pass is meaningful).

## What's inside

```
gles2-export/
  README.md              <- you are here
  extract.sh             <- the jq-driven generator that produced everything below
  source-export.json     <- the raw ai-shadertoy export this was generated from
  common/
    fullscreen.vert      <- shared GLSL ES 1.00 fullscreen vertex shader
  assets/
    assets.json          <- media library metadata (id, name, size, type)
    a_8zsbfeg3tq08.png   <- decoded image asset (952x826)
    a_iwgolupk25fp.mp4   <- decoded video asset (640x360)
  map_bg/                <- project 1 (single pass)
    manifest.json
    image.frag
  map_bg_copy/           <- project 2 (6-pass blur compositing graph)
    manifest.json
    cover.frag  blurx.frag  blury.frag  markblurx.frag  markblury.frag  image.frag
  untitled_shader/       <- project 3 (single pass, kaleidoscopic plasma)
    manifest.json
    image.frag
```

Each project's `manifest.json` is the integration contract: it lists the
**render order**, the **output pass**, every pass's **input-channel wiring**
(`iChannel0..N`), and the **custom uniforms with their default values**.

## The three projects at a glance

| Folder | Passes | Inputs | Output | Gist |
|---|---|---|---|---|
| `map_bg/` | 1 | image x1 | `image.frag` | Map image over a procedural animated backdrop; background frosted, road markings kept sharp. |
| `map_bg_copy/` | 6 | image x1, video x1 | `image.frag` | Same idea but the backdrop is a **video**, blurred through a separable BlurX/BlurY chain (+ a lighter MarkBlur chain). |
| `untitled_shader/` | 1 | none | `image.frag` | Self-contained Phong-lit kaleidoscopic fractal plasma. No textures needed. |

## How a ported shader is structured

The original app wraps a Shadertoy-style `mainImage(out vec4 fragColor, in vec2
fragCoord)` in a `#version 300 es` program. Each `.frag` here reproduces that
wrapper for **GLSL ES 1.00** instead:

* `#version 100` + a `GL_FRAGMENT_PRECISION_HIGH` precision guard.
* `texture(...)` rewritten to `texture2D(...)` (the only sampler call used).
* The built-in + channel + custom uniforms declared in a header.
* A generated `main()` that calls `mainImage()` and writes `gl_FragColor`.

You compile each `.frag` against `common/fullscreen.vert`. The fragment shaders
read `gl_FragCoord` directly, so the vertex shader only needs to place a
fullscreen primitive -- no varyings.

## The uniform contract (set these from your render loop)

These are the Shadertoy built-ins every pass declares. Set the ones the shader
uses; harmless to set them all.

| Uniform | GL type | Set with | Meaning / how to compute |
|---|---|---|---|
| `iResolution` | `vec3` | `glUniform3f` | Render-target size in px: `(width, height, 1.0)`. `.z` is pixel aspect; use `1.0`. |
| `iTime` | `float` | `glUniform1f` | Seconds since start. |
| `iTimeDelta` | `float` | `glUniform1f` | Seconds since previous frame. |
| `iFrameRate` | `float` | `glUniform1f` | Frames per second (e.g. `60.0`). |
| `iFrame` | `int` | `glUniform1i` | Integer frame counter. |
| `iMouse` | `vec4` | `glUniform4f` | `(x, y, clickX, clickY)` in px; `xy` valid while pressed. Pass `(0,0,0,0)` if unused. |
| `iDate` | `vec4` | `glUniform4f` | `(year, month, day, secondsInDay)`. Pass zeros if unused. |
| `iChannel0..N-1` | `sampler2D` | `glUniform1i` | Texture unit index the channel's texture is bound to. |
| `iChannelResolution[N]` | `vec3[]` | `glUniform3fv` | Per-channel source size in px: `(w, h, 1.0)`. For image/video = the media size; for a pass input = that pass's render-target size. |

The **custom uniforms** (`u_*`) are project-specific UI controls, **shared across
every pass of a project**. Their names, GLSL types and **default values** live in
each `manifest.json` under `customUniforms[]` (`type: "color"` means a `vec3`;
`value` is the default the app was last using). Set them once per project.

## Recipe 1 -- a single-pass project (`map_bg`, `untitled_shader`)

```c
// once:
GLuint prog = link(compile(GL_VERTEX_SHADER,   read("common/fullscreen.vert")),
                   compile(GL_FRAGMENT_SHADER, read("untitled_shader/image.frag")));
GLint aPos = glGetAttribLocation(prog, "aPosition");
// fullscreen triangle in clip space
const float tri[] = { -1.f,-1.f,  3.f,-1.f,  -1.f,3.f };
GLuint vbo; glGenBuffers(1,&vbo); glBindBuffer(GL_ARRAY_BUFFER,vbo);
glBufferData(GL_ARRAY_BUFFER,sizeof(tri),tri,GL_STATIC_DRAW);

// per frame:
glViewport(0,0,W,H);
glUseProgram(prog);
glUniform3f(glGetUniformLocation(prog,"iResolution"), (float)W,(float)H,1.f);
glUniform1f(glGetUniformLocation(prog,"iTime"), t);
// ...set the u_* custom uniforms from manifest.json defaults...
glEnableVertexAttribArray(aPos);
glVertexAttribPointer(aPos,2,GL_FLOAT,GL_FALSE,0,0);
glDrawArrays(GL_TRIANGLES,0,3);   // draws straight to the screen
```

`untitled_shader` samples no textures (its 3 channels are `none`); you can ignore
`iChannel*` entirely. `map_bg` samples the map image on `iChannel0`/`iChannel1`
(both bound to the same PNG) -- see Recipe 3 for texture setup. Its `iChannel2/3`
are `none` and can stay unbound.

## Recipe 2 -- a multi-pass project (`map_bg_copy`)

Each pass renders into its **own framebuffer-sized texture**; later passes sample
earlier passes as `iChannelN`. Follow `manifest.json`:

* `renderOrder`: `Cover -> MarkBlurX -> BlurX -> MarkBlurY -> BlurY -> Image`
  (a valid topological order; every input is rendered before its consumer).
* `outputPass`: `Image` -- after rendering all passes, blit/draw this pass's
  texture to the screen (or simply render the last pass directly to the default
  framebuffer).
* Per-pass `channels[]`: what to bind to each `iChannelN` (`fromPass` = sample
  another pass's texture; `asset` = sample a media file).

Dependency graph:

```
            video asset (a_iwgolupk25fp)
                     |
                  [Cover]
                  /     \
            [BlurX]     [MarkBlurX]
               |             |
            [BlurY]     [MarkBlurY]
               \             /
   image asset  \           /
 (a_8zsbfeg3..)  v         v
        \----> [Image] <---/        (iChannel0=image, iChannel1=video,
                  |                   iChannel2=BlurY, iChannel3=MarkBlurY)
               screen
```

Sketch:

```c
// once: create one FBO + one RGBA8 texture per pass, all sized to the viewport.
GLuint makeTarget(int W,int H){
    GLuint tex; glGenTextures(1,&tex); glBindTexture(GL_TEXTURE_2D,tex);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,W,H,0,GL_RGBA,GL_UNSIGNED_BYTE,0);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE); // NPOT-safe
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
    return tex;
}
// per frame, for each pass in renderOrder:
//   glBindFramebuffer(GL_FRAMEBUFFER, passFBO);   // output pass -> 0 (screen)
//   glUseProgram(passProg);
//   set iResolution/iTime/... and the u_* uniforms
//   for each channel: glActiveTexture(GL_TEXTURE0+i); glBindTexture(GL_TEXTURE_2D, srcTex);
//                     glUniform1i(iChannelI, i);
//                     set iChannelResolution[i] = (srcW, srcH, 1)
//   draw the fullscreen triangle
```

Because the format is `rgba8`, allocate targets as `GL_RGBA` / `GL_UNSIGNED_BYTE`.
All passes share one viewport size, so all `iChannelResolution` entries for
`fromPass` inputs are `(W, H, 1)`; for `asset` inputs use the media size from the
manifest (`assetSize`).

## Recipe 3 -- textures, sampler state, and the NPOT gotcha

Channel `filter` (`linear`/`nearest`) and `wrap` (`repeat`/`clamp`) map to:

| manifest | GL min/mag filter | GL wrap |
|---|---|---|
| `linear` | `GL_LINEAR` | -- |
| `nearest` | `GL_NEAREST` | -- |
| `repeat` | -- | `GL_REPEAT` |
| `clamp` | -- | `GL_CLAMP_TO_EDGE` |

**Important GLES2 caveat:** OpenGL ES 2.0 only supports `GL_REPEAT` / mipmaps on
**power-of-two** textures. The image (952x826), the video (640x360) and the
viewport-sized pass targets are all **NPOT**. If you set `GL_REPEAT` on an NPOT
texture without the `GL_OES_texture_npot` extension, the texture is *incomplete*
and samples as **black**. These shaders keep all UVs inside `[0,1]` (aspect-fit
math), so `repeat` vs `clamp` is visually irrelevant here -- **use
`GL_CLAMP_TO_EDGE` and `GL_LINEAR` (no mipmaps) for every texture** unless you
know `GL_OES_texture_npot` is available. (The manifest preserves the original
`wrap: "repeat"` for fidelity; clamp is the safe GLES2 substitute.)

Loading the **image** asset: decode `assets/a_8zsbfeg3tq08.png` with your image
loader (stb_image etc.) and `glTexImage2D` it as `GL_RGBA`.

Loading the **video** asset (`map_bg_copy` only): `assets/a_iwgolupk25fp.mp4` is
real footage. GLES2 has no video texture -- decode frames with your platform
decoder (FFmpeg, MediaCodec, AVFoundation...) and `glTexSubImage2D` the current
frame into a texture each tick, exactly as the web app re-uploads `<video>`
frames. For a quick static test, upload any single decoded frame (or a placeholder
colour) -- the graph still renders, just without motion.

## Regenerating

Everything except this README was produced by `extract.sh`, which traverses the
dump with `jq`:

```sh
./extract.sh                      # uses ./source-export.json
./extract.sh path/to/other.json   # or point it at another ai-shadertoy export
```

It re-derives the GLES2 fragment shaders, decodes the assets, computes each
project's topological render order, and writes the manifests. Requires `jq`,
`perl` and `base64` (all standard).

## What was and wasn't translated

* **Translated:** version directive, precision, `texture()` -> `texture2D()`,
  fragment output (`gl_FragColor`), inline `uniform` declarations folded into the
  header. These shaders use only GLES2-safe features (constant-bound loops,
  `mat2`, standard built-ins) -- no integer/bitwise ops, no `textureLod`/
  `textureGrad`/derivatives, no MRT -- so the ports are faithful.
* **Not translated (your renderer's job):** geometry/FBO/texture plumbing, video
  decoding, and the uniform *values* beyond the documented defaults. The app's
  layer/mask/geometry compositing features are unused by these three projects
  (each is a single base layer with no shapes or masks), so nothing there was
  dropped.
```
