// Builds the system prompt. For native tool-calling models the tool *schemas*
// are sent in the request's `tools` field, so they are NOT duplicated here --
// the prompt only covers the environment, conventions, and current state. For
// text-tools mode (models without native tool calling) `textToolInstructions`
// describes the same catalogue as forgiving XML tags.

import type { Channel, Project } from "../state/types.ts";
import type { ToolDef } from "./types.ts";
import { BUILTIN_LABELS } from "../gl/textures.ts";
import { TOOL_NAMES } from "./tools/names.ts";

export interface PromptContext {
	project: Project;
	assetNames: string[];
	imageGen: boolean;
	lastError?: string;
}

function channelLine(i: number, ch: Channel, assetName?: string): string {
	let v: string;
	if (ch.kind === "none") v = "empty";
	else if (ch.kind === "builtin") v = `builtin:${ch.builtin}`;
	else if (ch.kind === "webcam") v = "webcam (live camera)";
	else v = `${ch.kind === "video" ? "video" : "image"}:${assetName ?? ch.assetId ?? "?"}`;
	return `  iChannel${i}: ${v}`;
}

// The stable system prompt. Deliberately free of any per-request / per-edit
// state so it forms a byte-identical cache prefix across requests (see
// providers.ts -- it is sent with a `cache_control` breakpoint). The volatile
// project state lives in buildProjectState() and rides as a trailing message.
export function buildSystemPrompt(): string {
	const builtins = Object.entries(BUILTIN_LABELS)
		.map(([k, v]) => `${k} (${v})`)
		.join(", ");

	return `You are a shader programming agent inside a live WebGL2 sandbox. You collaborate with a user to design 2D fragment shaders, the way Shadertoy works. You can SEE what you render: after you change the shader you receive a screenshot and the GLSL compile log, so use that feedback to iterate toward what the user asks for.

# How rendering works
- The user writes nothing; YOU author the shader using your tools.
- You write GLSL ES 3.00 and MUST define:
      void mainImage(out vec4 fragColor, in vec2 fragCoord) { ... }
  fragCoord is in pixels (origin bottom-left). Write the final colour to fragColor (RGBA, 0..1).
- DO NOT include "#version", "precision", "out vec4", "void main()", or the iChannel/iTime uniform declarations. The harness prepends all of that. Just provide your helper functions and mainImage. (You may add extra helper functions and #define macros above mainImage.)
- It is GLSL ES 3.00: use texture(...) not texture2D, no gl_FragColor. Integer/float types are strict (write 1.0 not 1 for floats).

# Built-in uniforms (already declared, just use them)
  vec3  iResolution      // viewport size in pixels (xy), z = 1
  float iTime            // seconds since start
  float iTimeDelta       // seconds per frame (approx)
  float iFrameRate
  int   iFrame           // frame counter
  vec4  iMouse           // xy = current/last pointer (pixels, y-up); zw = click pos (signed)
  vec4  iDate            // year, month, day, seconds-in-day
  sampler2D iChannel0..3 // input textures
  vec3  iChannelResolution[4]
Normalize coordinates with: vec2 uv = fragCoord / iResolution.xy;  (use iResolution.xy for aspect correction).

# Channels (iChannel0..3 inputs)
A channel can be bound to: a built-in procedural texture (${builtins}); an uploaded/generated image; an uploaded video; or the live webcam. Videos and the webcam are DYNAMIC -- their current frame is uploaded every render frame, so sampling the channel animates by itself (don't add iTime to make a video move; just sample it). iChannelResolution[i] gives each channel's pixel size (for videos/webcam it's the source resolution). Use set_channel for built-ins/webcam/clearing and set_channel_asset to bind an image or video by name (see list_assets). You cannot upload media yourself -- the user does that -- but you can bind what already exists and you can turn on the webcam.

# Working style
- Prefer doing over describing: use your tools to change the shader rather than pasting code into chat. Keep chat replies short -- a sentence or two about what you did or what you need.
- IMPORTANT: to change an existing shader, make targeted EDITS (replace just the snippet that changes). Do not retype the whole shader -- it is slower and error-prone. Writing the whole shader from scratch is only for the very first shader or a deliberate full rewrite.
- Expose the key parameters as uniforms so the user can tweak them live; keep motion subtle by default.
- ALWAYS verify your work visually before you finish. To keep your context lean you are NOT shown a screenshot after every edit by default -- pass screenshot:true on init_shader/edit_shader (or call capture_screenshot) when you want to see the render mid-task. When you end your turn you are ALWAYS shown the final render and asked to confirm it: check colours, scale, and composition against the request and keep editing if anything is off. A black render usually means out-of-range values or fragColor.alpha left at 0.
- If compilation fails, READ the log (line numbers are relative to your source) and fix it with another edit. Keep iterating until it both compiles and looks right.
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
	const channels = p.channels.map((ch, i) => channelLine(i, ch)).join("\n");

	return `The following is the live project state from the editor (provided automatically -- it is not a message from the user):

# Current project state
Shader (${p.shaderSource.split("\n").length} lines) is already loaded.
Custom uniforms:
${uniforms}
Channels:
${channels}
Available image assets: ${ctx.assetNames.length ? ctx.assetNames.join(", ") : "(none)"}${ctx.imageGen ? "\nImage generation is enabled (generate_texture available)." : ""}${ctx.lastError ? `\nMost recent compile error:\n${ctx.lastError}` : ""}`;
}

// ---- text-tools mode -------------------------------------------------------

// How each tool is invoked as an XML tag. Only the tools actually offered this
// turn (after gating) are listed, so e.g. init_shader disappears once a shader
// exists. Keyed by the TOOL_NAMES constants.
const XML_USAGE: Record<string, string> = {
	[TOOL_NAMES.initShader]: "<init_shader>\n...complete GLSL source (mainImage + helpers)...\n</init_shader>",
	[TOOL_NAMES.editShader]: "<edit_shader><old>exact snippet from the current shader</old><new>replacement</new></edit_shader>   (add <replace_all>true</replace_all> to replace every occurrence)",
	[TOOL_NAMES.setUniforms]: '<set_uniforms>[{"name":"u_speed","type":"float","value":[1.0],"min":0,"max":3}]</set_uniforms>',
	[TOOL_NAMES.renameShader]: '<rename_shader>{"name":"Plasma Storm"}</rename_shader>   (asks the user to approve before it takes effect)',
	[TOOL_NAMES.setChannel]: '<set_channel>{"index":0,"kind":"builtin","builtin":"rgbaNoise"}</set_channel>   (kind: none | builtin | webcam; use set_channel_asset for images/videos)',
	[TOOL_NAMES.setChannelAsset]: '<set_channel_asset>{"index":0,"asset":"asset name"}</set_channel_asset>   (binds an image or video asset; videos animate on their own)',
	[TOOL_NAMES.listAssets]: "<list_assets></list_assets>",
	[TOOL_NAMES.getShader]: "<get_shader></get_shader>",
	[TOOL_NAMES.screenshot]: "<capture_screenshot></capture_screenshot>",
	[TOOL_NAMES.generateTexture]: '<generate_texture>{"prompt":"seamless rock surface","index":0}</generate_texture>',
};

export function textToolInstructions(tools: ToolDef[]): string {
	const lines = tools.map((t) => `${XML_USAGE[t.name] ?? `<${t.name}></${t.name}>`}\n    ${t.description}`).join("\n\n");
	return `# Tools (this model has no native tool API -- use these XML tags)
To take an action, put an XML tag in your reply. The tag's content is the argument (raw GLSL for init_shader, <old>/<new> for edit_shader, JSON for the rest). You may use several tags in one reply; they run top to bottom, and afterwards you receive the results (and a screenshot) as the next message. Keep any prose OUTSIDE the tags, and make sure every tag is closed.

Available tags:

${lines}`;
}
