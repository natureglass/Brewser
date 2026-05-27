/**
 * Tiny tag-soup tolerant HTML parser.
 *
 * Scope: enough to feed the layout/paint stages of the milestone C
 * pipeline. Not standards-compliant — no scripts, no DOM, no custom
 * elements, no namespaces, no <template> contents. Lowercase tag names.
 * Errors recover by advancing one character.
 *
 *   - Comments and DOCTYPEs are skipped.
 *   - Raw-text elements (script/style/noscript/iframe/template) are
 *     consumed wholesale until their close tag and produce no children.
 *   - Void elements never push a stack frame.
 *   - Reopening certain block elements (p, li, dt, dd, tr, td, th)
 *     auto-closes the previous instance — the most common tag-soup case.
 *   - Whitespace-only text nodes are dropped at parse time.
 *
 * The synthetic root is `#document` with all top-level nodes as children.
 */

export type HtmlNode = HtmlElement | HtmlText;

export interface HtmlElement {
	type: 'element';
	tag: string;
	attrs: Record<string, string>;
	children: HtmlNode[];
	/** Back-pointer set by `attachParents` after the tree is built. */
	parent?: HtmlElement | null;
}

export interface HtmlText {
	type: 'text';
	text: string;
}

const VOID_ELEMENTS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_ELEMENTS = new Set([
	'script', 'style', 'noscript', 'iframe', 'template',
]);

// Subset of RAW_TEXT_ELEMENTS whose content is captured as a verbatim text
// node child rather than discarded. CSS apply reads `<style>` bodies;
// the page-script runner reads `<script>` bodies.
const CAPTURE_RAW_TEXT = new Set(['style', 'script']);

// On reopen of any of these, close the previous instance first.
const AUTO_CLOSE_ON_REOPEN = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th']);

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	mdash: '—',
	ndash: '–',
	hellip: '…',
	middot: '·',
	bull: '•',
	laquo: '«',
	raquo: '»',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	larr: '←',
	uarr: '↑',
	rarr: '→',
	darr: '↓',
	harr: '↔',
	times: '×',
	divide: '÷',
	plusmn: '±',
	deg: '°',
	copy: '©',
	reg: '®',
	trade: '™',
	infin: '∞',
	asymp: '≈',
	ne: '≠',
	le: '≤',
	ge: '≥',
	cent: '¢',
	pound: '£',
	yen: '¥',
	euro: '€',
	nbsp: ' ',
};

export function parseHtml(source: string): HtmlElement {
	const root: HtmlElement = {
		type: 'element',
		tag: '#document',
		attrs: {},
		children: [],
	};
	const stack: HtmlElement[] = [root];
	let i = 0;
	let textRun = '';

	const flushText = () => {
		if (!textRun) return;
		// Anywhere inside a <pre> (even a child element like <code>),
		// preserve whitespace + newlines verbatim. Outside <pre>, collapse
		// runs of whitespace to a single space and drop whitespace-only
		// text nodes.
		const inPre = stack.some((el) => el.tag === 'pre');
		if (inPre) {
			stack[stack.length - 1].children.push({
				type: 'text',
				text: decodeEntities(textRun),
			});
		} else if (/\S/.test(textRun)) {
			stack[stack.length - 1].children.push({
				type: 'text',
				text: decodeEntities(textRun.replace(/\s+/g, ' ')),
			});
		}
		textRun = '';
	};

	while (i < source.length) {
		if (source[i] !== '<') {
			textRun += source[i++];
			continue;
		}

		// Stray '<' with no terminating '>' — treat as text.
		const possibleTagEnd = findTagEnd(source, i);
		if (possibleTagEnd === -1 && source[i + 1] !== '!') {
			textRun += source[i++];
			continue;
		}

		flushText();

		if (source.startsWith('<!--', i)) {
			const end = source.indexOf('-->', i + 4);
			i = end === -1 ? source.length : end + 3;
			continue;
		}
		if (source[i + 1] === '!') {
			// DOCTYPE / CDATA / unknown declaration — skip to '>'.
			const end = source.indexOf('>', i);
			i = end === -1 ? source.length : end + 1;
			continue;
		}
		if (source[i + 1] === '/') {
			const end = source.indexOf('>', i);
			if (end === -1) {
				i = source.length;
				break;
			}
			const name = source.slice(i + 2, end).trim().toLowerCase();
			i = end + 1;
			for (let depth = stack.length - 1; depth > 0; depth--) {
				if (stack[depth].tag === name) {
					stack.length = depth;
					break;
				}
			}
			continue;
		}

		const tagEnd = possibleTagEnd;
		const rawBody = source.slice(i + 1, tagEnd);
		i = tagEnd + 1;
		const selfClosing = rawBody.endsWith('/');
		const parsed = parseTagBody(selfClosing ? rawBody.slice(0, -1) : rawBody);
		if (!parsed) continue;
		const { tag, attrs } = parsed;

		if (AUTO_CLOSE_ON_REOPEN.has(tag)) {
			for (let depth = stack.length - 1; depth > 0; depth--) {
				if (stack[depth].tag === tag) {
					stack.length = depth;
					break;
				}
			}
		}

		const element: HtmlElement = {
			type: 'element',
			tag,
			attrs,
			children: [],
		};
		stack[stack.length - 1].children.push(element);

		if (selfClosing || VOID_ELEMENTS.has(tag)) continue;

		if (RAW_TEXT_ELEMENTS.has(tag)) {
			const lowered = source.toLowerCase();
			const closer = `</${tag}`;
			const closeIdx = lowered.indexOf(closer, i);
			// `<style>` content needs to survive parsing so the CSS layer
			// can pick it up. Other raw-text tags (script/noscript/iframe/
			// template) are still discarded — we have no use for them.
			if (CAPTURE_RAW_TEXT.has(tag)) {
				const rawEnd = closeIdx === -1 ? source.length : closeIdx;
				const rawText = source.slice(i, rawEnd);
				if (rawText) {
					element.children.push({ type: 'text', text: rawText });
				}
			}
			if (closeIdx === -1) {
				i = source.length;
			} else {
				const tagCloseEnd = source.indexOf('>', closeIdx);
				i = tagCloseEnd === -1 ? source.length : tagCloseEnd + 1;
			}
			continue;
		}

		stack.push(element);
	}
	flushText();
	attachParents(root, null);
	return root;
}

