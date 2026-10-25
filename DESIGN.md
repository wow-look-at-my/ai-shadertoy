# Tool-surface redesign

Collapse the bloated AI tool catalogue (~25 hyper-specific add/remove/edit-per-type tools + a stateful "active layer/pass" concept) into ~9 generic, parameterized tools. **An explicit ref in the tool call targets everything** — there is no "active" thing the model has to track or `select_*` first.

This is a **tool-layer** refactor only: the renderer and the store's core state model (layers[] / passes[] / shapes[], `selectedLayerId`/`selectedPassId`/`selectedShapeId` for the **human UI editor**) are unchanged. The store keeps its selection state for the editor panels. **tools never read selection** — they resolve targets from their params.

## Ref grammar

- **layer ref** = layer name | layer id | stack index (integer, 0 = bottom/back). A mask is addressed as the layer it masks (the `mask` type / `add_mask`-equivalent).
- **pass ref** = pass name | pass id, resolved **within a given layer**.
- **shape ref** = integer index within the layer (0-based, paint order).

New `ToolContext` resolvers (replacing the old active-scoped `resolveLayer()`/ `resolvePass()`/`passes()`/`outputPassId()`/`activeLayerId()`/`selectLayer()`):

- `resolveLayer(ref?: string | number): Layer | null` — name | id | stack index. No arg → the bottom-most... no: **no arg = the top layer** (the last in the stack, the visible composite) as a sensible default for tools that allow an omitted layer.
- `resolvePass(layer: Layer, ref?: string): Pass | null` — name | id within `layer`. No arg = that layer's output pass.
- `resolveShape(layer: Layer, index: number): Shape | null`.
- `defaultLayer(): Layer` — the top layer (used as the create/read default).

The store implements these by name/id/index lookup over `project.layers`, with no reference to `selectedLayerId`. Existing store mutation methods are unchanged and are called with the resolved explicit ids.

## Old → New mapping

| Old tool(s) | New tool | Notes |
|---|---|---|
| `get_shader` (pass src+channels+uniforms+graph+error) | **read** `{what:"pass", layer, pass}` | |
| `list_passes` | **read** `{what:"passes", layer}` | |
| `list_layers` | **read** `{what:"layers"}` | |
| `list_shapes` | **read** `{what:"shapes", layer}` | |
| `list_assets` | **read** `{what:"assets"}` | |
| (uniform list, previously only in get_shader/state) | **read** `{what:"uniforms"}` | |
| (active-layer graph summary in get_shader) | **read** `{what:"graph", layer}` | |
| `add_layer` | **create_object** `{type:"layer", name?, shape?, ...shapeFields}` | adds on top; pre-wired under+geometry over; returns ref. Does NOT become "active" (no such concept). |
| `add_pass` | **create_object** `{type:"pass", layer, name?, format?, source?}` | additive/safe; defaults to passthrough source. |
| `add_shape` | **create_object** `{type:"shape", layer, kind, ...shapeFields}` | |
| `add_mask` | **create_object** `{type:"mask", layer}` | seeds the soft-circle mask + Masked Composite pass. |
| `init_shader` | **create_object** `{type:"pass", layer, source, ...}` — but the **first-shader / output-pass authoring** case is `create_object {type:"pass", overwrite-output}`. See "init_shader collapse" below. | |
| `remove_layer` | **destroy_object** `{type:"layer", layer}` | can't remove only layer (guarded in store). |
| `remove_pass` | **destroy_object** `{type:"pass", layer, pass}` | can't remove only pass; clears channels referencing it (store). |
| `remove_shape` | **destroy_object** `{type:"shape", layer, shape}` (shape = index) | |
| `remove_mask` | **destroy_object** `{type:"mask", layer}` | |
| `set_layer` (name/visible/opacity) | **edit_object** `{type:"layer", ref, name?, visible?, opacity?}` | |
| `reorder_layer` | **edit_object** `{type:"layer", ref, order?|move?}` | move = up\|down\|top\|bottom. |
| `set_output_pass` | **edit_object** `{type:"layer", ref, output_pass}` | output_pass = pass name within the layer. |
| `edit_shape` | **edit_object** `{type:"shape", layer, index, ...shapeFields}` | index required. |
| `set_pass format` (was only via add_pass) | **edit_object** `{type:"pass", layer, ref, format}` | source edits stay in edit_shader. |
| `rename_shader` | **edit_object** `{type:"project", name}` | **keeps the permission gate** (only for type=project). |
| `select_layer` | **REMOVED** | direct ref everywhere. |
| `edit_shader` | **edit_shader** (kept) | + explicit `layer` ref alongside `pass`. |
| `connect_pins` | **connect_pins** (kept) | + explicit `layer` ref. |
| `set_uniforms` | **set_uniforms** (kept, unchanged) | shared, stateless PATCH. |
| `capture_screenshot` | **capture_screenshot** (kept, unchanged) | |
| `generate_texture` | **generate_texture** (kept) | + explicit `layer` ref for its optional bind; still gated on the stable `imageGen` session setting. |

