# AI Shadertoy

A single-page, **client-side** sandbox where an AI builds 2D WebGL2 fragment
shaders with you. Describe what you want in chat; the AI writes the shader, sees
the rendered result (screenshots) and the GLSL compile log, and iterates. It can
also wire up input channels — built-in textures, images, **videos**, the
**webcam**, or another pass's output — and expose live parameters as sliders.

- **No backend.** Everything runs in your browser. Your API key is stored locally
  and used only for calls you authorize.
- **Layers — a node-graph "Photoshop".** The document is a back-to-front **stack
  of layers**. Each layer is its own render graph *plus* real instanced geometry
  (quads/circles), and it receives the composite of everything beneath it as an
  `under` input — so **the node graph decides how each layer blends** over the
  rest. Reorder, hide, and set per-layer opacity.
- **Multi-pass render graph.** Within a layer (and the classic single-layer case),
  build a *graph* of passes, each rendering to its own texture and sampling the
  output of others — e.g. effect → blur X → blur Y → composite — with per-pass
  feedback (a pass reading its own previous frame). Each pass has as many inputs as
  the GPU allows (≥16), not a hard-wired four.
- **Single file.** The whole app builds to one self-contained `index.html`
  (no external requests) via [`ts0`](https://github.com/wow-look-at-my/ts0).
- **Bring your own model.** Works with Anthropic (Claude) or any
  OpenAI-compatible chat API, with vision + tool use.
- **Cheap to run.** Prompt caching is on by default, and a small live indicator
  shows tokens/sec, context use, and cost per turn + per session.
- **Undo everything.** One unified history covers every change — your manual
  edits *and* the AI's — so a single undo reverts a whole AI turn.

## How it works

1. You type a request in the chat (e.g. *"a swirling plasma in purples and gold"*).
2. The AI calls the `init_shader` tool with GLSL ES 3.00 source (Shadertoy-style
   `void mainImage(out vec4 fragColor, in vec2 fragCoord)`).
3. The app compiles it, renders it live on a WebGL2 canvas, and feeds a
   **screenshot + compile log** back to the model so it can self-correct.
4. The model iterates until it both compiles and looks right. You can tweak the
   code, parameters, and textures by hand at any time.

The AI's tools: `init_shader` (the first shader / a full rewrite of the output
pass), `edit_shader` (targeted snippet replacements — the usual way it changes an
existing shader, so it doesn't retype the whole thing), `add_pass` / `remove_pass`
/ `list_passes` / `set_output_pass` (build and inspect the per-layer render graph),
`add_layer` / `remove_layer` / `reorder_layer` / `set_layer` / `select_layer` /
`list_layers` (manage the layer stack), `add_shape` / `edit_shape` / `remove_shape`
/ `list_shapes` (place and tweak geometry), `set_uniforms` (live slider parameters,
shared across all passes), `rename_shader` (rename the current shader),
`set_channel` / `set_channel_asset` (wire a pass input to `under`, `geometry`, a
built-in texture, an image, a video, the webcam, or — `kind: pass` — another pass's
output), `list_assets`, `capture_screenshot`, and (optional) `generate_texture`.
Pass and geometry tools act on the **active layer** (`select_layer` switches it).

### Layers (node-graph compositing)

The document is an ordered **stack of layers**, drawn **back to front** (the One
True draw order). Each layer is its own render graph (its own passes + an output
pass = that layer's composite) **plus** a list of **geometry shapes** (quads and
circles, real instanced meshes). Two layer-ambient inputs are available to any
pass in a layer, wired like any other channel:

- **`under`** — the composite of every layer *below* this one (transparent for the
  bottom layer). Sampling it is how a layer blends over what's underneath.
- **`geometry`** — this layer's shapes rasterized to a premultiplied texture
  (colour + coverage).

Because the blend is just shader math in the layer's output pass, **the node graph
controls the blending** — source-over by default, but rewrite the pass for
multiply, screen, add, displacement, masking, glow, whatever. A new layer comes
pre-wired `iChannel0 = under`, `iChannel1 = geometry`, doing source-over.

The **Layers** tab is the stack: reorder (front/back), show/hide, set opacity, add
layers, and edit each layer's shapes (position, size, rotation, colour, rounded
corners). You can also **manipulate shapes directly on the canvas** — click a shape
in the active layer to select it, then drag the body to move it, the corner
handles to resize, or the top handle to rotate (the shader's `iMouse` keeps
working on layers that have no geometry). Or let the AI drive it (`add_layer`,
`add_shape`, `edit_shape`, `reorder_layer`, …). Existing single-shader projects
load as one "Base" layer, so nothing changes until you add more.

