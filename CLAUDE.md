# CLAUDE.md

Notes for Claude working in this repository.

## What this is

A client-side, single-page web app: an AI sandbox for building WebGL2 fragment
shaders. No backend. TypeScript, no runtime framework. Builds to one
self-contained `index.html` via `ts0`. See `README.md` for user-facing docs.

## Build / check

```sh
npm install
npm run typecheck     # tsc --noEmit (HTML entries are NOT type-checked by ts0, so run this)
npm run build         # ts0 build -> dist/index.html
```

- This is a **Node/TypeScript** project. Do NOT apply `go-toolchain` here.
- ESM only; use `.ts` extensions in relative imports (required by ts0/esbuild).
- The bundle must stay **< 1 MB** (CI enforces it) and have **no external
  requests** — it ships as a single file.

### `ts0.json` vs `tsconfig.json` (they are not redundant)

- `ts0.json` configures the **bundler** (entry, outdir, target, format). ts0 is
  the only thing that reads it.
- `tsconfig.json` configures the **type-checker**. ts0's HTML-entry build path
  does NOT run `tsc` (it bundles with esbuild, which strips types without
  checking), so `npm run typecheck` (which CI runs) is our only type safety, and
  it — plus the editor/IDE — needs `tsconfig.json`. Don't delete it.
- Keep the code `node --experimental-strip-types`-clean (no TS parameter
  properties etc.) so the modules can be exercised by plain Node test scripts.

## Architecture

- `src/gl/` — `Renderer` is a **multi-pass** WebGL2 renderer. Each pass renders to
  its own offscreen, ping-ponged (double-buffered) texture; passes are run in
  topological order (`topoOrder`) of their channel→pass dependencies, a channel
  pointing at its own pass reads the previous frame (feedback), and the chosen
  output pass is blitted to the screen by an internal present shader. Targets are
  `rgba8` or `rgba16f` (HDR, when `EXT_color_buffer_float`/`OES_texture_float_linear`
  allow, else it falls back). `setPasses()` (re)compiles + reconciles per-pass
  slots and returns a per-pass `CompileResult`; `setPassChannel*`/`clearPassChannel`
  bind inputs; `maxInputs()` exposes the GPU texture-unit ceiling. It also owns the
  clock, uniforms, and screenshot (average-colour feedback). `wrapper.ts` assembles
  the full GLSL ES 3.00 source around the user's `mainImage` for a pass, declaring
  exactly that pass's `iChannel0..N-1` + `iChannelResolution[N]` (channel count is a
  parameter — inputs are not capped at four) and emitting `#line 1` so compile
  errors map to user line numbers. `textures.ts` (procedural built-ins).
- `src/ai/` — `providers.ts` translates the neutral conversation model to/from
  **Anthropic Messages** and **OpenAI Chat Completions** (both streamed, vision +
  tool use; `testConnection` + `listModels` power the Settings test button and
  model combobox). It sets prompt-cache breakpoints and returns per-response token
  `Usage` + generation time. `agent.ts` runs the tool loop (and forwards `Usage`
  via the `onUsage` callback). `system-prompt.ts` exposes `buildSystemPrompt()`
  (the stable, cacheable base — it does NOT list tool schemas, those go in the
  request's `tools` field for native models) and `buildProjectState()` (the
  volatile per-edit project state, kept OUT of the cached prefix and sent as a
  trailing message) plus `textToolInstructions` for text mode. `pricing.ts` maps a
  model id to its rates + context window for the chat cost / context indicator.
- `src/ai/tools/` — **one tool per file**, each colocating its JSON-schema `def`
  and `execute`, self-registering into `registry.ts`. The store builds a
  `ToolContext` (the only surface a tool may touch) and dispatches via `getTool`.
  `toolDefs({ imageGen, allowInitShader })` gates the offered set. Tools are
  **pass-aware**: `init_shader` (first turn / full rewrite of the output pass),
  `edit_shader` (forgiving exact-snippet replace — the primary edit path; takes an
  optional `pass`), `add_pass` / `remove_pass` / `list_passes` / `set_output_pass`
  (manage the render graph), `get_shader` (pass + graph summary), `set_uniforms`
  (shared across passes), `rename_shader` (permission-gated), `set_channel`
  (`kind: none|builtin|pass`; `pass` feeds another pass's output — the graph edges;
  any index auto-grows the input list), `set_channel_asset`, `list_assets`,
  `capture_screenshot`, `generate_texture` (gated on image-gen). Most edit tools
  default to the output pass and resolve a `pass` arg via `ctx.resolvePass`.
