// Parser adapter: grafts the parsed HtmlElement tree into the
// singleton LiveRoot used as `document.body`. Page scripts running
// concurrently see `document.body` already populated with the parsed
// page. Also returns the parsed→live map the shell uses to wire
// runner-managed `<canvas>` offscreens into the live tree.

import { type HtmlElement, type HtmlNode, parseHtml } from '../html/html-parser.js';
import { getLiveRoot, LiveElement } from './live-dom.js';

/** Tags dropped during conversion. <script> is also dropped — page-
 * script execution still walks the parsed HtmlElement tree directly
 * via runPageScripts. */
const SKIP_TAGS = new Set([
	'head', 'title', 'meta', 'link', 'noscript', 'template', 'script',
]);

/** Graft the converted content into the existing singleton
 * `document.body` (LiveRoot). The caller is responsible for calling
 * `resetLiveRoot()` beforehand if it wants a clean slate.
 *
 * Why graft instead of replace the root? Page scripts persist their
 * `document.body` reference across calls; replacing the singleton would
 * break them. Grafting children + applying the source body's attrs to
 * the existing root preserves identity.
 *
 * Returns the parsed→live mapping so the caller can wire `<canvas>`
 * offscreens (created by `runPageScripts` from the parsed tree) into
 * the corresponding live elements. */
export function populateLiveRoot(parsed: HtmlElement): Map<HtmlElement, LiveElement> {
	const liveRoot = getLiveRoot();
	const byParsed = new Map<HtmlElement, LiveElement>();
	// Step 1: register every `<style>` block in the parsed tree, including
	// any in `<head>`. The body walk below only reaches body's descendants,
	// but real browsers register stylesheets from `<head>` and `<link
	// rel=stylesheet>` too. Attach the style LiveElements as `display:none`
	// children of the live root so their lifecycle matches the page (they
	// get cleaned up when `resetLiveRoot` runs on the next navigation).
	attachHeadStyles(parsed, liveRoot);
	const sourceBody = findBody(parsed);
	if (sourceBody) {
		// Apply the source <body>'s attrs to the existing live root so
		// `body { ... }` rules in inline styles + `class="..."` /
		// `style="..."` on body land correctly.
		for (const [name, value] of Object.entries(sourceBody.attrs)) {
			liveRoot.setAttribute(name, value);
		}
		// Map the source body to the live root so canvas wiring can find
		// it (rare — canvases are usually deeper, but harmless).
		byParsed.set(sourceBody, liveRoot);
		for (const child of sourceBody.children) {
			appendConverted(liveRoot, child, byParsed);
		}
	} else {
		// No <body> — append every non-skipped top-level child to the
		// live root directly.
		for (const child of parsed.children) {
			appendConverted(liveRoot, child, byParsed);
		}
	}
	return byParsed;
}

/** Parse an HTML fragment string and append the resulting LiveElements
 * as children of `target`. Backs the `element.innerHTML = '<markup>'`
 * setter so page scripts can build structured DOM (e.g. an audio
 * player's playlist rows: `<span class="num">01</span><strong>Title
 * </strong><span>subtitle</span>`). The caller clears `target`'s
 * existing children first. Reuses the same HtmlElement→LiveElement
 * converter the initial page load uses, so cascade matching, text
 * flow, and nested elements behave identically. */
export function parseFragmentInto(target: LiveElement, html: string): void {
	const root = parseHtml(html);
	const byParsed = new Map<HtmlElement, LiveElement>();
	for (const child of root.children) {
		appendConverted(target, child, byParsed);
	}
}

/** Walk the parsed tree (skipping `<body>` since its descendants are
 * processed by the main converter) and register every `<style>` block
 * we find with the live cascade. Each style becomes a `display:none`
 * LiveElement child of the live root so `resetLiveRoot` on the next
 * navigation tears it down cleanly. */
function attachHeadStyles(node: HtmlElement, liveRoot: LiveElement): void {
	const visit = (n: HtmlElement) => {
		if (n.tag === 'body') return; // body styles register via the normal walk
		if (n.tag === 'style') {
			let cssText = '';
			for (const child of n.children) {
				if (child.type === 'text') cssText += child.text;
			}
			if (!cssText) return;
			const styleEl = new LiveElement('style');
			styleEl.style.display = 'none';
			liveRoot.appendChild(styleEl);
			styleEl.textContent = cssText; // triggers registerStyleSheet
			return;
		}
		for (const child of n.children) {
			if (child.type === 'element') visit(child);
		}
	};
	visit(node);
}