### Multi-pass render graph (within a layer)

A layer's graph is one or more **passes**. Each pass is a full-screen fragment
shader that renders to its own offscreen texture; its inputs (`iChannel0`,
`iChannel1`, …) can sample `under`, `geometry`, built-in textures, image assets, or
the **output of another pass in the same layer** — those wires are the graph edges.
Passes execute in dependency order, and a channel pointing at its own pass reads
the *previous* frame (feedback, for trails / accumulation / ping-pong simulation).
One pass is the layer's **output** (its composite). Passes can use an `rgba16f`
target to keep HDR values for bloom/blur. Edit it visually in the **Passes** tab
(draggable nodes wired by their inputs, scoped to the active layer), or let the AI
build it. Inputs per pass are not capped at four — add as many as you need.

### Input channels (textures, video, webcam)

Each input channel can be bound — in the **Textures** tab or by the AI — to a
built-in procedural texture, an uploaded/generated **image**, an uploaded
**video** clip, the live **webcam**, or another pass's output. Videos and the
webcam are *dynamic*: their current frame is uploaded every render frame, so
sampling the channel animates on its own (and `iChannelResolution` reports the
source's size). Each channel has its own filter (linear/nearest) and wrap
(repeat/clamp/mirror). Webcam use prompts the browser for camera permission;
nothing is uploaded anywhere — the frames stay on your GPU.

Some tools require your approval before they take effect. When the AI calls one
(currently `rename_shader`), the chat shows an **Approve / Deny** prompt and the
action only runs if you approve; a denial is reported back to the model.

Models without native function calling still work: switch **Settings → Tool
calling** to **Text tags** and the model drives the same tools via forgiving XML
in its reply.

Hover any message to **edit** or **delete** it. Editing a prompt rewrites it and
re-runs from that point (everything after is replaced). Deleting removes that
exchange — a prompt and the reply it produced — and keeps the rest of the
conversation intact.

### Undo / redo

A single history tracks the whole project — every pass's code, the render graph,
formats, output pass, custom uniforms (including live slider drags), texture
bindings, and the shader name. The **Undo / Redo** buttons sit in the top bar
(their tooltips name the exact action), and the keyboard shortcuts are
**⌘/Ctrl+Z** and **⇧⌘/Ctrl+Shift+Z** (or **Ctrl+Y**).

What makes it work for an AI tool:

- **An entire AI turn is one undo step.** If the agent makes ten edits, one undo
  reverts the lot — including a turn you stopped partway through.
- **Gestures don't flood the stack.** Continuous typing in a pass, or a single
  slider drag, collapses into one entry.
- **Inside a text box, your usual per-character undo still works** — the global
  shortcut only steps in outside text fields, and the buttons always work.
- History is per-project (switching projects starts fresh) and is paused while
  the agent is running, so you can't unwind state mid-edit.

### Built-in uniforms (Shadertoy-compatible)

`iResolution`, `iTime`, `iTimeDelta`, `iFrameRate`, `iFrame`, `iMouse`, `iDate`,
`iChannel0`, `iChannel1`, … (one sampler per input the pass declares, plus a
matching `iChannelResolution[N]`). You only write `mainImage`; the harness adds
`#version`, precision, the uniform declarations, and `main()`.

## Setup

Open the app, click **Settings**, and add:

- **Provider** — Anthropic (Claude) or OpenAI-compatible.
- **Model** — defaults to `claude-opus-4-8`. Presets are provided; any model id is allowed.
- **API key** — stored only in your browser's `localStorage`.

Use **Test connection** to run a tiny real inference (it prompts the model for a
one-word reply and shows it), confirming the key, model, base URL, and (CORS)
connectivity all work before you start chatting.

If direct browser calls are blocked by CORS, tick **Route chat through CORS
proxy** (default `https://proxy.pazer.ai/`, prefix-style: the request becomes
`proxyURL + targetURL`).

Anthropic browser calls send `anthropic-dangerous-direct-browser-access: true`.
Note that Opus 4.8 / 4.7 reject `temperature`, so it is omitted for those models.

## Cost & usage

The chat panel shows a small live indicator: output **tokens/sec**, **context
window used**, and — for models with known pricing — **cost this turn** and
**cost this session**.

Requests use **prompt caching** to cut cost and latency: the stable system prompt
and the growing conversation history are cached, while the fast-changing project
state (shader size, uniforms, channels, last compile error) is sent as a separate
trailing message so it never invalidates the cache. For Anthropic this uses
`cache_control` breakpoints; OpenAI-compatible endpoints cache the matching prefix
automatically. Cost figures are estimates from a built-in price table — accurate
for Claude models, and tokens-only (no dollar figure) for unrecognized endpoints.

## Persistence & sharing

Projects, conversations, and media assets (images and videos) are stored in
**IndexedDB**; settings in `localStorage`. Videos are kept inline like images, so
prefer short, low-resolution loops (uploads are capped at 32 MB); webcam channels
store only the *binding* — the camera is re-requested on load. The app requests
persistent storage so the browser won't evict it. The top bar manages projects:
create a **New** one, **Duplicate** the current one (a full independent copy of its
passes, uniforms, and conversation — handy for forking an experiment), switch
between them, or **Delete**. Use **Export** / **Import** to move everything as a
single JSON file (API keys excluded by default).

## Develop

Requires Node 22+.

```sh
npm install
npm run typecheck      # tsc --noEmit
npm run test           # node strip-types unit tests (test/)
npm run build          # -> dist/index.html (single file)
npm run check          # all three of the above
```

Open `dist/index.html` directly in a browser — it has no external dependencies.

### Project layout

```
index.html              # ts0 HTML entry (links CSS, loads main.ts)
src/
  main.ts               # bootstrap: renderer + store + UI
  gl/                   # WebGL2 renderer, shader assembly, procedural textures
  ai/                   # provider adapters (Anthropic + OpenAI), agent loop, tools
  state/                # types, central store, undo/redo history, IndexedDB persistence
  ui/                   # vanilla-DOM components: chat | (preview stacked over the
                        #   editor: Code / Passes graph / Uniforms / Textures)
  util/                 # DOM helper, tiny markdown renderer, misc
  shaders/              # default.frag.glsl + internal fullscreen.vert / present.frag
                        #   (all embedded into the bundle)
  styles/app.css
test/                   # plain-Node unit tests (history.test.ts)
```

No runtime framework — just typed, vanilla DOM helpers, so the bundle stays small.

## Deploy

`.github/workflows/ci.yml` type-checks, builds, and
publishes the single file as a **public** per-branch site to
[buildhost](https://github.com/wow-look-at-my/buildhost) using GitHub Actions
OIDC (no static token). The live URL is
`https://sites.pazer.build/ai-shadertoy/branch/<branch>/`.

`.github/workflows/preview.yml` adds per-PR previews: on every pull request it
builds the bundle and deploys it to a `pr-<number>` site via the
`wow-look-at-my/actions/.github/workflows/buildhost-preview.yml` reusable
workflow, then posts a sticky comment with the preview URL
(`https://sites.pazer.build/ai-shadertoy/branch/pr-<number>/`). Previews are
served publicly to match the per-branch deploys. Fork PRs are skipped (no OIDC
token).
