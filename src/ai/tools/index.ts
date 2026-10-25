// Tool registry entry point. Importing this module registers every tool (each
// tool file self-registers on import). Import order = registration/offer order.

import "./read.ts";
import "./create_object.ts";
import "./destroy_object.ts";
import "./edit_object.ts";
import "./edit_shader.ts";
import "./connect_pins.ts";
import "./set_uniforms.ts";
import "./capture_screenshot.ts";
import "./generate_texture.ts";

export { TOOL_NAMES } from "./names.ts";
export type { ToolName } from "./names.ts";
export { toolDefs, getTool, allTools } from "./registry.ts";
export { text } from "./types.ts";
export type { Tool, ToolContext, ToolResult, ToolAvailability } from "./types.ts";
