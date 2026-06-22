# ai-shadertoy -> GLES2 shader export

A **standalone, integration-ready** export of an ai-shadertoy project dump,
ported to **OpenGL ES 2.0 / GLSL ES 1.00**. It ships:

* the shaders, ported and **pruned** (each pass declares only the uniforms and
  channels it actually references -- nothing unused),
* a **drop-in C++ GLES2 renderer** (`cpp/shadertoy_gles2.h`) plus a generated
  data header that bakes in the shaders, the multi-pass graph and the uniform
  defaults, and
* a headless demo that builds and **renders every project to a PNG** -- so this
  isn't "trust me, it compiles," it's proven (see `cpp/`).

Nothing here touches the parent web app's build; it's a self-contained folder.

## What's inside

```
gles2-export/
  README.md
  extract.sh             <- jq-driven generator (re-derives everything below)
  source-export.json     <- the raw ai-shadertoy export it was generated from
  common/fullscreen.vert <- shared GLSL ES 1.00 vertex shader
  assets/
    assets.json          <- media metadata (id, name, size, type)
    a_8zsbfeg3tq08.png   <- decoded image asset (952x826)
    a_iwgolupk25fp.mp4   <- decoded video asset (640x360)
  map_bg/         manifest.json + image.frag                         (1 pass)
  map_bg_copy/    manifest.json + 6 .frag (cover/blur*/mark*/image)  (6 passes)
  untitled_shader/manifest.json + image.frag                         (1 pass)
  cpp/
    shadertoy_gles2.h        <- reusable renderer (single-header, drop-in)
    shadertoy_export.gen.h   <- GENERATED: embedded shaders + pass graph + uniforms
    demo.cpp                 <- headless EGL example -> PNG per project
    Makefile
    third_party/stb_image.h, stb_image_write.h   (public domain, for the demo)
```

## The three projects

| Folder | Passes | Inputs | Gist |
|---|---|---|---|
| `map_bg/` | 1 | image | Map image over a procedural animated backdrop; background frosted, road markings kept sharp. |
| `map_bg_copy/` | 6 | image, video | Same idea, backdrop is a **video** blurred through a separable BlurX/BlurY chain (+ a lighter Mark chain) and composited. |
| `untitled_shader/` | 1 | none | Self-contained Phong-lit kaleidoscopic fractal plasma. No textures. |

---

## Option A: use the C++ renderer (the easy path)

Two files are all you need in your project: **`cpp/shadertoy_gles2.h`** (the
engine) and **`cpp/shadertoy_export.gen.h`** (the data). You provide a current
GLES2 context and a decoded texture for each image/video asset.

```cpp
#define SHADERTOY_GLES2_IMPLEMENTATION      // in exactly one .cpp
#include "shadertoy_gles2.h"
#include "shadertoy_export.gen.h"

// 1. Decode each asset (ST_ASSETS[i]) into a GL texture you own:
StAssetTex assets[ST_ASSET_COUNT];
// assets[i] = { glTextureId, widthPx, heightPx };   // see demo.cpp

// 2. Pick a project and initialize at your viewport size:
StRenderer r;
stRendererInit(&r, &ST_PROJECTS[/*index*/2], ST_VERTEX_SRC, assets, W, H);

// 3. Each frame:
r.iTime = seconds; r.iFrame = frame;
stRenderFrame(&r);                 // renders all passes in topological order
// show it on screen:
glBindFramebuffer(GL_FRAMEBUFFER, 0);
glViewport(0, 0, W, H);
stPresent(&r, stRendererOutput(&r));
// (on resize: stRendererResize(&r, W, H);  on exit: stRendererDestroy(&r);)
```

That's it -- the renderer creates one program + one RGBA8 FBO per pass, wires
each `iChannelN` to the right pass output or asset texture, sets `iResolution`/
`iTime`/the custom `u_*` uniforms (by name; a pass that doesn't use one just
ignores it), and renders in the correct order. `forceClampWrap` (default on)
keeps NPOT textures framebuffer-complete on real GLES2 hardware.

### Build & run the demo (the proof)

```sh
cd cpp
sudo apt-get install -y libegl1-mesa-dev libgles2-mesa-dev libgl1-mesa-dri  # once
make
LIBGL_ALWAYS_SOFTWARE=1 ./demo 960x600 2.0     # renders render_<project>.png for each
```

The demo spins up a headless (surfaceless EGL) GLES2 context, loads the PNG
asset with stb_image, substitutes a placeholder for the undecodable video,
renders all three projects and writes a PNG each. It is an example you can
delete -- the renderer and the data header are the reusable parts.

