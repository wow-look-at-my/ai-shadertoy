// Tool registry. Each tool module calls registerTool() at import time;
// registration order (= import order in index.ts) is preserved.

import type { Tool, ToolAvailability } from "./types.ts";
import type { ToolDef } from "../types.ts";

const registry = new Map<string, Tool>();
const order: string[] = [];

export function registerTool(tool: Tool): void {
	if (!registry.has(tool.name)) order.push(tool.name);
	registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
	return registry.get(name);
}

export function allTools(): Tool[] {
	return order.map((n) => registry.get(n)!);
}

/** The tool schemas offered to the model this turn, after availability gating. */
export function toolDefs(opts: ToolAvailability): ToolDef[] {
	return allTools()
		.filter((t) => (t.available ? t.available(opts) : true))
		.map((t) => t.def);
}
