// Material Design Icons (https://pictogrammers.com/library/mdi/), inlined as
// SVG path data. We embed only the handful of glyphs the UI uses so the
// single-file bundle stays self-contained -- no icon font, no network request.
// Each entry is a 24x24 viewBox path; icon() builds an <svg> whose fill is
// `currentColor`, so an icon takes the text colour of whatever it sits in.

const SVG_NS = "http://www.w3.org/2000/svg";

// Path data lifted verbatim from @mdi/js (Apache-2.0). Keys are local,
// purpose-named aliases for the MDI glyph noted in the comment.
const PATHS = {
	pause: "M14,19H18V5H14M6,19H10V5H6V19Z", // mdiPause
	play: "M8,5.14V19.14L19,12.14L8,5.14Z", // mdiPlay
	restart: "M12,4C14.1,4 16.1,4.8 17.6,6.3C20.7,9.4 20.7,14.5 17.6,17.6C15.8,19.5 13.3,20.2 10.9,19.9L11.4,17.9C13.1,18.1 14.9,17.5 16.2,16.2C18.5,13.9 18.5,10.1 16.2,7.7C15.1,6.6 13.5,6 12,6V10.6L7,5.6L12,0.6V4M6.3,17.6C3.7,15 3.3,11 5.1,7.9L6.6,9.4C5.5,11.6 5.9,14.4 7.8,16.2C8.3,16.7 8.9,17.1 9.6,17.4L9,19.4C8,19 7.1,18.4 6.3,17.6Z", // mdiRestart
	download: "M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z", // mdiDownload
	camera: "M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z", // mdiCamera
	wrench: "M22.7,19L13.6,9.9C14.5,7.6 14,4.9 12.1,3C10.1,1 7.1,0.6 4.7,1.7L9,6L6,9L1.6,4.7C0.4,7.1 0.9,10.1 2.9,12.1C4.8,14 7.5,14.5 9.8,13.6L18.9,22.7C19.3,23.1 19.9,23.1 20.3,22.7L22.6,20.4C23.1,20 23.1,19.3 22.7,19Z", // mdiWrench
	check: "M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z", // mdiCheck
	close: "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z", // mdiClose
	refresh: "M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z", // mdiRefresh
	eye: "M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17Z", // mdiEye
	undo: "M12.5,8C9.85,8 7.45,8.99 5.6,10.6L2,7V16H11L7.38,12.38C8.77,11.22 10.54,10.5 12.5,10.5C16.04,10.5 19.05,12.81 20.1,16L22.47,15.22C21.08,11.03 17.15,8 12.5,8Z", // mdiUndo
	redo: "M18.4,10.6C16.55,8.99 14.15,8 11.5,8C6.85,8 2.92,11.03 1.54,15.22L3.9,16C4.95,12.81 7.95,10.5 11.5,10.5C13.45,10.5 15.23,11.22 16.62,12.38L13,16H22V7L18.4,10.6Z", // mdiRedo
	pencil: "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z", // mdiPencil
	trash: "M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6M9,8V17H11V8H9M13,8V17H15V8H13Z", // mdiDeleteOutline
} as const;

export type IconName = keyof typeof PATHS;

export interface IconOpts {
	/** Edge length in px (the glyph is square). Defaults to 18. */
	size?: number;
	/** Extra class(es) added alongside `icon-svg`. */
	class?: string;
}

/** Build an inline SVG element for a Material Design Icon. */
export function icon(name: IconName, opts: IconOpts = {}): SVGSVGElement {
	const size = opts.size ?? 18;
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("class", opts.class ? `icon-svg ${opts.class}` : "icon-svg");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", PATHS[name]);
	path.setAttribute("fill", "currentColor");
	svg.appendChild(path);
	return svg;
}
