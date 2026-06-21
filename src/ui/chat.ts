// Chat panel. Renders the conversation and drives the agent loop: a user
// message kicks off runAgent, whose streamed text, tool calls, and tool results
// (including screenshots) are rendered here as they arrive.

import { append, clear, el } from "../util/dom.ts";
import { icon } from "../util/icons.ts";
import { renderMarkdown } from "../util/markdown.ts";
import { uid } from "../util/misc.ts";
import { runAgent, type PermissionRequest } from "../ai/agent.ts";
import { buildProjectState, buildSystemPrompt } from "../ai/system-prompt.ts";
import { hasPricing, messageCost, modelContextWindow } from "../ai/pricing.ts";
import { toolDefs, TOOL_NAMES } from "../ai/tools/index.ts";
import { stripTextToolTags } from "../ai/texttools.ts";
import { ProviderError } from "../ai/providers.ts";
import type { Block, ImageBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from "../state/types.ts";
import type { Store } from "../state/store.ts";

// init_shader is offered only until the AI has authored the shader this
// conversation (first turn / after a reset); after that, edits only.
function authoredShader(messages: Message[]): boolean {
	const isShaderTool = (n: string) => n === TOOL_NAMES.initShader || n === TOOL_NAMES.editShader;
	return messages.some((m) => m.role === "assistant" && ((m.textTools?.some(isShaderTool) ?? false) || m.blocks.some((b) => b.type === "tool_use" && isShaderTool(b.name))));
}

export interface ChatDeps {
	store: Store;
	openSettings: () => void;
}

export function createChat(deps: ChatDeps): HTMLElement {
	const { store } = deps;
	const list = el("div", { class: "chat-list" });
	const input = el("textarea", { class: "chat-input", attrs: { rows: "2", placeholder: "Describe the shader you want… (Enter to send, Shift+Enter for newline)" } });

	let attach = false;
	const attachBtn = el("button", { class: "btn icon", title: "Attach the current frame to your next message" }, icon("camera"));
	attachBtn.addEventListener("click", () => {
		attach = !attach;
		attachBtn.classList.toggle("on", attach);
	});

	const sendBtn = el("button", { class: "btn primary", on: { click: () => void send() } }, "Send");
	const stopBtn = el("button", { class: "btn danger", on: { click: () => abort?.abort() } }, "Stop");
	stopBtn.hidden = true;

	let abort: AbortController | null = null;
	let streamingText: HTMLElement | null = null;
	let pending = ""; // assistant text received but not yet painted
	let pumpId = 0; // rAF id for the typewriter pump (0 = idle)
	let shownProjectId = store.project.id;

	// usage / cost indicator: tokens/sec + context % (every model), and cost this
	// turn + this session (when the model's pricing is known). Fed by onUsage.
	const statsBar = el("div", { class: "chat-stats", hidden: true });
	let costTotal = 0;
	let costTurn = 0;
	let lastTps = 0;
	let lastCtxPct = 0;
	let haveStats = false;

	function fmtCost(c: number): string {
		if (c >= 1) return `$${c.toFixed(2)}`;
		if (c >= 0.01) return `$${c.toFixed(3)}`;
		return `$${c.toFixed(4)}`;
	}
	function renderStats(): void {
		if (!haveStats) {
			statsBar.hidden = true;
			return;
		}
		const sep = (): HTMLElement => el("span", { class: "cs-sep" }, "·");
		const item = (label: string, title: string): HTMLElement => el("span", { class: "cs-item", title }, label);
		const ctxLabel = `${lastCtxPct < 10 ? lastCtxPct.toFixed(1) : lastCtxPct.toFixed(0)}% ctx`;
		const parts: HTMLElement[] = [item(`${lastTps.toFixed(0)} tok/s`, "Output tokens per second (last response)"), sep(), item(ctxLabel, "Share of the model's context window used (last request)")];
		if (hasPricing(store.settings.chat.model)) {
			parts.push(sep(), item(`${fmtCost(costTurn)} turn`, "Cost of the current / last turn"), sep(), item(`${fmtCost(costTotal)} total`, "Total cost this session"));
		}
		clear(statsBar);
		append(statsBar, parts);
		statsBar.hidden = false;
	}

	store.on("busy", (b) => {
		stopBtn.hidden = !b;
		sendBtn.hidden = !!b;
		input.disabled = !!b;
	});

	// Only rebuild the whole conversation when the project itself changes
	// (switch / new / import). Mid-conversation shader edits also emit "project"
	// but must not wipe streaming bubbles or appended tool rows.
	store.on("project", () => {
		if (store.project.id !== shownProjectId) {
			shownProjectId = store.project.id;
			renderAll();
		}
	});

	function renderAll(): void {
		clear(list);
		if (!store.project.messages.length) {
			append(list, [el("div", { class: "chat-hint" }, el("p", {}, "Tell the AI what to build. It writes the shader, sees the result, and iterates."), el("p", { class: "muted" }, "Examples: ", el("em", {}, "“a swirling plasma in purples and gold”, “raymarched torus with soft shadows”, “animated checkerboard floor”")))]);
		} else {
			for (const m of store.project.messages) list.appendChild(messageEl(m));
		}
		scroll();
	}

	function scroll(): void {
		requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
	}

	// Anthropic streams text in coarse chunks (~2-5 deltas/sec for Opus), so
	// painting each chunk on arrival looks choppy. Buffer incoming text and drain
	// a slice per animation frame, typing each chunk in smoothly. The /12 divisor
	// keeps what's shown within ~200ms of what's arrived; appending a text node
	// (vs reassigning textContent) keeps it O(n). onMessage renders the full
	// markdown at the end, so any text still in the buffer is never lost.
	function pumpStream(): void {
		pumpId = 0;
		if (!streamingText || !pending) return;
		const step = Math.max(2, Math.ceil(pending.length / 12));
		streamingText.appendChild(document.createTextNode(pending.slice(0, step)));
		pending = pending.slice(step);
		list.scrollTop = list.scrollHeight;
		if (pending) pumpId = requestAnimationFrame(pumpStream);
	}
	function feedStream(t: string): void {
		pending += t;
		if (!pumpId) pumpId = requestAnimationFrame(pumpStream);
	}
	function endStream(): void {
		if (pumpId) cancelAnimationFrame(pumpId);
		pumpId = 0;
		pending = "";
		streamingText = null;
	}

	// Surface an approve/deny card for a permission-gated tool call and resolve
	// with the user's choice. Stop (abort) resolves it as denied.
	function requestPermission(req: PermissionRequest): Promise<boolean> {
		return new Promise((resolve) => {
			const signal = abort?.signal;
			const approve = el("button", { class: "btn primary" }, "Approve");
			const deny = el("button", { class: "btn" }, "Deny");
			const actions = el("div", { class: "perm-actions" }, approve, deny);
			const card = el(
				"div",
				{ class: "perm-card" },
				el("div", { class: "perm-head" }, "🔒 Permission required"),
				el("div", { class: "perm-prompt" }, req.prompt),
				actions,
			);
			list.appendChild(card);
			scroll();

			let settled = false;
			const finish = (granted: boolean, label: string, cls: string): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				card.classList.add(cls);
				clear(actions);
				actions.appendChild(el("span", { class: "perm-status" }, label));
				resolve(granted);
			};
			const onAbort = (): void => finish(false, "Cancelled", "denied");

			approve.addEventListener("click", () => finish(true, "✓ Approved", "approved"));
			deny.addEventListener("click", () => finish(false, "✕ Denied", "denied"));

			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort);
		});
	}

	async function send(): Promise<void> {
		const value = input.value.trim();
		if (!value) return;
		// Anthropic always needs a key; OpenAI-compatible endpoints may be keyless
		// (e.g. a local Ollama server), so don't block those.
		if (store.settings.chat.provider === "anthropic" && !store.settings.chat.apiKey) {
			alert("Add your API key in Settings first.");
			deps.openSettings();
			return;
		}

		const blocks: Block[] = [{ type: "text", text: value }];
		if (attach) {
			const shot = store.renderer.screenshot(store.settings.screenshotMaxDim);
			blocks.push({ type: "image", mediaType: shot.mediaType, data: shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1) });
			attach = false;
			attachBtn.classList.remove("on");
		}
		const userMsg: Message = { id: uid("m_"), role: "user", ts: Date.now(), blocks };
		store.project.messages.push(userMsg);
		if (store.project.messages.length === 1) clear(list);
		list.appendChild(messageEl(userMsg));
		input.value = "";
		scroll();

		abort = new AbortController();
		store.setBusy(true);
		costTurn = 0; // start a fresh per-turn cost tally
		try {
			await runAgent(
				store.settings,
				() => buildSystemPrompt(),
				() => buildProjectState({ project: store.project, assetNames: store.assets.map((a) => a.name), imageGen: store.settings.imageGen.enabled, lastError: store.lastCompile && !store.lastCompile.ok ? store.lastCompile.log : undefined }),
				store.project.messages,
				() => toolDefs({ imageGen: store.settings.imageGen.enabled, allowInitShader: !authoredShader(store.project.messages) }),
				(name, inp) => store.applyTool(name, inp),
				{
					signal: abort.signal,
					requestPermission,
					onUsage: (usage, durationMs) => {
						const model = store.settings.chat.model;
						const c = messageCost(model, usage);
						if (c != null) {
							costTurn += c;
							costTotal += c;
						}
						const totalIn = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
						const ctx = modelContextWindow(model);
						if (ctx > 0) lastCtxPct = (totalIn / ctx) * 100;
						if (usage.outputTokens > 0 && durationMs > 0) lastTps = (usage.outputTokens / durationMs) * 1000;
						haveStats = true;
						renderStats();
					},
					onTurnStart: () => {
						if (pumpId) cancelAnimationFrame(pumpId);
						pumpId = 0;
						pending = "";
						streamingText = el("div", { class: "md streaming" });
						list.appendChild(el("div", { class: "msg assistant" }, streamingText));
						scroll();
					},
					onAssistantDelta: (t) => {
						if (streamingText) feedStream(t);
					},
					onToolActivity: (toolName, phase) => {
						if (phase === "start") {
							const chip = el("div", { class: "tool-chip running" }, `running ${toolName}…`);
							list.appendChild(chip);
							scroll();
							setTimeout(() => chip.remove(), 4000);
						}
					},
					onMessage: (msg) => {
						void store.saveProjectNow();
						if (msg.role === "assistant" && streamingText) {
							const bubble = streamingText.parentElement;
							endStream();
							if (bubble) {
								clear(bubble);
								append(bubble, assistantContent(msg));
							}
						} else {
							list.appendChild(messageEl(msg));
						}
						scroll();
					},
				},
			);
		} catch (e) {
			const detail = e instanceof ProviderError ? `${e.message}${e.hint ? `\n${e.hint}` : ""}` : e instanceof Error ? e.message : String(e);
			list.appendChild(el("div", { class: "msg error" }, el("strong", {}, "Error: "), detail));
		} finally {
			store.setBusy(false);
			abort = null;
			endStream();
			await store.saveProjectNow();
			scroll();
		}
	}

	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	});

	renderAll();
	return el(
		"section",
		{ class: "chat" },
		list,
		statsBar,
		el("div", { class: "chat-bar" }, attachBtn, input, el("div", { class: "chat-actions" }, sendBtn, stopBtn)),
	);
}