/** Walk the parsed tree's `<head>` for `<link rel="stylesheet" href=…>`,
 * fetch each URL, and graft the result into the live cascade as a
 * `display:none` `<style>` LiveElement (same path as inline styles).
 * Async — runs after `populateLiveRoot` so the page renders immediately
 * with whatever inline `<style>` and UA-default rules it has, then
 * re-renders as each external sheet arrives. `pageUrl` is used to
 * resolve protocol-relative + root-relative hrefs.
 *
 * Sheets with a `media="..."` attribute that includes neither `all`
 * nor `screen` nor `handheld` are skipped (we treat the Switch as
 * 'screen/handheld'). Missing `media` attr → applies (CSS spec default).
 *
 * No retries, no caching across navigations — `clearGifAnimations` /
 * `resetLiveRoot` already wipe the old page's cascade so a re-load
 * just re-fetches. Per-sheet failures are silent (logged via the img
 * diag log for visibility). */
export async function loadHeadLinkStylesheets(
	parsed: HtmlElement,
	pageUrl: string,
): Promise<void> {
	const links: { href: string; media: string | undefined }[] = [];
	const visit = (n: HtmlElement) => {
		if (n.tag === 'body') return;
		if (n.tag === 'link') {
			const rel = (n.attrs.rel || '').toLowerCase();
			const href = n.attrs.href;
			if (rel.split(/\s+/).includes('stylesheet') && href) {
				links.push({ href, media: n.attrs.media });
			}
			return;
		}
		for (const child of n.children) {
			if (child.type === 'element') visit(child);
		}
	};
	visit(parsed);
	if (links.length === 0) return;
	const liveRoot = getLiveRoot();
	// Fire all fetches in parallel — each registers its sheet as soon as
	// it arrives, so the page progressively gains style.
	await Promise.all(links.map(async ({ href, media }) => {
		if (media) {
			const m = media.toLowerCase();
			const tokens = m.split(',').map((s) => s.trim());
			const matches = tokens.some((t) => t === '' || t === 'all' || t === 'screen' || t === 'handheld');
			if (!matches) return;
		}
		let absolute: string;
		try { absolute = new URL(href, pageUrl).toString(); }
		catch (_) { return; }
		let cssText: string;
		try {
			const res = await fetch(absolute);
			if (!res.ok) return;
			cssText = await res.text();
		} catch (_) {
			return;
		}
		if (!cssText) return;
		const styleEl = new LiveElement('style');
		styleEl.style.display = 'none';
		liveRoot.appendChild(styleEl);
		styleEl.textContent = cssText; // triggers registerStyleSheet
	}));
}

/** Locate the first `<body>` in the parsed tree. Most pages have one;
 * fragment-only sources don't. */
function findBody(node: HtmlElement): HtmlElement | null {
	if (node.tag === 'body') return node;
	for (const child of node.children) {
		if (child.type !== 'element') continue;
		const found = findBody(child);
		if (found) return found;
	}
	return null;
}

/** Convert one HtmlElement (recursively) into a LiveElement, recording
 * each (parsed → live) mapping in `byParsed`. */
function convertElement(
	source: HtmlElement,
	byParsed: Map<HtmlElement, LiveElement>,
): LiveElement {
	const live = new LiveElement(source.tag);
	byParsed.set(source, live);
	for (const [name, value] of Object.entries(source.attrs)) {
		live.setAttribute(name, value);
	}
	if (source.tag === 'style') {
		let cssText = '';
		for (const child of source.children) {
			if (child.type === 'text') cssText += child.text;
		}
		if (cssText) live.textContent = cssText;
		return live;
	}
	for (const child of source.children) {
		appendConverted(live, child, byParsed);
	}
	return live;
}

/** Append a converted child to `parent`. Handles the text / element
 * branch and the SKIP_TAGS filter. Text-only whitespace already culled
 * by the parser; empty strings still hit here from inline-only nodes,
 * dropped silently. */
function appendConverted(
	parent: LiveElement,
	source: HtmlNode,
	byParsed: Map<HtmlElement, LiveElement>,
): void {
	if (source.type === 'text') {
		if (!source.text) return;
		const textNode = new LiveElement('#text');
		textNode.data = source.text;
		parent.appendChild(textNode);
		return;
	}
	if (SKIP_TAGS.has(source.tag)) return;
	parent.appendChild(convertElement(source, byParsed));
}