function attachParents(element: HtmlElement, parent: HtmlElement | null): void {
	element.parent = parent;
	for (const child of element.children) {
		if (child.type === 'element') attachParents(child, element);
	}
}

function findTagEnd(source: string, start: number): number {
	let inSingle = false;
	let inDouble = false;
	for (let j = start + 1; j < source.length; j++) {
		const c = source[j];
		if (inSingle) {
			if (c === "'") inSingle = false;
		} else if (inDouble) {
			if (c === '"') inDouble = false;
		} else if (c === "'") {
			inSingle = true;
		} else if (c === '"') {
			inDouble = true;
		} else if (c === '>') {
			return j;
		}
	}
	return -1;
}

function parseTagBody(
	body: string,
): { tag: string; attrs: Record<string, string> } | null {
	const trimmed = body.trim();
	if (!trimmed) return null;
	const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed);
	if (!tagMatch) return null;
	const tag = tagMatch[1].toLowerCase();
	let p = tagMatch[0].length;
	const attrs: Record<string, string> = {};

	while (p < trimmed.length) {
		while (p < trimmed.length && /\s/.test(trimmed[p])) p++;
		if (p >= trimmed.length) break;
		const nameMatch = /^([a-zA-Z_:][a-zA-Z0-9_:.\-]*)/.exec(trimmed.slice(p));
		if (!nameMatch) {
			p++;
			continue;
		}
		const name = nameMatch[1].toLowerCase();
		p += nameMatch[0].length;
		while (p < trimmed.length && /\s/.test(trimmed[p])) p++;
		if (trimmed[p] !== '=') {
			attrs[name] = '';
			continue;
		}
		p++;
		while (p < trimmed.length && /\s/.test(trimmed[p])) p++;
		let value: string;
		if (trimmed[p] === '"' || trimmed[p] === "'") {
			const quote = trimmed[p];
			const end = trimmed.indexOf(quote, p + 1);
			if (end === -1) {
				value = trimmed.slice(p + 1);
				p = trimmed.length;
			} else {
				value = trimmed.slice(p + 1, end);
				p = end + 1;
			}
		} else {
			const m = /^[^\s>]*/.exec(trimmed.slice(p));
			value = m ? m[0] : '';
			p += value.length;
		}
		attrs[name] = decodeEntities(value);
	}
	return { tag, attrs };
}

function decodeEntities(input: string): string {
	if (!input.includes('&')) return input;
	return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body[0] === '#') {
			const isHex = body[1] === 'x' || body[1] === 'X';
			const codePoint = isHex
				? parseInt(body.slice(2), 16)
				: parseInt(body.slice(1), 10);
			if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
				return whole;
			}
			try {
				return String.fromCodePoint(codePoint);
			} catch (_) {
				return whole;
			}
		}
		const mapped = NAMED_ENTITIES[body.toLowerCase()];
		return mapped ?? whole;
	});
}

/**
 * Find the first `<title>` element and return its concatenated text content,
 * with whitespace collapsed and trimmed. Returns `null` if no title is
 * present or it contains only whitespace. Used by the shell to surface a
 * human-readable label for history + bookmark entries.
 */
export function extractTitle(root: HtmlElement): string | null {
	const found = findFirstTitle(root);
	if (!found) return null;
	let text = '';
	const visit = (node: HtmlNode) => {
		if (node.type === 'text') {
			text += node.text;
		} else {
			for (const child of node.children) visit(child);
		}
	};
	for (const child of found.children) visit(child);
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed || null;
}

function findFirstTitle(element: HtmlElement): HtmlElement | null {
	if (element.tag === 'title') return element;
	for (const child of element.children) {
		if (child.type !== 'element') continue;
		const hit = findFirstTitle(child);
		if (hit) return hit;
	}
	return null;
}

export function countNodes(root: HtmlElement): { elements: number; texts: number } {
	let elements = 0;
	let texts = 0;
	const visit = (node: HtmlNode) => {
		if (node.type === 'text') {
			texts++;
		} else {
			elements++;
			for (const child of node.children) visit(child);
		}
	};
	visit(root);
	return { elements, texts };
}
