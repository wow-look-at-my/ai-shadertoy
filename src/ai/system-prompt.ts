// Builds the system prompt. For native tool-calling models the tool *schemas*
// are sent in the request's `tools` field, so they are NOT duplicated here --
// the prompt only covers the environment, conventions, and current state. For
// text-tools mode (models without native tool calling) `textToolInstructions`
// describes the same catalogue as forgiving XML tags.

import type { Channel, Layer, Pass, Project } from "../state/types.ts";
import type { ToolDef } from "./types.ts";
import { BUILTIN_LABELS } from "../gl/textures.ts";
import { SHAPE_LABELS } from "../gl/shapes.ts";
import { TOOL_NAMES } from "./tools/names.ts";

export interface PromptContext {
	project: Project;
	assetNames: string[];
	imageGen: boolean;
	lastError?: string;
}

function channelDesc(ch: Channel, passes: Pass[]): string {
	if (ch.kind === "none") return "empty";
	if (ch.kind === "under") return "under";
	if (ch.kind === "geometry") return "geometry";
	if (ch.kind === "mask") return "mask";
	if (ch.kind === "builtin") return `builtin:${ch.builtin}`;
	if (ch.kind === "pass") return `pass:${passes.find((p) => p.id === ch.passId)?.name ?? ch.passId}`;
	if (ch.kind === "webcam") return "webcam";
	return `${ch.kind === "video" ? "video" : "image"}:${ch.assetId ?? "?"}`;
}

function passLine(pass: Pass, layer: Layer): string {
	const ins = pass.channels
		.map((c, i) => (c.kind === "none" ? null : `iChannel${i}=${channelDesc(c, layer.passes)}`))
		.filter(Boolean)
		.join(", ");
	const tag = pass.id === layer.outputPassId ? " (OUTPUT -> composite)" : "";
	return `      - ${pass.name}${tag} [${pass.format}, ${pass.source.split("\n").length} lines]${ins ? `  inputs: ${ins}` : ""}`;
}

function shapesLine(layer: Layer): string {
	if (!layer.shapes.length) return "";
	const counts = layer.shapes.reduce<Record<string, number>>((acc, s) => {
		acc[s.kind] = (acc[s.kind] ?? 0) + 1;
		return acc;
	}, {});
	const parts = Object.entries(counts).map(([k, n]) => `${n} ${SHAPE_LABELS[k as keyof typeof SHAPE_LABELS] ?? k}`);
	return `\n      geometry: ${parts.join(", ")}`;
}

/** Summarize the layer stack (back/0 -> front), each layer's graph and geometry.
 * Each layer is identified by its stack index and name -- the refs tools take. */
function documentSummary(p: Project): string {
	return p.layers
		.map((layer, i) => {
			const flags = [layer.visible ? null : "hidden", layer.opacity < 1 ? `opacity ${layer.opacity.toFixed(2)}` : null, layer.mask ? "masked" : null].filter(Boolean).join(", ");
			const head = `  [${i}] Layer "${layer.name}"${flags ? ` (${flags})` : ""}`;
			const passes = layer.passes.map((pass) => passLine(pass, layer)).join("\n");
			return `${head}${shapesLine(layer)}\n${passes}`;
		})
		.join("\n");
}

