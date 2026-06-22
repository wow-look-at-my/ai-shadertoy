// Unit tests for conversation compaction. Run with:
//   node --experimental-strip-types test/compact.test.ts
// Pure + DOM-free: the gate (shouldCompact), the replacement round
// (buildCompactedMessages), and that the result serializes to a valid
// user/assistant alternation for the providers.

import { buildCompactedMessages, COMPACT_REQUEST_TEXT, hasCompactionSummary, shouldCompact } from "../src/ai/compact.ts";
import { deletionRange, isDeletable, isTurnStart } from "../src/util/conversation.ts";
import { toOpenAIMessages } from "../src/ai/providers.ts";
import type { Message } from "../src/state/types.ts";

let passed = 0;
function check(cond: boolean, msg: string): void {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	passed++;
}
function eq(a: unknown, b: unknown, msg: string): void {
	check(a === b, `${msg} (got ${String(a)}, want ${String(b)})`);
}

const msg = (role: Message["role"], text = "", extra: Partial<Message> = {}): Message => ({ id: `m_${Math.random().toString(36).slice(2)}`, role, ts: 0, blocks: text ? [{ type: "text", text }] : [], ...extra });

// ---- shouldCompact ---------------------------------------------------------
{
	eq(shouldCompact([]), false, "empty: nothing to compact");
	eq(shouldCompact([msg("user"), msg("assistant"), msg("tool")]), false, "3 messages: below threshold");
	eq(shouldCompact([msg("user"), msg("assistant"), msg("tool"), msg("assistant")]), true, "4 messages: worth compacting");
	// already-compacted artifacts don't count toward the threshold
	const compactedOnly = [msg("user", "x", { compaction: "request" }), msg("assistant", "s", { compaction: "summary" })];
	eq(shouldCompact(compactedOnly), false, "a bare summary is not itself re-compactable");
	eq(shouldCompact([...compactedOnly, msg("user"), msg("assistant"), msg("tool"), msg("assistant")]), true, "summary + a fresh round past threshold compacts again");
}

// ---- buildCompactedMessages ------------------------------------------------
{
	const out = buildCompactedMessages("THE SUMMARY");
	eq(out.length, 2, "compaction is a two-message round");
	eq(out[0].role, "user", "first message is the user request");
	eq(out[1].role, "assistant", "second message is the assistant summary (ends on assistant)");
	eq(out[0].compaction, "request", "request is flagged");
	eq(out[1].compaction, "summary", "summary is flagged");
	eq(out[0].blocks[0].type === "text" && out[0].blocks[0].text, COMPACT_REQUEST_TEXT, "request carries the summarize instruction");
	eq(out[1].blocks[0].type === "text" && out[1].blocks[0].text, "THE SUMMARY", "summary carries the model's recap");
	check(out[0].id !== out[1].id, "the two messages have distinct ids");

	eq(hasCompactionSummary(out), true, "hasCompactionSummary detects the recap");
	eq(hasCompactionSummary([msg("user"), msg("assistant")]), false, "no summary in a normal conversation");

	// interplay with the conversation edit/delete math
	eq(isTurnStart(out[0]), true, "the request is a round boundary");
	eq(isTurnStart(out[1]), false, "the summary is not a round boundary");
	eq(isDeletable(out[1]), true, "the summary row is a deletable assistant turn");
	const range = deletionRange(out, out[0].id);
	check(range !== null && range.start === 0 && range.count === 2, "deleting the round removes both compaction rows together");
}

// ---- serializes to a valid alternation -------------------------------------
{
	// The compacted round begins a fresh chat; a real prompt follows it.
	const conversation = [...buildCompactedMessages("S"), msg("user", "now make it blue")];
	const oa = toOpenAIMessages("system prompt", conversation, "");
	const roles = oa.map((m) => (m as { role: string }).role);
	eq(roles.join(","), "system,user,assistant,user", "system -> user(summarize) -> assistant(summary) -> user(next): clean alternation");
	eq((oa[2] as { content: string }).content, "S", "the summary text survives serialization");
}

console.log(`ok - ${passed} assertions passed`);