- **Permission-gated tools**: a tool can set `requiresPermission: true` (+ an
  optional `permissionPrompt(input)` for the prompt text) in its registration.
  Before running such a call the agent loop awaits `cb.requestPermission(...)`;
  the chat UI renders an Approve/Deny card (Stop counts as deny) and a denial is
  fed back to the model as a tool result instead of executing. `rename_shader` is
  the first user of this; it renames via `ctx.renameProject`. Works in both tool
  modes (the gate lives in the shared execute loop).
- **Tool modes** (`chat.toolMode`): `native` uses the provider's function-calling
  API; `text` (for models/endpoints without it) describes the catalogue as
  forgiving XML tags (`textToolInstructions`, keyed by `TOOL_NAMES`), parses them
  out of the reply (`texttools.ts`), and feeds results back as a plain user
  message. `init_shader` is recomputed each iteration so it drops out once the
  shader is authored.
- `src/state/` — `types.ts`: a `Project` is a **render graph** — `passes: Pass[]`
  (each a `Pass` with `source`, a variable-length `channels: Channel[]` input list
  up to `MAX_INPUTS`, `format`, and graph-editor `x`/`y`) plus an `outputPassId`; a
  `Channel` adds `kind:"pass"` (+`passId`) for pass→pass wiring. `store.ts` (single
  owner of state + the renderer + persistence + `applyTool` + undo/redo) tracks
  `selectedPassId` and exposes pass-graph mutations (`addPass`/`removePass`/
  `setOutputPass`/`setPassSource`/`setPassChannel`/`add`+`removePassChannel`/
  `movePass`), plus `commitMessages()` which persists in-place edits/deletes the
  chat UI makes to `project.messages`; `defaults.ts` has `normalizeProject` which
  migrates legacy single-`shaderSource` projects to one "Image" pass on
  load/import. `persist.ts` (IndexedDB for projects/assets, localStorage for
  settings, export/import; normalizes on read). `history.ts` (generic, DOM-free
  snapshot undo/redo stack).
- **Undo/redo**: `history.ts` is a generic `History<S>` (two stacks of
  `{snapshot,label}`, coalescing by tag + time window, reference-counted grouping,
  a size cap, an `onChange` callback). The store owns a `History<ProjectSnapshot>`
  over the undoable project slice (`name`, `passes`, `outputPassId`, `uniforms` —
  NOT messages/ids). Each mutating store method calls `this.commit(label, tag,
  coalesce?)` after mutating; `applySnapshot` restores + re-renders (it emits a
  `"restore"` event so the code editor refreshes even while focused). Typing and
  slider drags coalesce; an **agent turn is one undo step** via
  `beginHistoryGroup`/`endHistoryGroup` (the chat wraps `runAgent`). History
  resets on project switch (`adoptProject`) and is gated off while `busy`. The
  store emits `"history"`; the topbar renders Undo/Redo buttons and `app.ts` binds
  Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z / Ctrl+Y (deferring to native undo inside text
  fields). Unit-tested in `test/history.test.ts` (`npm run test`, run by CI).
- `src/ui/` — vanilla-DOM components via the `el()` helper in `src/util/dom.ts`.
  Layout is **chat | (preview stacked OVER the editor)** with a draggable vertical
  splitter (`app.ts`), so code gets the full column width. The editor (`rightpanel.ts`)
  has four tabs: **Code** (edits the selected pass), **Passes** (the object graph —
  draggable pass nodes wired by their inputs, add/remove passes + inputs, pick the
  output), **Uniforms** (shared), **Textures** (the selected pass's inputs, with an
  add/remove control — not fixed at four). UI glyphs come from `src/util/icons.ts` —
  `icon(name)` builds an inline `<svg>` (Material Design Icons path data,
  `fill: currentColor`); no emoji, no icon font, no network request. Add a new glyph
  by inlining its `@mdi/js` path. The chat (`chat.ts`) shows hover **edit/delete**
  actions on user prompts and assistant replies: delete removes a whole conversation
  round, edit rewrites a user prompt then re-runs from there (forking the
  conversation). The round math that keeps every `tool_use` paired with its
  `tool_result` (an orphan 400s the next request) is pure and DOM-free in
  `src/util/conversation.ts` (`isDeletable` / `deletionRange`) — tested by
  `node --experimental-strip-types`.