Last advertised set (**9 tools**, byte-stable across a conversation except the single stable `generate_texture` gate): `read`, `create_object`, `destroy_object`, `edit_object`, `edit_shader`, `connect_pins`, `set_uniforms`, `capture_screenshot`, `generate_texture`.

## init_shader collapse (decision)

`init_shader` rewrote the layer's **output ("Image") pass** from scratch. It was gated to the first turn (`allowInitShader`) — exactly the per-turn availability gating the task says to remove. We fold it into `create_object {type:"pass"}`:

- `create_object {type:"pass", layer, source, ...}` with **no `name`** and the layer's output pass still holding the **untouched default source** → it **seeds the output pass** in place (the "first shader" case): `setPassSource(outputPassId, source)`. This preserves the original init behavior (author the visible pass) without a separate tool and without a per-turn gate.
- `create_object {type:"pass", layer, name, source?, format?}` with a `name` → adds a **new** pass (the old `add_pass`). Additive and always safe.
- **Overwrite safety:** seeding the output pass is refused (recoverable tool error pointing at `edit_shader`) once that pass was **authored** (its source differs from the default passthrough/composite template) — so `create_object` cannot silently wipe authored work. New named passes are unaffected (additive). This replaces the old `allowInitShader` turn-gating with an **execution-time** check, keeping the tool set byte-stable (matches the project's documented `init_shader`→exec-refusal pattern).

`authoredShader()` and `allowInitShader` are deleted from `chat.ts`/`ToolAvailability`. The store gains `passIsDefault(pass)` (source equals the seed template) to back the overwrite guard. `ToolContext` exposes it as `isOutputUnauthored(layer)`.

## buildProjectState ground truth (decision)

There is no "active layer" anymore. `buildProjectState` previously inlined the live GLSL of the active layer's passes. New behavior: it inlines the **live GLSL source of every layer's OUTPUT pass** (the composite each layer actually shows), labelled by layer, plus the existing per-layer graph/geometry summary. This keeps the model editing against ground truth for the most-relevant source (the visible composites) without a `read` round-trip. This also keeps stays compact (one pass per layer, not every pass), and — unchanged — rides as the trailing message OUT of the cached prefix. `PromptContext.activeLayerId` is dropped.

## Files

Added: `read.ts`, `create_object.ts`, `destroy_object.ts`, `edit_object.ts`. Kept: `edit_shader.ts`, `connect_pins.ts`, `set_uniforms.ts`, `capture_screenshot.ts`, `generate_texture.ts`, `geometry_util.ts` (shared shape parsing). Deleted: `init_shader.ts`, `get_shader.ts`, `add_pass.ts`, `remove_pass.ts`, `list_passes.ts`, `set_output_pass.ts`, `rename_shader.ts`, `add_layer.ts`, `remove_layer.ts`, `list_layers.ts`, `reorder_layer.ts`, `set_layer.ts`, `select_layer.ts`, `add_mask.ts`, `remove_mask.ts`, `list_shapes.ts`, `add_shape.ts`, `edit_shape.ts`, `remove_shape.ts`. Updated: `names.ts`, `index.ts`, `registry.ts` (drop ToolAvailability.allowInitShader), `types.ts` (ToolContext resolvers + drop allowInitShader), `system-prompt.ts`, `texttools.ts`, `agent.ts` (comment), `ui/chat.ts` (drop authoredShader/allowInitShader), `state/store.ts` (new resolvers, drop active-scoped ones), CLAUDE.md, README.md.

## Tests

- `test/tools.test.ts` (new): ref resolution (name/id/index), create/destroy/edit round-trips via a real `Store`-like ToolContext through `applyTool`, and tool-set byte-stability (the advertised `toolDefs` is same regardless of project state / imageGen-off, and same before vs after authoring a shader).
- `test/set_uniforms.test.ts`, `test/assets.test.ts`, `test/layers.test.ts`: unchanged (they exercise `set_uniforms`/`connect_pins`/`geometry_util`, all kept).
