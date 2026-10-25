// Unit tests for asset-name sanitization and by-name matching.

import { sanitizeAssetName } from "../src/util/media.ts";
import { findAsset, normalizeName } from "../src/ai/tools/connect_pins.ts";
import type { ImageAsset } from "../src/state/types.ts";

const NNBSP = String.fromCharCode(0x202f); // narrow no-break space
const NBSP = String.fromCharCode(0x00a0); // no-break space
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const BOM = String.fromCharCode(0xfeff); // zero-width no-break space / BOM
const RLM = String.fromCharCode(0x200f); // right-to-left mark

let passed = 0;
function eq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`FAIL: ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
	passed++;
}
function ok(cond: boolean, msg: string): void {
	eq(cond, true, msg);
}

// --- sanitizeAssetName: fold exotic whitespace, drop format marks, trim. ---
eq(sanitizeAssetName(`Screenshot 2026-06-20 at 11.04.29${NNBSP}PM`), "Screenshot 2026-06-20 at 11.04.29 PM", "narrow no-break space -> plain space");
eq(sanitizeAssetName(`x${NBSP}y`), "x y", "no-break space -> plain space");
eq(sanitizeAssetName(`a${ZWSP}b${BOM}c${RLM}`), "abc", "zero-width / bidi marks removed");
eq(sanitizeAssetName("  spaced   out  "), "spaced out", "runs collapsed and trimmed");
eq(sanitizeAssetName("plain-name_1.2"), "plain-name_1.2", "ordinary name untouched");
eq(sanitizeAssetName(`${ZWSP}${BOM}`), "", "all-junk name collapses to empty (caller supplies a fallback)");

// --- findAsset / normalizeName: match the exotic name with a plain one. ---
{
	const assets: ImageAsset[] = [
		// Simulates a legacy asset stored *before* upload-time sanitization.
		{ id: "a_1", name: `Screenshot 2026-06-20 at 11.04.29${NNBSP}PM`, mediaType: "image/png", dataUrl: "", width: 952, height: 826, source: "upload", kind: "image" },
		{ id: "a_2", name: "clip", mediaType: "video/mp4", dataUrl: "", width: 640, height: 360, source: "upload", kind: "video" },
	];
	ok(!!findAsset(assets, "Screenshot 2026-06-20 at 11.04.29 PM"), "exotic-space name matched with a plain space");
	eq(findAsset(assets, "Screenshot 2026-06-20 at 11.04.29 PM")?.id, "a_1", "matched the right asset");
	eq(findAsset(assets, "a_1")?.id, "a_1", "match by id");
	eq(findAsset(assets, "  CLIP ")?.id, "a_2", "trim + case-insensitive name match");
	eq(findAsset(assets, "nope"), undefined, "unknown name => undefined");
	eq(normalizeName(`A${NNBSP}B`), "a b", "normalizeName folds whitespace and lowercases");
}

console.log(`ok - ${passed} assertions passed`);