// ---- message rendering -----------------------------------------------------

function messageEl(m: Message): HTMLElement {
	if (m.role === "user") {
		// text-tools mode feeds tool results back as a user message -- render it
		// as a results row, not a user bubble.
		return m.toolOutput ? toolOutputEl(m) : el("div", { class: "msg user" }, ...m.blocks.map(blockEl));
	}
	if (m.role === "assistant") {
		return el("div", { class: "msg assistant" }, ...assistantContent(m));
	}
	return el("div", { class: "msg tool" }, ...m.blocks.map((b) => (b.type === "tool_result" ? toolResultEl(b) : blockEl(b))));
}

function assistantContent(m: Message): HTMLElement[] {
	const out: HTMLElement[] = [];
	if (m.textTools !== undefined) {
		// text-tools mode: strip the XML tool tags, show the prose + tool chips.
		const textBlock = m.blocks.find((b): b is TextBlock => b.type === "text");
		const prose = stripTextToolTags(textBlock?.text ?? "");
		if (prose) out.push(renderMarkdown(prose));
		for (const name of m.textTools) out.push(el("div", { class: "tool-chip" }, el("span", { class: "tool-name" }, icon("wrench", { size: 13 }), " ", name)));
		if (!out.length) out.push(el("div", { class: "muted small" }, "(no text)"));
		return out;
	}
	for (const b of m.blocks) {
		if (b.type === "text" && b.text.trim()) out.push(renderMarkdown(b.text));
		else if (b.type === "tool_use") out.push(toolUseEl(b));
	}
	if (!out.length) out.push(el("div", { class: "muted small" }, "(no text)"));
	return out;
}