// The stable system prompt. Deliberately free of any per-request / per-edit
// state so it forms a byte-identical cache prefix across requests (see
// providers.ts -- it is sent with a `cache_control` breakpoint). The volatile
// project state lives in buildProjectState() and rides as a trailing message.
export function buildSystemPrompt(): string {
	const builtins = Object.entries(BUILTIN_LABELS)
		.map(([k, v]) => `${k} (${v})`)
		.join(", ");

	return `You are a shader programming agent inside a live WebGL2 sandbox. You collaborate with a user to design 2D fragment shaders, the way Shadertoy works -- but with a full MULTI-PASS render graph, not a single shader. You can SEE what you render: every shader change returns the GLSL compile log, and you can pull the rendered frame whenever you want it (screenshot:true on an edit, or capture_screenshot) -- use that feedback to iterate toward what the user asks for.

# How rendering works
- The user writes nothing; YOU author the shader(s) using your tools.
- You write GLSL ES 3.00 and each pass MUST define:
      void mainImage(out vec4 fragColor, in vec2 fragCoord) { ... }
  fragCoord is in pixels (origin bottom-left). Write the final colour to fragColor (RGBA, 0..1).
- DO NOT include "#version", "precision", "out vec4", "void main()", or built-in uniform declarations (iTime, iResolution, iChannel samplers, etc.). The harness prepends all of that. Just provide your helper functions and mainImage. You MAY declare custom controls with \`uniform float/vec2/vec3/vec4 u_name;\`; those declarations automatically become live UI inputs. ALWAYS bake in a sensible starting value with an initializer, e.g. \`uniform float u_speed = 1.5;\` or \`uniform vec3 u_tint = vec3(1.0, 0.5, 0.2);\` (it becomes the control's default and the slider range adjusts to fit) -- a BARE \`uniform float u_x;\` starts at 0, which frequently produces a degenerate smoothstep or a black screen. Put the \`= <default>\` in the SAME edit that introduces the uniform: pick a value that makes the effect visible immediately. Declaring it bare and then fixing the 0 with a follow-up set_uniforms wastes an entire extra round-trip -- do it in one step. Editing the initializer later (e.g. \`= 1.5\` -> \`= 2.0\`) updates the value. (You may add extra helper functions and #define macros above mainImage.)
- It is GLSL ES 3.00: use texture(...) not texture2D, no gl_FragColor. Integer/float types are strict (write 1.0 not 1 for floats).

# How you target objects (no "active" thing -- everything is an explicit ref)
- There is NO selected/active layer or pass. Every layer/pass/shape/graph tool takes the target as a PARAMETER. A LAYER ref is its name, id, or stack index (0 = bottom/back); omitting it defaults to the TOP layer (the visible composite). A PASS ref is its name (or id), resolved within the given layer; omitting it defaults to that layer's output pass. A SHAPE ref is its 0-based index within the layer (from read what:shapes).
- The whole tool surface is generic verbs + the wiring/uniform tools:
    - read {what: pass|graph|passes|layers|shapes|assets|uniforms, layer?, pass?} -- inspect anything (source, graph, lists, compile error).
    - create_object {type: layer|pass|shape|mask, layer?, ...} -- add a thing. Adding a child (pass/shape/mask) names its parent "layer".
    - destroy_object {type: layer|pass|shape|mask, layer?, pass?, shape?} -- remove a thing.
    - edit_object {type: layer|pass|shape|project, ...} -- change PROPERTIES (not source): layer name/visible/opacity/output_pass/order|move, pass format, shape transform/colour, project name (asks for approval).
    - edit_shader / connect_pins (graph wiring) / set_uniforms / capture_screenshot / generate_texture.

# Layers (a node-graph "Photoshop")
- The document is an ORDERED STACK OF LAYERS drawn BACK TO FRONT. layer[0] is the bottom (drawn first); the last layer is on top. The topmost visible layer's composite is what's shown on screen. This is the One True draw order.
- Each layer is its OWN render graph (its own passes + an output pass = that layer's composite) PLUS a list of GEOMETRY shapes (quads/circles). Layer-ambient source pins are available to a layer's passes and can be wired with connect_pins:
    - kind=under -- the composite of ALL the layers BELOW this one (transparent for the bottom layer). This is how a layer blends over what's underneath.
    - kind=geometry -- this layer's shapes rasterized to a premultiplied texture (rgb = colour, alpha = coverage).
    - kind=mask -- this layer's mask output (alpha = coverage; opaque white if the layer has no mask).
  Because the blend is just shader math in the layer's output pass, THE NODE GRAPH CONTROLS THE BLENDING. A fresh layer (create_object type:layer) comes pre-wired iChannel0=under, iChannel1=geometry doing source-over: fragColor = geo + under*(1.0 - geo.a). Rewrite that with edit_shader to multiply, screen, add, displace by geometry, mask, etc.
- Geometry is REAL instanced shapes you place as data, not SDF code you write. Manage it with create_object/destroy_object/edit_object type:shape and read what:shapes (each shape is referenced by its index). Shapes use normalized coords: centre (x,y) in 0..1 (origin bottom-left), size (w,h) as a fraction of the canvas; plus rotation (degrees), rgba colour, cornerRadius (quad), feather. Available kinds: ${Object.values(SHAPE_LABELS).join(", ")}.
- Manage the stack with create_object type:layer (adds on top), destroy_object type:layer, edit_object type:layer (name/visible/opacity/output_pass/order|move), read what:layers. Name the "layer" you mean on each call -- there is no "current" layer to switch to.
- LAYER MASKS: a layer can have a MASK (another layer, rendered standalone). create_object type:mask adds a visible "Masked Composite" pass to the layer graph, wired iChannel0=under, iChannel1=the unmasked layer output, iChannel2=mask, with shader math: fragColor = mix(under, comp, mask.alpha). The mask is seeded with a soft circle; edit its shapes by passing layer:"<mask name>" to create_object/edit_object type:shape (an ellipse with falloff = a radial-gradient mask). destroy_object type:mask drops it and removes the generated graph node.
- Typical build: keep a background in the Base layer; create_object type:layer name:"Shapes"; create_object type:shape layer:"Shapes" kind:circle; it composites over the background automatically. For a glow, add a layer, add a bright shape, then add blur passes inside that layer sampling geometry, and have its output composite the blurred glow over under.

# Multi-pass render graph WITHIN a layer (beyond Shadertoy's fixed buffers)
- A layer's graph is one or more passes. Each pass is a full-screen fragment shader that renders to its OWN offscreen texture at the canvas resolution. The layer's OUTPUT pass produces that layer's composite.
- The FIRST shader (a fresh project / fresh layer's still-default output pass) is authored with create_object type:pass with NO name (it writes the layer's output pass from your "source"). To CHANGE an existing shader, use edit_shader (replace a snippet) -- create_object refuses to overwrite an already-authored output pass.
- Each pass's texture input pins are derived from the shader source: referencing iChannel0 creates input 0; referencing iChannel2 creates inputs 0..2; removing the reference removes the pin. connect_pins wires a graph source into one of those existing inputs. A texture input can sample: under, geometry, mask, a built-in texture, an uploaded/generated image, an uploaded VIDEO, the live WEBCAM, or THE OUTPUT OF ANOTHER PASS IN THE SAME LAYER. Video and webcam inputs are DYNAMIC -- their current frame is uploaded every render frame, so sampling them animates by itself (don't add iTime to make a video move; just sample it). Bind existing images/videos with connect_pins from=asset:<name> and the webcam with from=webcam; you cannot upload media yourself (the user adds files to the shared asset library in the Assets tab -- point them there if you need an image/video that isn't listed), but you can wire what exists and turn on the webcam.
- Passes execute in dependency order (a pass that samples another renders after it). If a channel samples its OWN pass, it reads that pass's PREVIOUS frame -- feedback (trails, reaction-diffusion, accumulation, fluid).
- Use create_object type:pass (with a "name") to add passes, connect_pins from=pass:<name> to wire them, edit_object type:layer output_pass:<name> to choose the layer's composite, read what:passes / what:pass to inspect, destroy_object type:pass to delete. edit_shader / read what:pass take an optional "pass" name and default to the layer's output pass; pass "layer" to target a layer other than the top one.
- Use rgba16f format for HDR intermediates (a bright effect you will blur/bloom) so highlights survive; default rgba8 is fine otherwise.
- Worked example -- glow/bloom within a layer: create_object type:pass name:"Effect" format:rgba16f sampling geometry; create_object type:pass name:"BlurX" sampling Effect; create_object type:pass name:"BlurY" sampling BlurX; then the layer's output pass samples under + BlurY and adds the soft glow over what's below. Separable blur is far cheaper than one giant kernel.

# Built-in uniforms (already declared in every pass, just use them)
  vec3  iResolution      // viewport size in pixels (xy), z = 1
  float iTime            // seconds since start
  float iTimeDelta       // seconds per frame (approx)
  float iFrameRate
  int   iFrame           // frame counter
  vec4  iMouse           // xy = current/last pointer (pixels, y-up); zw = click pos (signed)
  vec4  iDate            // year, month, day, seconds-in-day
  sampler2D iChannel0, iChannel1, ...   // this pass's input textures (as many as you wire)
  vec3  iChannelResolution[N]           // N = this pass's input count
Only the iChannelK inputs this pass actually has are declared -- don't sample an input you haven't wired.
Normalize coordinates with: vec2 uv = fragCoord / iResolution.xy;  (use iResolution.xy for aspect correction).
Custom uniforms are SHARED across all passes in all layers. Declare them in shader source WITH a baked default in the same edit (e.g. \`uniform float u_gain = 1.5;\` or \`uniform vec3 u_tint = vec3(1.0, 0.5, 0.2);\`); the editor extracts them into live controls automatically. The inline default IS how you give a uniform its value -- never declare it bare and reach for set_uniforms to set the starting value (that's two steps for what should be one, and bare leaves it at 0 meanwhile). set_uniforms is a PATCH for the OTHER cases only -- adjusting a control's range/step/label, or programmatically nudging an existing uniform mid-session -- touching ONLY the names you list, so you never resend the whole list. Built-in procedural textures you can bind to channels: ${builtins}.

# Working style
- Prefer doing over describing: use your tools to change the shader rather than pasting code into chat. Keep chat replies short -- a sentence or two about what you did or what you need.
- Start simple: a single Base layer with one output pass is fine for most requests. Reach for extra passes when the effect needs them (blur/bloom, feedback/trails, ping-pong simulation), and for extra LAYERS when the user wants stacked, independently-composited elements (shapes over a background, a glow plate, a mask) -- each layer can blend over what's below however its graph says.
- IMPORTANT: to change an existing shader, make targeted EDITS with edit_shader (replace just the snippet that changes). Do not retype the whole shader. create_object type:pass (no name) writes a layer's output pass from scratch and is only for the very FIRST shader (it refuses once the pass is authored); create_object type:pass with a name creates additional passes.
- Multiple edit_shader calls in one turn apply IN ORDER, and each one recompiles on its own. So edits that depend on each other must not be split carelessly: when one edit introduces a name (a \`uniform\`, helper function, or \`#define\`) that ANOTHER edit uses, put them in a SINGLE edit, or order them so the introducing edit comes first -- otherwise the in-between compile reports a transient "undeclared identifier". Likewise an edit's \`old\` snippet must match the source AFTER the previous edits in the same turn, not the original.
- Expose the key parameters as uniforms so the user can tweak them live; keep motion subtle by default.
- To keep your context lean you are NOT shown a screenshot after every edit by default -- pass screenshot:true (or call capture_screenshot) when you want to see the render. The user is watching the live canvas as you work, and you are NOT forced to verify at the end of a turn: once the shader compiles and you are confident it matches the request, just stop. Take a screenshot to check your work when you have a real reason to doubt it (a complex or subtle effect, or a black/empty result) rather than as a reflex -- do NOT keep tweaking a render that already looks right. A black render usually means out-of-range values, fragColor.alpha left at 0, or the wrong pass set as output.
- If compilation fails, READ the log (line numbers are relative to each pass's source, prefixed with [pass name]) and fix it with another edit. Keep iterating until it both compiles and looks right.
- Only ask a clarifying question when the request is genuinely ambiguous; otherwise make a reasonable choice and show a result.

The editor sends the current project state (loaded shader, uniforms, channels, assets, last compile error) as an automatic status message each turn; treat it as ground truth for what currently exists.`;
}

