# AI Shadertoy

A single-page, **client-side** sandbox where an AI builds 2D WebGL2 fragment shaders with you. Describe what you want in chat. The AI writes the shader, sees the rendered result (screenshots) and the GLSL compile log, and iterates. It can also wire up input channels — built-in textures, images, **videos**, the **webcam**, or another pass's output — and expose live parameters as sliders.

- **No backend.** Everything runs in your browser. Your API key is stored locally and used only for calls you authorize.
- **Layers — a node-graph "Photoshop".** The document is a back-to-front **stack of layers**. Each layer is its own render graph *plus* real instanced geometry (quads/circles). It receives the composite of everything beneath it as an `under` input — so **the node graph decides how each layer blends** over the rest. Reorder, hide, and set per-layer opacity.
- **Multi-pass render graph.** Within a layer (and the classic single-layer case), build a *graph* of passes, each rendering to its own texture. Sampling the output of others — e.g. effect → blur X → blur Y → composite — with per-pass feedback (a pass reading its own previous frame). Each pass has as many inputs as the GPU allows (≥16), not a hard-wired four.
- **Single file.** The whole app builds to one self-contained `index.html` (no external requests) via [`ts0`](https://github.com/wow-look-at-my/ts0).
- **Export the render.** Consider the preview's download button. That button offers lossless **PNG** and lossless **WebP**, plus lossless **EXR** (16-bit float) when the output pass is an HDR (`rgba16f`) target. So HDR renders leave the browser without clipping.
- **Inspect a render.** The preview's **Histogram** button charts the viewport or any pass buffer. It offers luma, saturation, value, R, G, B, and additive RGB modes.
- **Bring your own model.** Works with Anthropic (Claude) or any OpenAI-compatible chat API, with vision + tool use.
- **Cheap to run.** Prompt caching is on by default, and a small live indicator shows tokens/sec, context use, and cost per turn + per session.
- **Undo everything.** One unified history covers every change — your manual edits *and* the AI's — so a single undo reverts a whole AI turn.

## How it works

1. You type a request in the chat (e.g. *"a swirling plasma in purples and gold"*).
2. The AI calls `create_object` to author the first shader: GLSL ES 3.00 source (Shadertoy-style `void mainImage(out vec4 fragColor, in vec2 fragCoord)`).
3. The app compiles it, renders it live on a WebGL2 canvas. It feeds a **screenshot + compile log** back to the model so it can self-correct.
4. The model iterates until it both compiles and looks right. You can tweak the code, parameters, and textures by hand at any time.

The AI works through a small set of **generic, parameterized tools** — there is no "active" layer to track. It names the layer/pass/shape it means in each call (by name, id, stack index, or shape index):
- `read` — inspect anything: a pass's source + bindings + compile error, a layer's render graph, or the lists of layers / passes / shapes / assets / uniforms.
- `create_object` — add a `layer` (on top), a `pass` (named = a new pass, unnamed = author the layer's output pass, i.e. the first shader), a `shape`, or a `mask`.
- `destroy_object` — remove a layer / pass / shape / mask.
- `edit_object` — change properties (not source): layer name/visibility/opacity/ draw-order/output-pass, pass format, shape transform/colour, or the project name (a rename, which asks for your approval).
- `edit_shader` — targeted snippet replacements (the usual way it changes a shader, so it does not retype the whole thing).
- `connect_pins` — wire a shader-declared input to `under`, `geometry`, `mask`, a built-in texture, an asset, the webcam, or another pass's output.
- `set_uniforms` — live slider parameters, shared across all passes.
- `capture_screenshot`, `histogram` (the viewport or a pass buffer, by channel), and (optional) `generate_texture`.

### Layers (node-graph compositing)

The document is an ordered **stack of layers**, drawn **back to front** (the True draw order). Each layer is its own render graph (its own passes + an output pass = that layer's composite) **plus** a list of **geometry shapes** (quads and circles, real instanced meshes). Layer-ambient inputs are available to any pass in a layer, wired like any other channel:

- **`under`** — the composite of every layer *below* this one (transparent for the bottom layer). Sampling it is how a layer blends over what is underneath.
- **`geometry`** — this layer's shapes rasterized to a premultiplied texture (colour + coverage).
- **`mask`** — this layer's optional mask output, with alpha as coverage.

Because the blend is just shader math in the layer's output pass, **the node graph controls the blending**. Source-over by default, but rewrite the pass for multiply, screen, add, displacement, masking, glow, whatever. A new layer comes pre-wired `iChannel0 = under`, `iChannel1 = geometry`, doing source-over.

**Layer masks.** **The owner graph samples any layer can have a mask — another layer (rendered standalone) whose output *alpha***. Adding a mask appends a visible `Masked Composite` pass wired `iChannel0 = under`, `iChannel1 = unmasked output`, `iChannel2 = mask`, with shader math: `result = mix(under, thisComposite, mask.alpha)`. This is the clean way to show a layer (say a texture) through a shape — e.g. a circle. With full falloff makes a soft radial-gradient mask. The mask button on a layer row adds one (seeded with a soft circle) and lets you edit its geometry like any layer.

The AI uses `create_object type:mask` / `destroy_object type:mask`.

The **Layers** tab is the stack: reorder (front/back), show/hide, set opacity, add layers, and edit each layer's shapes (position, size, rotation, colour, rounded corners). You can also **manipulate shapes directly on the canvas**. Click a shape in the active layer to select it, then drag the body to move it. The corner handles to resize, or the top handle to rotate (the shader's `iMouse` keeps working on layers that have no geometry). Or let the AI drive it (`create_object`, `edit_object`, …). Existing single-shader projects load as one "Base" layer, so nothing changes until you add more.

### Multi-pass render graph (within a layer)

A layer's graph is one or more **passes**. Each pass is a full-screen fragment shader that renders to its own offscreen texture. Texture input pins are inferred from the shader: referencing `iChannel0` creates input 0, referencing `iChannel2` creates inputs 0 through 2, and removing references removes those pins. Inputs can sample `under`, `geometry`, `mask`, built-in textures, image assets, or the **output of another pass in the same layer**. Those wires are the graph edges. Passes execute in dependency order, and an input pointing at its own pass reads the *previous* frame (feedback, for trails / accumulation / ping-pong simulation).

One pass is the layer's **output** (its composite). Passes can use an `rgba16f` target to keep HDR values for bloom/blur. Edit it visually in the **Passes** tab, where the graph is **automatically arranged** left-to-right in dependency order (you wire nodes by their inputs and pan/zoom the view, but node positions are managed for you — there is nothing to drag into place). Otherwise, let the AI build it. Inputs per pass are not capped at four. Use as many `iChannelN` inputs as the shader needs, up to the GPU limit.

### Input channels (textures, video, webcam)

**The AI can bind each shader-declared texture input** — to a built-in procedural texture. An uploaded/generated **image**, an uploaded **video** clip, the live **webcam**, or another pass's output. Videos and the webcam are *dynamic*: their current frame is uploaded every render frame, so sampling the input animates on its own (and `iChannelResolution` reports the source's size). Each input has its own filter (linear/nearest) and wrap (repeat/clamp/mirror). Webcam use prompts the browser for camera permission. Nothing is uploaded anywhere — the frames stay on your GPU.

Upload media to the shared **Assets** tab — a library of images and videos that lives across all your shaders, independent of any channel. Upload (or drag and drop) one or several files at once — same files are de-duplicated, so re-adding the same image is a no-op. The AI can see them (`read what:assets`) and bind them to a pass input on its own (`connect_pins from=asset:<name>`). Rename an asset to give the AI a clear handle, or delete it to remove it everywhere it is used. (You can still upload straight into a channel from the Textures tab — that file lands in the same library.)

Some tool calls require your approval before they take effect. When the AI makes one (currently `edit_object type:project` — renaming the shader), the chat shows an **Approve / Deny** prompt and the action only runs if you approve. A denial is reported back to the model.

Models without native function calling still work: switch **Settings → Tool calling** to **Text tags**. The model drives the same tools via forgiving XML in its reply.

Hover any message to **edit** or **delete** it. Editing a prompt rewrites it and re-runs from that point (everything after is replaced). Deleting removes that exchange — a prompt and the reply it produced — and keeps the rest of the conversation intact.

### Steer the AI mid-turn

You do not have to wait for the AI to finish. While it works, keep typing and hit **Send** (or Enter) to **steer** it: your note is added to the conversation. The AI picks it up at its next step — folding in your correction without starting a separate turn. Use it to redirect ("actually make it blue"), add a constraint. Otherwise, answer a question it raised, all without losing the work in progress. **Stop** still cancels the turn and drops anything you queued but it has not read yet.

### Compact the chat

A long session piles up prompts, tool calls, and (heavy) screenshots, steadily filling the model's **context window** — the same one the usage indicator meters. Type **`/compact`** in the chat and send it: it does what you'd do by hand. Asks the model to *"summarize this entire conversation in detail for a future instance of yourself to pick up,"* then starts a fresh chat that **begins with that summary**, replacing the long history.

The live project state (current layers, passes, shapes, uniforms, the active layer's live GLSL source, last compile error) is always sent fresh, so the summary only needs to carry the *conversational* context. Your goal, stylistic intent, what was tried and rejected, and what is left — not the shader code. The result is shown as a single collapsible **"Conversation compacted"** card. The next message continues from there with a much smaller (and cheaper) prompt. Your shader, layers, and assets are untouched — only the chat transcript is summarized.

### Undo / redo

A single history tracks the whole project — every pass's code, the render graph, formats, output pass, custom uniforms (including live slider drags), texture bindings, and the shader name. The **Undo / Redo** buttons sit in the top bar (their tooltips name the exact action). The keyboard shortcuts are **⌘/Ctrl+Z** and **⇧⌘/Ctrl+Shift+Z** (or **Ctrl+Y**).

What makes it work for an AI tool:

- **An entire AI turn is one undo step.** If the agent makes edits, one undo reverts the lot — including a turn you stopped partway through.
- **Gestures do not flood the stack.** Continuous typing in a pass, or a single slider drag, collapses into one entry.
- **Inside a text box, your usual per-character undo still works** — the global shortcut only steps in outside text fields, and the buttons always work.
- History is per-project (switching projects starts fresh) and is paused while the agent is running. You cannot unwind state mid-edit.

### Built-in uniforms (Shadertoy-compatible)

`iResolution`, `iTime`, `iTimeDelta`, `iFrameRate`, `iFrame`, `iMouse`, `iDate`, `iChannel0`, `iChannel1`, … (one sampler per input the pass declares, plus a matching `iChannelResolution[N]`). You only write `mainImage`. The harness adds `#version`, precision, the uniform declarations, and `main()`.

### Custom uniforms (live sliders)

Declare your own controls right in the shader source — `uniform float/vec2/vec3/vec4 u_name;`. Each one automatically becomes a live slider (a colour picker for `vec3`/`vec4`) in the **Uniforms** tab. Add an optional default to bake in a starting value, e.g. `uniform float u_speed = 1.5;` or `uniform vec3 u_tint = vec3(1.0, 0.5, 0.2);` — the slider range widens to fit a default outside `0..1`. A trailing `// comment` is fine. Editing that default later (say `= 1.5` → `= 2.0`) updates the control. Custom uniforms are **shared across every pass and layer**, so the same `u_speed` drives them all.

The AI uses `set_uniforms` only to adjust an existing control's range, default, or label — the `uniform` line in the source is what creates it. It is a patch that touches only the named uniforms (it never resets the ones it leaves out).

The **Uniforms** tab's **Copy uniforms** button copies every uniform as GLSL declarations with their current values baked in (e.g. `uniform vec3 u_tint = vec3(1.0, 0.5, 0.2);`). Paste them into a shader to lock in the values you dialled in, since the copied text re-extracts. To the exact same controls.

## Setup

Open the app, click **Settings**, and add:

- **Provider** - Anthropic (Claude), OpenRouter, Ollama Cloud, or any OpenAI-compatible endpoint. Each brings its own base URL, model presets and CORS handling, so picking one and pasting a key is enough.
- **Model** - defaults to `claude-opus-5`. Presets are provided. Any model id is allowed. OpenRouter and Ollama Cloud publish their catalogues without a key, so the model list fills itself before you paste one.
- **API key** - stored only in your browser's `localStorage`. Each provider keeps its own key, so switching providers does not overwrite the others.

Use **Test connection** to run a tiny real inference (it prompts the model for a one-word reply and shows it), confirming the key, model, base URL, and (CORS) connectivity all work before you start chatting.

**Bifrost.** Bifrost speaks both wire formats. For OpenAI models pick **OpenAI-compatible** and set the base URL to `http://localhost:8080/v1`. For Anthropic models pick **Anthropic** and set it to `http://localhost:8080/anthropic`. Any base-URL override sends the virtual key in `x-bf-vk` beside the normal credential header. Model ids name the provider Bifrost routes to (`<provider>/<model>`) on the OpenAI wire. A direct browser connection needs `x-bf-vk` in Bifrost's `allowed_headers`.

**OpenRouter sign-in.** Settings offers **Sign in with OpenRouter**. It opens OpenRouter's authorize page and returns with a code. The app exchanges that code for an API key labeled AI Shadertoy, selects OpenRouter, and stores the key. The open Settings form is restored after the redirect. The page must be served over http(s).

If CORS blocks direct browser calls, tick **Route chat through CORS proxy**. Ollama Cloud sends no CORS headers at all, so choosing it ticks the box for you and says why. You can still untick it.

The proxy setting is a **template** naming where the target URL goes, so any proxy shape works:

| Template | Request becomes |
| --- | --- |
| `https://proxy.pazer.ai/?url={{.url}}` (default) | `https://proxy.pazer.ai/?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages` |
| `https://cors.example.com/{{.rawurl}}` | `https://cors.example.com/https://api.anthropic.com/v1/messages` |

`{{.url}}` inserts the target percent-encoded (what a query parameter needs) and
`{{.rawurl}}` inserts it verbatim (what a path-prefix proxy needs). A setting
with neither token has the target appended, which is the older prefix form, so a proxy URL saved before templates existed keeps working.

Anthropic browser calls send `anthropic-dangerous-direct-browser-access: true`. Claude 4.6 and newer run with extended thinking, which excludes `temperature`, so it is only sent to the older budget-thinking models (Sonnet 4.5, Haiku 4.5, Opus 4.5 and earlier).

## Cost & usage

The chat panel shows a small live indicator: output **tokens/sec** and **context window used**. This also covers **% cached**, and — for models with known pricing — **cost this turn** and **cost this session**.

The **% cached** rate and the spend figure are shown **only from the true, server-reported usage** — they are never estimated or inferred. If the endpoint reports how many prompt tokens were served from cache, that exact number is used (an explicit `0` shows as `0% cached`). If it reports no cache count at all (some local OpenAI-compatible servers omit it), the **% cached** indicator is hidden rather than guessed. Likewise, cost is a true calculation: the real input, output, cache-read, and cache-write token counts multiplied by the model's known published rates (cache writes bill at ~1.25× the base input rate, cache reads at ~0.1×). It is not an estimate — but it is only shown for models with a known price. Unrecognized endpoints show tokens only, no dollar figure.

Requests use **prompt caching** to cut cost and latency. Consider the stable system prompt and the growing conversation history. That prompt are cached, while the fast-changing project state (each layer's live output-pass source, uniforms, channels, last compile error) is sent as a separate trailing message so it never invalidates the cache. For Anthropic this uses `cache_control` breakpoints. For hosted OpenAI we send a stable `prompt_cache_key` and the server caches the matching prefix automatically. For self-hosted OpenAI-compatible servers (llama.cpp, Ollama, LM Studio, ...) we send `cache_prompt: true` to opt into KV-cache prefix reuse.

These extra fields are sent only to non-hosted endpoints, since hosted OpenAI/Azure reject unknown body fields.

## Persistence & sharing

Projects, conversations, and media assets (images and videos) are stored in **IndexedDB**. Settings in `localStorage`. Videos are kept inline like images, so prefer short, low-resolution loops (uploads are capped at 32 MB). Webcam channels store only the *binding* — the camera is re-requested on load. The app requests persistent storage so the browser will not evict it. The top bar manages projects: create a **New** one, **Duplicate** the current one (a full independent copy of its passes, uniforms, and conversation — handy for forking an experiment), switch between them, or **Delete**.

Use **Export** / **Import** to move everything as a single JSON file (API keys excluded by default).

## Develop

Requires Node >=22.13 (pnpm 11's floor) and [pnpm](https://pnpm.io/) (a committed `pnpm-lock.yaml` pins the deps. Enable it with `corepack enable`).

```sh
pnpm install
just typecheck     # tsc --noEmit
just test          # node strip-types unit tests (test/)
just build         # -> dist/index.html (single file)
just check         # all three of the above
```

Open `dist/index.html` directly in a browser — it has no external dependencies.

### Project layout

```
index.html              # ts0 HTML entry (links CSS, loads main.ts)
src/
  main.ts               # bootstrap: renderer + store + UI
  gl/                   # WebGL2 renderer, shader assembly, procedural textures
  ai/                   # provider adapters (Anthropic + OpenAI wire), agent loop, tools
  state/                # types, central store, undo/redo history, IndexedDB persistence
  ui/                   # vanilla-DOM components: chat | (preview stacked over the
                        #   editor: Layers / Code / Passes graph / Uniforms / Textures / Assets;
                        #   ultrawide displays put preview & editor side-by-side -> 3 columns)
  util/                 # DOM helper, tiny markdown renderer, misc
  shaders/              # default.frag.glsl + internal fullscreen.vert / present.frag
                        #   (all embedded into the bundle)
  styles/app.css
test/                   # plain-Node unit tests (history, layers, cache, uniforms, set_uniforms,
                        #   assets, compact, providers, proxy, exr, markdown, graphlayout, tools)
```

No runtime framework — typed, vanilla DOM helpers, so the bundle stays small.

## Deploy

`.github/workflows/ci.yml` type-checks, tests, builds, and publishes the single file as a **public** per-branch site to [buildhost](https://github.com/wow-look-at-my/buildhost) using GitHub Actions OIDC (no static token). The live URL is `https://sites.pazer.build/ai-shadertoy/@<branch>/`.

It is actions and nothing else — `actions/checkout`, `wow-look-at-my/ts0` (one step that always type-checks, tests and builds — it takes no command input, so a workflow cannot pick a cheaper subset), and buildhost's `publish-site`. No node or pnpm setup is needed: `ts0.cjs` bundles its own TypeScript compiler. This project is browser-target with zero runtime dependencies, so it tests and builds from a bare checkout.