function toolOutputEl(m: Message): HTMLElement {
	const textParts = m.blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text);
	const imgs = m.blocks.filter((b): b is ImageBlock => b.type === "image");
	const summary = textParts.join(" ").split("\n")[0].slice(0, 120);
	return el("div", { class: "msg tool" }, el("div", { class: "tool-result" }, el("span", { class: "tr-status" }, icon("check", { size: 15 })), el("span", { class: "tr-text" }, summary), ...imgs.map(imgThumb)));
}

function blockEl(b: Block): HTMLElement {
	if (b.type === "text") return renderMarkdown(b.text);
	if (b.type === "image") return imgThumb(b);
	if (b.type === "tool_use") return toolUseEl(b);
	return el("span", {});
}

function toolUseEl(b: ToolUseBlock): HTMLElement {
	const inp = b.input as Record<string, unknown> | undefined;
	const note = inp && typeof inp["note"] === "string" ? `: ${inp["note"]}` : "";
	return el("div", { class: "tool-chip" }, el("span", { class: "tool-name" }, icon("wrench", { size: 13 }), " ", b.name), note);
}

function toolResultEl(b: ToolResultBlock): HTMLElement {
	const textPart = b.content.find((c): c is TextBlock => c.type === "text");
	const imgs = b.content.filter((c): c is ImageBlock => c.type === "image");
	const summary = (textPart?.text ?? "").split("\n")[0].slice(0, 120);
	return el(
		"div",
		{ class: `tool-result${b.isError ? " err" : ""}` },
		el("span", { class: "tr-status" }, icon(b.isError ? "close" : "check", { size: 15 })),
		el("span", { class: "tr-text" }, summary),
		...imgs.map(imgThumb),
	);
}

function imgThumb(b: ImageBlock): HTMLElement {
	return el("img", { class: "thumb", attrs: { src: `data:${b.mediaType};base64,${b.data}`, alt: "render" } });
}
