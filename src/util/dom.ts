// Minimal hyperscript-style DOM helpers. No framework: just typed wrappers
// around document.createElement so the UI code stays declarative without a
// virtual DOM or a runtime dependency.

export type Child = Node | string | number | null | undefined | false;

export interface Props {
	class?: string;
	id?: string;
	title?: string;
	type?: string;
	value?: string;
	placeholder?: string;
	href?: string;
	target?: string;
	rel?: string;
	disabled?: boolean;
	hidden?: boolean;
	html?: string;
	text?: string;
	style?: Partial<CSSStyleDeclaration> | string;
	attrs?: Record<string, string | number | boolean | null | undefined>;
	dataset?: Record<string, string>;
	on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Props = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (props.class) node.className = props.class;
	if (props.id) node.id = props.id;
	if (props.title !== undefined) node.title = props.title;
	if (props.type !== undefined) (node as HTMLInputElement).type = props.type;
	if (props.value !== undefined) (node as HTMLInputElement).value = props.value;
	if (props.placeholder !== undefined) (node as HTMLInputElement).placeholder = props.placeholder;
	if (props.href !== undefined) (node as HTMLAnchorElement).href = props.href;
	if (props.target !== undefined) (node as HTMLAnchorElement).target = props.target;
	if (props.rel !== undefined) (node as HTMLAnchorElement).rel = props.rel;
	if (props.disabled !== undefined) (node as HTMLButtonElement).disabled = props.disabled;
	if (props.hidden !== undefined) node.hidden = props.hidden;
	if (props.text !== undefined) node.textContent = props.text;
	if (props.html !== undefined) node.innerHTML = props.html;
	if (props.style) {
		if (typeof props.style === "string") node.setAttribute("style", props.style);
		else Object.assign(node.style, props.style);
	}
	if (props.attrs) {
		for (const [k, v] of Object.entries(props.attrs)) {
			if (v === null || v === undefined || v === false) continue;
			node.setAttribute(k, v === true ? "" : String(v));
		}
	}
	if (props.dataset) {
		for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
	}
	if (props.on) {
		for (const [name, handler] of Object.entries(props.on)) {
			node.addEventListener(name, handler as EventListener);
		}
	}
	append(node, children);
	return node;
}

export function append(parent: Node, children: Child[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}

export function clear(node: Node): void {
	while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(parent: Node, ...children: Child[]): void {
	append(parent, children);
}

/** Replace all children of `node` with `children`. */
export function render(node: Element, ...children: Child[]): void {
	clear(node);
	append(node, children);
}

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
	const found = root.querySelector<T>(sel);
	if (!found) throw new Error(`element not found: ${sel}`);
	return found;
}
