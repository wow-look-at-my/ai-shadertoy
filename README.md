# AI Shadertoy

A single-page, **client-side** sandbox where an AI builds 2D WebGL2 fragment
shaders with you. Describe what you want in chat; the AI writes the shader, sees
the rendered result (screenshots) and the GLSL compile log, and iterates. It can
also wire up input textures and expose live parameters as sliders.

- **No backend.** Everything runs in your browser. Your API key is stored locally
  and used only for calls you authorize.
- **Single file.** The whole app builds to one self-contained `index.html`
  (~370 KB, no external requests) via [`ts0`](https://github.com/wow-look-at-my/ts0).
- **Bring your own model.** Works with Anthropic (Claude) or any
  OpenAI-compatible chat API, with vision + tool use.

## How it works

1. You type a request in the chat (e.g. *"a swirling plasma in purples and gold"*).
2. The AI calls the `init_shader` tool with GLSL ES 3.00 source (Shadertoy-style
   `void mainImage(out vec4 fragColor, in vec2 fragCoord)`).
3. The app compiles it, renders it live on a WebGL2 canvas, and feeds a
   **screenshot + compile log** back to the model so it can self-correct.
4. The model iterates until it both compiles and looks right. You can tweak the
   code, parameters, and textures by hand at any time.

The AI's tools: `init_shader` (the first shader / a full rewrite), `edit_shader`
(targeted snippet replacements — the usual way it changes an existing shader, so
it doesn't retype the whole thing), `set_uniforms` (live slider parameters),
`set_channel` / `set_channel_asset` (bind textures to `iChannel0..3`),
`list_assets`, `capture_screenshot`, and (optional) `generate_texture`.

Models without native function calling still work: switch **Settings → Tool
calling** to **Text tags** and the model drives the same tools via forgiving XML
in its reply.

### Built-in uniforms (Shadertoy-compatible)

`iResolution`, `iTime`, `iTimeDelta`, `iFrameRate`, `iFrame`, `iMouse`, `iDate`,
`iChannel0..3`, `iChannelResolution[4]`. You only write `mainImage`; the harness
adds `#version`, precision, the uniform declarations, and `main()`.

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
  ui/                   # vanilla-DOM components (chat, preview, editor, settings)
  util/                 # DOM helper, tiny markdown renderer, misc
  shaders/              # default.frag.glsl (embedded into the bundle)
  styles/app.css
```

No runtime framework — just typed, vanilla DOM helpers, so the bundle stays small.

## Deploy

`.github/workflows/ci.yml` type-checks, builds, enforces the <1 MB budget, and
publishes the single file as a **public** per-branch site to
[buildhost](https://github.com/wow-look-at-my/buildhost) using GitHub Actions
OIDC (no static token). The live URL is
`https://sites.pazer.build/ai-shadertoy/branch/<branch>/`.
