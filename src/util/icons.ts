// Icon factory. The actual glyphs (SVG path data) live in the stylesheet
// (src/styles/app.css) as currentColor-tinted CSS masks: a base `.glyph` plus
// one `.icon-<name>` per glyph. This file holds only the list of NAMES and
// builds a <span> wearing the right mask class -- no SVG path data in TypeScript.
//
// To add a glyph: add its name here AND a `.icon-<name>` mask rule in app.css
// (see the existing rules; they are generated from @mdi/js path data, Apache-2.0).

// The available glyph names. Keep in lockstep with the `.icon-<name>` rules in
// app.css. Order is irrelevant.
const ICON_NAMES = ["pause", "play", "restart", "download", "camera", "wrench", "check", "close", "refresh", "eye", "eyeOff", "chevronUp", "chevronDown", "mask", "undo", "redo", "pencil", "trash", "compress"] as const;

export type IconName = (typeof ICON_NAMES)[number];

export interface IconOpts {
	/** Edge length in px (the glyph is square). Defaults to 18. */
	size?: number;
	/** Extra class(es) added alongside `glyph icon-<name>`. */
	class?: string;
}

/** Build an inline icon element: a <span> the stylesheet masks to the glyph and
 * tints with the current text colour. */
export function icon(name: IconName, opts: IconOpts = {}): HTMLSpanElement {
	const size = opts.size ?? 18;
	const span = document.createElement("span");
	span.className = opts.class ? `glyph icon-${name} ${opts.class}` : `glyph icon-${name}`;
	span.style.width = `${size}px`;
	span.style.height = `${size}px`;
	span.setAttribute("aria-hidden", "true");
	return span;
}