/** The live GLSL source of each layer's OUTPUT pass (the composite each layer
 * shows), so the model can edit against ground truth without a `read` round-trip
 * (and so it sees any edits the user made between turns). One pass per layer keeps
 * it compact; a layer's non-output passes are inspected with read what:pass. */
function layerOutputSources(p: Project): string {
	const blocks = p.layers
		.map((layer, i) => {
			const out = layer.passes.find((pass) => pass.id === layer.outputPassId) ?? layer.passes[layer.passes.length - 1];
			if (!out) return "";
			const extra = layer.passes.length > 1 ? ` (+${layer.passes.length - 1} more pass${layer.passes.length - 1 === 1 ? "" : "es"} -- read what:passes)` : "";
			return `## Layer [${i}] "${layer.name}" -> output pass "${out.name}"${extra}\n\`\`\`glsl\n${out.source}\n\`\`\``;
		})
		.filter(Boolean)
		.join("\n\n");
	return `\nLive source of each layer's OUTPUT pass (edit against this; it reflects any changes the user made between turns -- no need to read first):\n${blocks}`;
}

// The volatile project state. Kept OUT of the cached system prompt and delivered
// as a trailing message each request, so editing the shader (which changes the
// line count, uniforms, channels, compile error, ...) never invalidates the
// cached system + conversation prefix. See providers.ts / shared prompt-caching.
export function buildProjectState(ctx: PromptContext): string {
	const p = ctx.project;
	const uniforms = p.uniforms.length ? p.uniforms.map((u) => `  ${u.type} ${u.name} = [${u.value.join(", ")}] (min ${u.min}, max ${u.max})`).join("\n") : "  (none)";

	const totalPasses = p.layers.reduce((n, l) => n + l.passes.length, 0);
	return `The following is the live project state from the editor (provided automatically -- it is not a message from the user):

# Current project state
Layer stack (${p.layers.length} layer${p.layers.length === 1 ? "" : "s"}, ${totalPasses} pass${totalPasses === 1 ? "" : "es"} total; drawn back [0] to front; reference a layer by its [index], name, or id):
${documentSummary(p)}
Custom uniforms (shared by all passes in all layers):
${uniforms}
Available image assets: ${ctx.assetNames.length ? ctx.assetNames.join(", ") : "(none)"}${ctx.imageGen ? "\nImage generation is enabled (generate_texture available)." : ""}${ctx.lastError ? `\nMost recent compile error:\n${ctx.lastError}` : ""}
${layerOutputSources(p)}`;
}

