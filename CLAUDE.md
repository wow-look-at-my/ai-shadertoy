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

- `src/gl/` — `Renderer` (WebGL2, animation clock, uniforms, screenshot with
  average-colour feedback), `wrapper.ts` (assembles the full GLSL ES 3.00 source
  around the user's `mainImage`; emits `#line 1` so compile errors map to user
  line numbers), `textures.ts` (procedural built-ins).
- `src/ai/` — `providers.ts` translates the neutral conversation model to/from
  **Anthropic Messages** and **OpenAI Chat Completions** (both streamed, vision +
  tool use; `testConnection` + `listModels` power the Settings test button and
  model combobox). `agent.ts` runs the tool loop. `system-prompt.ts` builds the
  base prompt (it does NOT list tool schemas — those go in the request's `tools`
  field for native models) plus `textToolInstructions` for text mode.
- `src/ai/tools/` — **one tool per file**, each colocating its JSON-schema `def`
  and `execute`, self-registering into `registry.ts`. The store builds a
  `ToolContext` (the only surface a tool may touch) and dispatches via `getTool`.
  `toolDefs({ imageGen, allowInitShader })` gates the offered set. Tools:
  `init_shader` (first turn / full rewrite only), `edit_shader` (forgiving
  exact-snippet replace — the primary edit path), `get_shader`, `set_uniforms`,
  `rename_shader` (permission-gated), `set_channel`, `set_channel_asset`,
  `list_assets`, `capture_screenshot`, `generate_texture` (gated on image-gen).
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
- `src/state/` — `types.ts` (provider-neutral content-block conversation model),
  `store.ts` (single owner of state + persistence + `applyTool`), `persist.ts`
  (IndexedDB for projects/assets, localStorage for settings, export/import).
- `src/ui/` — vanilla-DOM components via the `el()` helper in `src/util/dom.ts`.
  UI glyphs come from `src/util/icons.ts` — `icon(name)` builds an inline
  `<svg>` (Material Design Icons path data, `fill: currentColor`); no emoji, no
  icon font, no network request. Add a new glyph by inlining its `@mdi/js` path.
- `src/shaders/*.glsl` — kept as real `.glsl` files (per the file-type rule),
  embedded into the single-file bundle by ts0's fetch interceptor and loaded at
  runtime via `fetch(new URL(...))`.

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
- Anthropic SSE events handled: `content_block_start/delta/stop` (text, thinking,
  signature, tool input deltas), `message_delta`, `error`. OpenAI:
  `choices[].delta.content` / `.tool_calls[]`, `finish_reason`.

## Conventions

- Indentation: tabs (`.editorconfig`).
- Keep dependencies at zero for runtime; `typescript` + `ts0` are the only devDeps.
- When changing structure/commands/config, update `README.md` and this file.

## CI / deploy

`.github/workflows/ci.yml`: build (npm ci, tsc, ts0 build, size gate) then deploy
— publishes the single file as a **public** per-branch buildhost site via GHA
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