> The video asset is real `.mp4` footage; GLES2 has no video texture. Decode
> frames with your platform decoder (FFmpeg / MediaCodec / AVFoundation) and
> upload the current frame into that asset's texture each tick (the web app does
> exactly this with a `<video>`). The demo uses a placeholder so the 6-pass
> graph still renders end to end.

---

## Option B: use the raw shaders + manifests yourself

If you have your own renderer, ignore `cpp/` and consume the `.frag` files and
each project's **`manifest.json`** directly. The manifest is the contract:

* `renderOrder` -- the topological order to render passes each frame.
* `outputPass` / `outputPassFile` -- the pass whose texture you present.
* per pass: `usesUniforms`, and `channels[]` (only the channels the shader
  samples), each resolved to a `fromPass` (sample that pass's texture) or an
  `asset` (with `assetFile` + `assetSize`).
* `customUniforms` -- the project-wide controls with their default `value`.

Each `.frag` pairs with `common/fullscreen.vert` (a fullscreen triangle; the
fragment shaders read `gl_FragCoord`, so no varyings are needed).

`map_bg_copy` dependency graph (rendered in this order):

```
video -> [Cover] -> [BlurX] -> [BlurY] ---\
                 \-> [MarkBlurX] -> [MarkBlurY] -\
image ----------------------------------> [Image] -> screen
  (Image: iChannel0=image, iChannel1=video, iChannel2=BlurY, iChannel3=MarkBlurY)
```

## The uniform contract

Shadertoy built-ins each pass may declare (the renderer sets these for you):

| Uniform | GL type | Meaning |
|---|---|---|
| `iResolution` | `vec3` | render-target size px, `(w, h, 1.0)` |
| `iTime` | `float` | seconds |
| `iTimeDelta` | `float` | seconds since previous frame |
| `iFrameRate` | `float` | fps |
| `iFrame` | `int` | frame index |
| `iMouse` | `vec4` | `(x, y, clickX, clickY)` px |
| `iDate` | `vec4` | `(year, month, day, secondsInDay)` |
| `iChannel0..N` | `sampler2D` | input textures (bind unit = channel index) |
| `iChannelResolution[i]` | `vec3[]` | source size of `iChannelI`, `(w, h, 1.0)` |

Custom `u_*` uniforms are project-wide controls (same name = same value across
passes); `type: "color"` is a `vec3`. Defaults are in `manifest.json` /
`ST_UNIFORMS_*`.

## GLES2 caveats (important for real hardware)

* **NPOT textures.** The image (952x826), video (640x360) and viewport-sized
  pass targets are non-power-of-two. Plain GLES2 renders NPOT + `GL_REPEAT` (or
  mipmaps) as **black**. These shaders keep UVs in `[0,1]`, so use
  `GL_CLAMP_TO_EDGE` + `GL_LINEAR` (no mipmaps) -- which the renderer does by
  default (`forceClampWrap`). The manifests preserve the original `wrap` values
  for fidelity; clamp is the safe substitute unless you have
  `GL_OES_texture_npot`.
* **`highp` in fragment shaders** isn't guaranteed on GLES2; every `.frag`
  guards it with `#ifdef GL_FRAGMENT_PRECISION_HIGH` and falls back to `mediump`.
* **Render targets are `rgba8`** -- allocate FBO textures as `GL_RGBA` /
  `GL_UNSIGNED_BYTE`.

## How it was generated

`extract.sh` traverses the dump with `jq` and regenerates **everything** except
the hand-written `cpp/shadertoy_gles2.h`, `cpp/demo.cpp`, `cpp/Makefile` and
`cpp/third_party/`:

```sh
./extract.sh                      # uses ./source-export.json
./extract.sh path/to/other.json   # or another ai-shadertoy export
```

For each pass it strips comments + inline `uniform` decls, probes which
built-ins / `iChannelN` / `u_*` the body actually references, and emits only
those -- so the shaders, the manifests' `usesUniforms`/`channels`, and the
generated C++ tables all agree and carry nothing unused. Requires `jq`, `perl`,
`base64`.

## Porting notes

* **Translated for GLES2:** `#version 100` + precision guard, `texture()` ->
  `texture2D()`, fragment output via `gl_FragColor`, inline `uniform` decls
  folded into the header, and per-pass pruning of unused declarations.
* **Faithful:** these shaders use only GLES2-safe features (constant-bound
  loops, `mat2`, standard built-ins) -- no integer/bitwise ops, no
  `textureLod`/`textureGrad`/derivatives, no MRT.
* **Verified:** every shader compiles as GLSL ES 1.00 (`glslangValidator`, with
  a negative control), zero declared-but-unused uniforms, and the C++ demo
  builds clean and renders all three projects headlessly.
* **Out of scope (your renderer's job):** video decoding and feedback passes
  (none of these projects use pass feedback). The app's layer/mask/geometry
  compositing is unused here -- each project is a single base layer.
```