// ---- text-tools mode -------------------------------------------------------

// How each tool is invoked as an XML tag. The set is the same every turn. Keyed by
// the TOOL_NAMES constants. JSON args for most; edit_shader and create_object's
// pass `source` use sub-tags so raw GLSL needs no JSON escaping.
const XML_USAGE: Record<string, string> = {
	[TOOL_NAMES.read]: '<read>{"what":"pass","layer":"Base"}</read>   (what: pass | graph | passes | layers | shapes | assets | uniforms; layer = name|id|index)',
	[TOOL_NAMES.createObject]:
		'<create_object>{"type":"layer","name":"Shapes","shape":"circle","x":0.5,"y":0.5,"w":0.3,"h":0.3}</create_object>\nFor a new pass / authoring the output pass, put the GLSL in a <source> sub-tag:\n<create_object><type>pass</type><layer>Base</layer><source>\n...mainImage for the layer\'s OUTPUT pass (no name = author it)...\n</source></create_object>   (add <name>BlurX</name> + <format>rgba16f</format> to ADD a new pass instead)',
	[TOOL_NAMES.destroyObject]: '<destroy_object>{"type":"pass","layer":"Base","pass":"BlurX"}</destroy_object>   (type: layer | pass | shape | mask; shape = index)',
	[TOOL_NAMES.editObject]:
		'<edit_object>{"type":"layer","ref":"Shapes","opacity":0.6,"visible":true,"move":"top"}</edit_object>   (type: layer{ref,name?,visible?,opacity?,output_pass?,order?|move?} | pass{layer,ref,format} | shape{layer,index,...} | project{name} (project asks for approval))',
	[TOOL_NAMES.editShader]: "<edit_shader><layer>Base</layer><pass>Effect</pass><old>exact snippet</old><new>replacement</new></edit_shader>   (<layer>/<pass> optional, default the top layer's output pass; add <replace_all>true</replace_all> to replace every occurrence)",
	[TOOL_NAMES.setUniforms]: '<set_uniforms>[{"name":"u_speed","type":"float","value":[1.0],"min":0,"max":3}]</set_uniforms>',
	[TOOL_NAMES.connectPins]: '<connect_pins>{"from":"pass:BlurY","to":"Image","layer":"Base","input":0}</connect_pins>   (from: none | under | geometry | mask | webcam | pass:<name> | builtin:<name> | asset:<name>)',
	[TOOL_NAMES.screenshot]: "<capture_screenshot></capture_screenshot>",
	[TOOL_NAMES.generateTexture]: '<generate_texture>{"prompt":"seamless rock surface","index":0}</generate_texture>',
};

export function textToolInstructions(tools: ToolDef[]): string {
	const lines = tools.map((t) => `${XML_USAGE[t.name] ?? `<${t.name}></${t.name}>`}\n    ${t.description}`).join("\n\n");
	return `# Tools (this model has no native tool API -- use these XML tags)
To take an action, put an XML tag in your reply. The tag's content is the argument: JSON for most tools, but edit_shader and create_object (when it carries GLSL) use sub-tags so raw GLSL needs no escaping. You may use several tags in one reply; they run top to bottom, and afterwards you receive the results (including any screenshot you asked for) as the next message. Keep any prose OUTSIDE the tags, and make sure every tag is closed.

Available tags:

${lines}`;
}
