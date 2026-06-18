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

## Architecture

- `src/gl/` — `Renderer` (WebGL2, animation clock, uniforms, screenshot with
  average-colour feedback), `wrapper.ts` (assembles the full GLSL ES 3.00 source
  around the user's `mainImage`; emits `#line 1` so compile errors map to user
  line numbers), `textures.ts` (procedural built-ins).
- `src/ai/` — `providers.ts` translates the neutral conversation model to/from
  **Anthropic Messages** and **OpenAI Chat Completions** (both streamed, vision +
  tool use). `agent.ts` runs the tool loop. `tools.ts` are the tool schemas.
  `system-prompt.ts` builds the system prompt from live project state.
- `src/state/` — `types.ts` (provider-neutral content-block conversation model),
  `store.ts` (single owner of state + persistence + `applyTool`), `persist.ts`
  (IndexedDB for projects/assets, localStorage for settings, export/import).
- `src/ui/` — vanilla-DOM components via the `el()` helper in `src/util/dom.ts`.
- `src/shaders/*.glsl` — kept as real `.glsl` files (per the file-type rule),
  embedded into the single-file bundle by ts0's fetch interceptor and loaded at
  runtime via `fetch(new URL(...))`.

## Provider gotchas (verified against the claude-api skill)

- Default chat model is `claude-opus-4-8`.
- `temperature`/`top_p`/`top_k` are **rejected (400)** by Opus 4.8/4.7 and the
  Fable family — `providers.ts` omits `temperature` for those models
  (`anthropicAcceptsTemperature`).
- Anthropic browser calls require `anthropic-dangerous-direct-browser-access: true`.
- Thinking is left off (no `thinking` param) so the simple browser tool-loop
  doesn't have to replay thinking blocks. Fable 5 (always-on thinking) is
  deliberately not a preset.
- Anthropic SSE events handled: `content_block_start/delta/stop`, `message_delta`,
  `error`. OpenAI: `choices[].delta.content` / `.tool_calls[]`, `finish_reason`.

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
