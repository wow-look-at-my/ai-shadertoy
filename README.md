# AI Shadertoy

A single-page, **client-side** sandbox where an AI builds 2D WebGL2 fragment
shaders with you. Describe what you want in chat; the AI writes the shader, sees
the rendered result (screenshots) and the GLSL compile log, and iterates. It can
also wire up input textures and expose live parameters as sliders.

- **No backend.** Everything runs in your browser. Your API key is stored locally
  and used only for calls you authorize.
- **Multi-pass render graph.** Not limited to a single shader (or Shadertoy's
  fixed buffers): build a *graph* of passes, each rendering to its own texture and
  sampling the output of others — e.g. effect → blur X → blur Y → composite — with
  per-pass feedback (a pass reading its own previous frame). Each pass has as many
  inputs as the GPU allows (≥16), not a hard-wired four.
- **Single file.** The whole app builds to one self-contained `index.html`
  (~650 KB, no external requests) via [`ts0`](https://github.com/wow-look-at-my/ts0).
- **Bring your own model.** Works with Anthropic (Claude) or any
  OpenAI-compatible chat API, with vision + tool use.
- **Cheap to run.** Prompt caching is on by default, and a small live indicator
  shows tokens/sec, context use, and cost per turn + per session.

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
/ `list_passes` / `set_output_pass` (build and inspect the multi-pass render
graph), `set_uniforms` (live slider parameters, shared across passes),
`rename_shader` (rename the current shader), `set_channel` / `set_channel_asset`
(wire a pass input to a built-in texture, an image, or — `kind: pass` — another
pass's output), `list_assets`, `capture_screenshot`, and (optional)
`generate_texture`.

### Multi-pass render graph

A project is a graph of **passes**. Each pass is a full-screen fragment shader
that renders to its own offscreen texture; its inputs (`iChannel0`, `iChannel1`,
…) can sample built-in textures, image assets, or the **output of another pass** —
those wires are the graph edges. Passes execute in dependency order, and a channel
pointing at its own pass reads the *previous* frame (feedback, for trails /
accumulation / ping-pong simulation). One pass is the **output**, composited to
the screen. Passes can use an `rgba16f` target to keep HDR values for bloom/blur.
Edit it visually in the **Passes** tab (draggable nodes wired by their inputs), or
let the AI build it. Inputs per pass are not capped at four — add as many as you
need.

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

Projects, conversations, and image assets are stored in **IndexedDB**; settings in
`localStorage`. The app requests persistent storage so the browser won't evict it.
Use **Export** / **Import** (top bar) to move everything as a single JSON file
(API keys excluded by default).

## Develop

Requires Node 22+.

```sh
npm install
npm run typecheck      # tsc --noEmit
npm run build          # -> dist/index.html (single file)
```

Open `dist/index.html` directly in a browser — it has no external dependencies.

### Project layout

```
index.html              # ts0 HTML entry (links CSS, loads main.ts)
src/
  main.ts               # bootstrap: renderer + store + UI
  gl/                   # WebGL2 renderer, shader assembly, procedural textures
  ai/                   # provider adapters (Anthropic + OpenAI), agent loop, tools
  state/                # types, central store, IndexedDB persistence, defaults
  ui/                   # vanilla-DOM components: chat | (preview stacked over the
                        #   editor: Code / Passes graph / Uniforms / Textures)
  util/                 # DOM helper, tiny markdown renderer, misc
  shaders/              # default.frag.glsl + internal fullscreen.vert / present.frag
                        #   (all embedded into the bundle)
  styles/app.css
```

No runtime framework — just typed, vanilla DOM helpers, so the bundle stays small.

## Deploy

`.github/workflows/ci.yml` type-checks, builds, enforces the <1 MB budget, and
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