- `src/shaders/*.glsl` — real `.glsl` files (per the file-type rule): the editable
  `default.frag.glsl` plus the renderer's internal `fullscreen.vert.glsl` (full-screen
  triangle, shared by every pass) and `present.frag.glsl` (output blit). All embedded
  into the single-file bundle by ts0's fetch interceptor and loaded at runtime via
  `fetch(new URL(...))` (the plumbing pair is passed into the `Renderer` constructor).

## Provider gotchas (verified against the claude-api skill)

- Default chat model is `claude-opus-4-8`.
- `temperature`/`top_p`/`top_k` are **rejected (400)** by Opus 4.8/4.7 and the
  Fable family — `providers.ts` omits `temperature` for those models
  (`anthropicAcceptsTemperature`).
- Anthropic browser calls require `anthropic-dangerous-direct-browser-access: true`.
- Extended thinking is **on** for Anthropic, model-gated in `providers.ts`
  (`anthropicThinking`): `{type:"adaptive", display:"summarized"}` for 4.6+ Opus /
  Sonnet 4.6 / Fable / Mythos, a token `budget` for 4.5-era models, and nothing for
  unrecognised models (so we never send a config that 400s). Thinking and
  `temperature` are mutually exclusive in the request. Thinking blocks are captured
  off the stream (`thinking_delta` + `signature_delta`), stored on the assistant
  `Message` as `ThinkingBlock`s, and replayed **first** in `anthropicContent` —
  required, or tool-use continuations 400. The chat UI streams the summary into a
  collapsible `.thinking` block.
- `output_config.effort` is set to `medium` (`anthropicEffort`, same model gate as
  thinking — it 400s on Sonnet 4.5 / Haiku 4.5 and older; the server default is
  `high`).
- Anthropic SSE events handled: `message_start` (usage), `content_block_start/delta/stop`
  (text, thinking, signature, tool input deltas), `message_delta` (stop_reason +
  output tokens), `error`. OpenAI: `choices[].delta.content` / `.tool_calls[]`,
  `finish_reason`, and the final `usage` chunk (we send `stream_options.include_usage`).
- **Prompt caching**: Anthropic requests carry `cache_control: {type:"ephemeral"}`
  on the `system` block (covers tools + system, both stable) and on the last
  conversation block (caches the growing history). The per-request **project state
  must stay out of that cached prefix** — it rides as a trailing user message
  (`buildProjectState`) so editing the shader doesn't invalidate the cache every
  turn. OpenAI caches automatically server-side; the same trailing-state layout
  keeps its prefix stable. 2 breakpoints/request (max is 4); ephemeral 5-min TTL.
- The chat panel shows a usage indicator (tokens/sec, context %, cost this turn +
  session). `Usage` is captured per response; cost/context come from `pricing.ts`
  (tokens-only when the model's pricing is unknown).

## Conventions

- Indentation: tabs (`.editorconfig`).
- Keep dependencies at zero for runtime; `typescript` + `ts0` are the only devDeps.
- When changing structure/commands/config, update `README.md` and this file.

## CI / deploy

`.github/workflows/ci.yml`: build (npm ci, tsc, `npm test`, ts0 build, size gate)
then deploy — publishes the single file as a **public** per-branch buildhost site via GHA
OIDC (`X-Public-Site: true`) to `sites.pazer.build/ai-shadertoy/branch/<branch>/`.
Models the buildhost repo's `buildhost-publish-site` action, inlined through
`wow-look-at-my/actions@typescript#latest`.

`.github/workflows/preview.yml`: per-PR previews. On `pull_request`
(opened/reopened/synchronize) it builds the bundle, uploads it as the `site`
artifact, and calls the `wow-look-at-my/actions/.github/workflows/buildhost-preview.yml@master`
reusable workflow with `artifact-name: site` + `public: true`. That deploys to
`sites.pazer.build/ai-shadertoy/branch/pr-<number>/` and posts a sticky PR
comment. Push-based per-branch deploys stay in `ci.yml` (CI workflows are
`on: push:` only); the PR flavour is a separate file because the trigger
differs. No `closed`-event cleanup — the reusable workflow only deploys.
