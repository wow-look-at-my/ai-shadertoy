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
	activeLayerId: string;
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

/** Summarize the layer stack (back/0 -> front), each layer's graph and geometry,
 * and mark the active layer. */
function documentSummary(p: Project, activeLayerId: string): string {
	return p.layers
		.map((layer, i) => {
			const flags = [layer.visible ? null : "hidden", layer.opacity < 1 ? `opacity ${layer.opacity.toFixed(2)}` : null, layer.mask ? "masked" : null, layer.id === activeLayerId ? "ACTIVE" : null].filter(Boolean).join(", ");
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

	return `You are a shader programming agent inside a live WebGL2 sandbox. You collaborate with a user to design 2D fragment shaders, the way Shadertoy works -- but with a full MULTI-PASS render graph, not a single shader. You can SEE what you render: after you change the shader you receive a screenshot and the GLSL compile log, so use that feedback to iterate toward what the user asks for.

# How rendering works
- The user writes nothing; YOU author the shader(s) using your tools.
- You write GLSL ES 3.00 and each pass MUST define:
      void mainImage(out vec4 fragColor, in vec2 fragCoord) { ... }
  fragCoord is in pixels (origin bottom-left). Write the final colour to fragColor (RGBA, 0..1).
- DO NOT include "#version", "precision", "out vec4", "void main()", or built-in uniform declarations (iTime, iResolution, iChannel samplers, etc.). The harness prepends all of that. Just provide your helper functions and mainImage. You MAY declare custom controls with \`uniform float/vec2/vec3/vec4 u_name;\`; those declarations automatically become live UI inputs. Add an optional initializer to bake in a starting value, e.g. \`uniform float u_speed = 1.5;\` or \`uniform vec3 u_tint = vec3(1.0, 0.5, 0.2);\` (it becomes the control's default and the range adjusts to fit). (You may add extra helper functions and #define macros above mainImage.)
- It is GLSL ES 3.00: use texture(...) not texture2D, no gl_FragColor. Integer/float types are strict (write 1.0 not 1 for floats).

# Layers (a node-graph "Photoshop")
- The document is an ORDERED STACK OF LAYERS drawn BACK TO FRONT. layer[0] is the bottom (drawn first); the last layer is on top. The topmost visible layer's composite is what's shown on screen. This is the One True draw order.
- Each layer is its OWN render graph (its own passes + an output pass = that layer's composite) PLUS a list of GEOMETRY shapes (quads/circles). Layer-ambient source pins are available to a layer's passes and can be wired with connect_pins:
    - kind=under -- the composite of ALL the layers BELOW this one (transparent for the bottom layer). This is how a layer blends over what's underneath.
    - kind=geometry -- this layer's shapes rasterized to a premultiplied texture (rgb = colour, alpha = coverage).
    - kind=mask -- this layer's mask output (alpha = coverage; opaque white if the layer has no mask).
  Because the blend is just shader math in the layer's output pass, THE NODE GRAPH CONTROLS THE BLENDING. A fresh layer (add_layer) comes pre-wired iChannel0=under, iChannel1=geometry doing source-over: fragColor = geo + under*(1.0 - geo.a). Rewrite that to multiply, screen, add, displace by geometry, mask, etc.
- Geometry is REAL instanced shapes you place as data, not SDF code you write. Manage it with add_shape / edit_shape / remove_shape / list_shapes. Shapes use normalized coords: centre (x,y) in 0..1 (origin bottom-left), size (w,h) as a fraction of the canvas; plus rotation (degrees), rgba colour, cornerRadius (quad), feather. Available kinds: ${Object.values(SHAPE_LABELS).join(", ")}.
- Manage the stack with add_layer (adds on top, becomes ACTIVE), remove_layer, reorder_layer, set_layer (name/visible/opacity), list_layers. The pass/geometry tools act on the ACTIVE layer -- call select_layer first to work on a different one (add_layer/add_shape already target the right layer).
- LAYER MASKS: a layer can have a MASK (another layer, rendered standalone). add_mask adds a visible "Masked Composite" pass to the layer graph, wired iChannel0=under, iChannel1=the unmasked layer output, iChannel2=mask, with shader math: fragColor = mix(under, comp, mask.alpha). The mask is seeded with a soft circle and becomes the ACTIVE layer, so add_shape/edit_shape build the mask (an ellipse with falloff = a radial-gradient mask); select_layer returns to the stack. remove_mask drops it and removes the generated graph node.
- Typical build: keep a background in the Base layer; add_layer "Shapes"; add_shape circle/quad to it; it composites over the background automatically. For a glow, add a layer, add a bright shape, then add blur passes inside that layer sampling geometry, and have its output composite the blurred glow over under.

# Multi-pass render graph WITHIN a layer (beyond Shadertoy's fixed buffers)
- A layer's graph is one or more passes. Each pass is a full-screen fragment shader that renders to its OWN offscreen texture at the canvas resolution. The layer's OUTPUT pass produces that layer's composite.
- Each pass's texture input pins are derived from the shader source: referencing iChannel0 creates input 0; referencing iChannel2 creates inputs 0..2; removing the reference removes the pin. connect_pins wires a graph source into one of those existing inputs. A texture input can sample: under, geometry, mask, a built-in texture, an uploaded/generated image, an uploaded VIDEO, the live WEBCAM, or THE OUTPUT OF ANOTHER PASS IN THE SAME LAYER. Video and webcam inputs are DYNAMIC -- their current frame is uploaded every render frame, so sampling them animates by itself (don't add iTime to make a video move; just sample it). Bind existing images/videos with connect_pins from=asset:<name> and the webcam with from=webcam; you cannot upload media yourself (the user does), but you can wire what exists and turn on the webcam.
- Passes execute in dependency order (a pass that samples another renders after it). If a channel samples its OWN pass, it reads that pass's PREVIOUS frame -- feedback (trails, reaction-diffusion, accumulation, fluid).
- Use add_pass to create passes, connect_pins from=pass:<name> to wire them, set_output_pass to choose the layer's composite, list_passes/get_shader to inspect, remove_pass to delete. edit_shader/get_shader take an optional 'pass' name and default to the active layer's output pass.
- Use rgba16f format for HDR intermediates (a bright effect you will blur/bloom) so highlights survive; default rgba8 is fine otherwise.
- Worked example -- glow/bloom within a layer: add_pass "Effect" (rgba16f) sampling geometry; add_pass "BlurX" sampling Effect; add_pass "BlurY" sampling BlurX; then the layer's output pass samples under + BlurY and adds the soft glow over what's below. Separable blur is far cheaper than one giant kernel.

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
Custom uniforms are SHARED across all passes in all layers. Declare them in shader source as \`uniform float/vec2/vec3/vec4 u_name;\` (optionally with a default, e.g. \`= 1.5\` or \`= vec3(1.0, 0.5, 0.2)\`); the editor extracts them into live controls automatically. Use set_uniforms only to adjust their defaults/ranges/labels. Built-in procedural textures you can bind to channels: ${builtins}.

# Working style
- Prefer doing over describing: use your tools to change the shader rather than pasting code into chat. Keep chat replies short -- a sentence or two about what you did or what you need.
- Start simple: a single Base layer with one output pass is fine for most requests. Reach for extra passes when the effect needs them (blur/bloom, feedback/trails, ping-pong simulation), and for extra LAYERS when the user wants stacked, independently-composited elements (shapes over a background, a glow plate, a mask) -- each layer can blend over what's below however its graph says.
- IMPORTANT: to change an existing shader, make targeted EDITS (replace just the snippet that changes). Do not retype the whole shader. init_shader writes the output pass from scratch and is only for the very first shader or a deliberate full rewrite; add_pass creates additional passes.
- Expose the key parameters as uniforms so the user can tweak them live; keep motion subtle by default.
- ALWAYS verify your work visually before you finish. To keep your context lean you are NOT shown a screenshot after every edit by default -- pass screenshot:true (or call capture_screenshot) when you want to see the render mid-task. When you end your turn you are ALWAYS shown the final render and asked to confirm it: check colours, scale, and composition against the request and keep editing if anything is off. A black render usually means out-of-range values, fragColor.alpha left at 0, or the wrong pass set as output.
- If compilation fails, READ the log (line numbers are relative to each pass's source, prefixed with [pass name]) and fix it with another edit. Keep iterating until it both compiles and looks right.
- Only ask a clarifying question when the request is genuinely ambiguous; otherwise make a reasonable choice and show a result.

The editor sends the current project state (loaded shader, uniforms, channels, assets, last compile error) as an automatic status message each turn; treat it as ground truth for what currently exists.`;
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
Layer stack (${p.layers.length} layer${p.layers.length === 1 ? "" : "s"}, ${totalPasses} pass${totalPasses === 1 ? "" : "es"} total; drawn back [0] to front; ACTIVE layer is where pass/geometry tools act):
${documentSummary(p, ctx.activeLayerId)}
Custom uniforms (shared by all passes in all layers):
${uniforms}
Available image assets: ${ctx.assetNames.length ? ctx.assetNames.join(", ") : "(none)"}${ctx.imageGen ? "\nImage generation is enabled (generate_texture available)." : ""}${ctx.lastError ? `\nMost recent compile error:\n${ctx.lastError}` : ""}`;
}

// ---- text-tools mode -------------------------------------------------------

// How each tool is invoked as an XML tag. Only the tools actually offered this
// turn (after gating) are listed, so e.g. init_shader disappears once a shader
// exists. Keyed by the TOOL_NAMES constants.
const XML_USAGE: Record<string, string> = {
	[TOOL_NAMES.initShader]: "<init_shader>\n...complete GLSL source (mainImage + helpers) for the OUTPUT pass...\n</init_shader>",
	[TOOL_NAMES.editShader]: "<edit_shader><pass>Effect</pass><old>exact snippet</old><new>replacement</new></edit_shader>   (<pass> optional, defaults to the output pass; add <replace_all>true</replace_all> to replace every occurrence)",
	[TOOL_NAMES.addPass]: "<add_pass><name>BlurX</name><format>rgba16f</format><source>\n...GLSL mainImage for the new pass...\n</source></add_pass>   (<format> optional: rgba8 | rgba16f)",
	[TOOL_NAMES.removePass]: '<remove_pass>{"pass":"BlurX"}</remove_pass>',
	[TOOL_NAMES.listPasses]: "<list_passes></list_passes>",
	[TOOL_NAMES.setOutputPass]: '<set_output_pass>{"pass":"Image"}</set_output_pass>',
	[TOOL_NAMES.setUniforms]: '<set_uniforms>[{"name":"u_speed","type":"float","value":[1.0],"min":0,"max":3}]</set_uniforms>',
	[TOOL_NAMES.renameShader]: '<rename_shader>{"name":"Plasma Storm"}</rename_shader>   (asks the user to approve before it takes effect)',
	[TOOL_NAMES.connectPins]: '<connect_pins>{"from":"pass:BlurY","to":"Image","input":0}</connect_pins>   (from: none | under | geometry | mask | webcam | pass:<name> | builtin:<name> | asset:<name>)',
	[TOOL_NAMES.listAssets]: "<list_assets></list_assets>",
	[TOOL_NAMES.getShader]: "<get_shader><pass>Effect</pass></get_shader>   (<pass> optional, defaults to the active layer's output pass)",
	[TOOL_NAMES.screenshot]: "<capture_screenshot></capture_screenshot>",
	[TOOL_NAMES.generateTexture]: '<generate_texture>{"prompt":"seamless rock surface","index":0}</generate_texture>',
	[TOOL_NAMES.listLayers]: "<list_layers></list_layers>",
	[TOOL_NAMES.addLayer]: '<add_layer>{"name":"Shapes","shape":"circle","x":0.5,"y":0.5,"w":0.3,"h":0.3,"color":[1,0.8,0.2,1]}</add_layer>   (adds a layer on top, pre-wired to composite over the layers below; becomes active)',
	[TOOL_NAMES.removeLayer]: '<remove_layer>{"layer":"Shapes"}</remove_layer>',
	[TOOL_NAMES.reorderLayer]: '<reorder_layer>{"layer":"Shapes","move":"top"}</reorder_layer>   (move: up | down | top | bottom, or {"to": index})',
	[TOOL_NAMES.setLayer]: '<set_layer>{"layer":"Shapes","opacity":0.6,"visible":true}</set_layer>',
	[TOOL_NAMES.selectLayer]: '<select_layer>{"layer":"Shapes"}</select_layer>   (make a layer active so pass/geometry tools target it)',
	[TOOL_NAMES.addMask]: '<add_mask>{"layer":"Glow"}</add_mask>   (mask a layer by another layer\'s alpha; seeds a soft circle and makes the MASK active to edit -- e.g. an ellipse with falloff = a radial-gradient mask)',
	[TOOL_NAMES.removeMask]: '<remove_mask>{"layer":"Glow"}</remove_mask>',
	[TOOL_NAMES.listShapes]: '<list_shapes>{"layer":"Shapes"}</list_shapes>',
	[TOOL_NAMES.addShape]: '<add_shape>{"kind":"quad","x":0.5,"y":0.5,"w":0.4,"h":0.25,"rotation":15,"color":[0.2,0.6,1,1],"cornerRadius":0.3}</add_shape>   (x,y centre & w,h size are 0..1 of the canvas; rotation in degrees)',
	[TOOL_NAMES.editShape]: '<edit_shape>{"index":0,"x":0.4,"color":[1,0,0,1]}</edit_shape>   (index = shape position from list_shapes)',
	[TOOL_NAMES.removeShape]: '<remove_shape>{"index":0}</remove_shape>',
};

export function textToolInstructions(tools: ToolDef[]): string {
	const lines = tools.map((t) => `${XML_USAGE[t.name] ?? `<${t.name}></${t.name}>`}\n    ${t.description}`).join("\n\n");
	return `# Tools (this model has no native tool API -- use these XML tags)
To take an action, put an XML tag in your reply. The tag's content is the argument (raw GLSL for init_shader, sub-tags for edit_shader/add_pass, JSON for the rest). You may use several tags in one reply; they run top to bottom, and afterwards you receive the results (and a screenshot) as the next message. Keep any prose OUTSIDE the tags, and make sure every tag is closed.

Available tags:

${lines}`;
}
