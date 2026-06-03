// Parser adapter: grafts the parsed HtmlElement tree into the
// singleton LiveRoot used as `document.body`. Page scripts running
// concurrently see `document.body` already populated with the parsed
// page. Also returns the parsed→live map the shell uses to wire
// runner-managed `<canvas>` offscreens into the live tree.

import { type HtmlElement, type HtmlNode, parseHtml } from '../html/html-parser.js';
import { bumpLiveTreeVersion, getLiveRoot, LiveElement } from './live-dom.js';
import { resetLiveOverlayCache } from './live-overlay.js';
import { requestFullRepaint } from './live-paint-control.js';

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
		// An external sheet changes the global cascade — every element's
		// computed style is now potentially different. The default
		// repaint path (patchLiveDirtyRegions) would try a targeted
		// patch pinned to the cached pre-CSS body box, truncating the
		// new (usually taller) layout and leaving stale pre-CSS pixels
		// outside the old clip rect. Nuke the overlay cache so the next
		// paint takes the full-rebuild branch with the new cascade.
		resetLiveOverlayCache();
		requestFullRepaint();
	}));
}

/** True while at least one external <link rel="stylesheet"> fetch is
 * still in flight. The shell drives a "Loading styles…" overlay on
 * top of the rendered page while this is true — without it, http(s)
 * pages flash their pre-CSS state for several seconds (DDG html mode
 * is the headline case: ~3s for the 100KB sheet + ~3s for re-layout
 * after the cascade lands).
 *
 * Counter not boolean so a navigation that starts before the previous
 * one's CSS arrives doesn't flip the flag false prematurely. */
let __externalCssLoadingCount = 0;
export function isExternalCssLoading(): boolean {
	return __externalCssLoadingCount > 0;
}
export async function loadHeadLinkStylesheetsWithFlag(
	parsed: HtmlElement,
	pageUrl: string,
): Promise<void> {
	__externalCssLoadingCount++;
	try {
		await loadHeadLinkStylesheets(parsed, pageUrl);
	} finally {
		__externalCssLoadingCount--;
	}
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

// =========================================================================
// `<iframe>` content loader — Tier 1B inline-preview embed.
//
// Fetches the iframe's `src` URL as HTML, parses it, and grafts the body's
// children as children of the iframe element. Scripts are skipped; styles
// get their selectors scoped to the iframe's subtree only so embedded
// CSS doesn't pollute the parent page's cascade. Sandbox / allow / CSP
// attributes are parsed by the engine but NOT enforced — every iframe
// renders as if same-origin with the parent.
//
// Per-iframe state lives on the LiveElement via private underscore-
// prefixed fields (`_iframeLoadInFlight`, `_iframeLoadFailed`,
// `_iframeScopeClass`) so a re-render that revisits the same element
// doesn't double-fetch.
// =========================================================================

let __iframeScopeCounter = 0;

interface IframeStateFields {
	_iframeLoadInFlight?: boolean;
	_iframeLoadFailed?: boolean;
	_iframeScopeClass?: string;
}

export function loadIframeContents(iframeEl: LiveElement, src: string): void {
	if (!src) return;
	const state = iframeEl as unknown as IframeStateFields;
	if (state._iframeLoadInFlight) return;
	state._iframeLoadInFlight = true;
	state._iframeLoadFailed = false;
	// Generate a unique scope class. Mark the iframe element with it so
	// any `<style>` inside the iframe — whose selectors we'll prefix with
	// `.iframe-scope-N ` — only matches descendants of THIS iframe.
	const scope = '__iframe-scope-' + (++__iframeScopeCounter);
	state._iframeScopeClass = scope;
	const existing = iframeEl.getAttribute('class') ?? '';
	iframeEl.setAttribute('class', existing ? existing + ' ' + scope : scope);
	(async () => {
		try {
			const res = await fetch(src);
			if (!res.ok) {
				state._iframeLoadFailed = true;
				return;
			}
			const html = await res.text();
			const parsed = parseHtml(html);
			const body = findBody(parsed) ?? parsed;
			// Clear any prior children (e.g. user-authored noscript fallback
			// markup between <iframe>…</iframe> tags — though our parser
			// treats iframe as raw-text so this is usually a no-op).
			while (iframeEl.children.length > 0) {
				iframeEl.removeChild(iframeEl.children[0]);
			}
			const byParsed = new Map<HtmlElement, LiveElement>();
			// Step 1: graft the iframe's <head> <style> blocks (scoped) as
			// children of the iframe element so the cascade sees them.
			// Without this, an iframe's own styling — typically defined in
			// `<head>` — never reaches the cascade and rules like
			// `.right { color: ... }` silently drop.
			attachIframeHeadStyles(parsed, iframeEl, scope);
			// Step 2: graft the body's children. Scripts skipped; styles
			// scoped (same path as head styles for any `<style>` that's
			// authored inside <body>, which is rare but valid HTML).
			for (const child of body.children) {
				appendIframeChild(iframeEl, child, byParsed, scope);
			}
		} catch (_) {
			state._iframeLoadFailed = true;
		} finally {
			state._iframeLoadInFlight = false;
			// Lesson from bg-image fix: bumpLiveTreeVersion alone doesn't
			// wake the paint loop on idle pages. Pair with requestFullRepaint
			// so the iframe content shows up without requiring a user scroll.
			bumpLiveTreeVersion();
			requestFullRepaint();
		}
	})();
}

/** Walk the iframe's parsed tree for `<head>` `<style>` elements,
 * scope their cssText, and graft them as `display:none` children of
 * the iframe element so the cascade picks them up. The body's own
 * `<style>` children (if any) get grafted by the normal walk. */
function attachIframeHeadStyles(node: HtmlElement, iframeEl: LiveElement, scope: string): void {
	const visit = (n: HtmlElement) => {
		if (n.tag === 'body') return;
		if (n.tag === 'style') {
			let cssText = '';
			for (const child of n.children) {
				if (child.type === 'text') cssText += child.text;
			}
			if (!cssText) return;
			const styleEl = new LiveElement('style');
			styleEl.style.display = 'none';
			iframeEl.appendChild(styleEl);
			styleEl.textContent = scopeIframeCss(cssText, scope);
			return;
		}
		for (const child of n.children) {
			if (child.type === 'element') visit(child);
		}
	};
	visit(node);
}

/** Variant of `appendConverted` that knows about iframe scoping. The
 * caller passes a `scope` class that will be used to rewrite any
 * `<style>` element's selectors so they only match descendants of the
 * iframe. `<script>` is dropped (Tier 1B safety). */
function appendIframeChild(
	parent: LiveElement,
	source: HtmlNode,
	byParsed: Map<HtmlElement, LiveElement>,
	scope: string,
): void {
	if (source.type === 'text') {
		if (!source.text) return;
		const textNode = new LiveElement('#text');
		textNode.data = source.text;
		parent.appendChild(textNode);
		return;
	}
	if (source.tag === 'script') return; // never run iframe scripts
	if (SKIP_TAGS.has(source.tag) && source.tag !== 'style') return;
	parent.appendChild(convertIframeElement(source, byParsed, scope));
}

function convertIframeElement(
	source: HtmlElement,
	byParsed: Map<HtmlElement, LiveElement>,
	scope: string,
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
		if (cssText) live.textContent = scopeIframeCss(cssText, scope);
		return live;
	}
	for (const child of source.children) {
		appendIframeChild(live, child, byParsed, scope);
	}
	return live;
}

/** Prefix every selector in `cssText` with `.${scope} ` so the rule
 * only matches descendants of the iframe. This is intentionally
 * unsophisticated — splits each comma-separated selector list and
 * prepends to each segment. It handles ~95% of real-world iframe CSS
 * (the common cases: tag, class, id, descendant, child combinators).
 *
 * Known gaps:
 *   - Selectors that target `html` / `body` won't match (iframe has no
 *     own body/html element — its content is grafted directly under
 *     the iframe). Acceptable for Tier 1B; future work could rewrite
 *     `body` → `.${scope}` to handle this.
 *   - Selectors at media query / @supports / @keyframes boundaries
 *     are NOT rewritten (regex sees them as not inside a selector). The
 *     rules inside the at-rule's block still get matched if the inner
 *     selectors are recognised — but `@media (...) body { ... }` won't
 *     scope. Edge case for the MVP.
 *   - `:root` and `*` selectors get scoped to the iframe, which is
 *     actually closer-to-correct than not scoping them.
 *
 * Operates on the raw cssText pre-parse to keep this independent of
 * css-tree internals. */
/** Rewrite a single trimmed selector to be iframe-scoped:
 *   - `html` / `body` → match the iframe element itself (`.<scope>`).
 *     Without this, an iframe's `body { background: ... }` rule would
 *     never match — the iframe's body content is grafted directly under
 *     the iframe element with no synthetic body wrapper.
 *   - `html body` / `body.foo` → still anchor on the iframe element
 *     (replace the leading body/html with the scope class).
 *   - anything else → prefix with `.<scope> ` (descendant combinator)
 *     so the rule only matches descendants of the iframe. */
function rewriteIframeSelector(sel: string, scope: string): string {
	const scopeSel = '.' + scope;
	// Match a leading `html` or `body` token (possibly with a class /
	// attribute / pseudo suffix glued on), with optional surrounding
	// whitespace. The rest of the selector follows.
	const m = /^(html|body)\b([^,\s>+~]*)(.*)$/.exec(sel);
	if (m) {
		const suffix = m[2]; // .foo / #bar / [attr=…] / :pseudo glued to the tag
		const rest = m[3];
		return scopeSel + suffix + rest;
	}
	return scopeSel + ' ' + sel;
}

function scopeIframeCss(cssText: string, scope: string): string {
	// Walk the text byte-by-byte respecting comments + at-rules + brace
	// nesting so we only rewrite REAL selectors (the thing before each
	// `{` that isn't inside an at-rule prelude or a comment).
	let out = '';
	let i = 0;
	const n = cssText.length;
	while (i < n) {
		const ch = cssText[i];
		// Pass comments through verbatim.
		if (ch === '/' && cssText[i + 1] === '*') {
			const end = cssText.indexOf('*/', i + 2);
			const stop = end < 0 ? n : end + 2;
			out += cssText.slice(i, stop);
			i = stop;
			continue;
		}
		// Pass at-rules through verbatim down to the body. The body's
		// inner rules WILL hit this walker recursively-via-the-loop
		// because we don't consume the inner block — only the prelude.
		if (ch === '@') {
			const blockStart = cssText.indexOf('{', i);
			const semi = cssText.indexOf(';', i);
			if (blockStart < 0 && (semi < 0 || semi >= n)) {
				out += cssText.slice(i);
				i = n;
				continue;
			}
			if (semi >= 0 && (blockStart < 0 || semi < blockStart)) {
				// Statement at-rule (e.g. @import). Pass through.
				out += cssText.slice(i, semi + 1);
				i = semi + 1;
				continue;
			}
			// Block at-rule (@media / @supports / @keyframes …) — emit
			// the prelude + `{` verbatim and continue walking; inner
			// rules get scoped on subsequent iterations.
			out += cssText.slice(i, blockStart + 1);
			i = blockStart + 1;
			continue;
		}
		// Closing brace — pass through.
		if (ch === '}') {
			out += '}';
			i++;
			continue;
		}
		// Find next `{` or `}` — the chunk in between is a selector list.
		let j = i;
		while (j < n) {
			const c = cssText[j];
			if (c === '{' || c === '}' || c === '/' || c === '@') {
				if (c === '/' && cssText[j + 1] === '*') break;
				if (c === '{' || c === '}' || c === '@') break;
			}
			j++;
		}
		if (j >= n || cssText[j] !== '{') {
			// Trailing junk or hit a comment / at-rule. Emit and let
			// the outer loop handle it.
			out += cssText.slice(i, j);
			i = j;
			continue;
		}
		const selectorList = cssText.slice(i, j);
		const trimmed = selectorList.trim();
		if (!trimmed) {
			out += selectorList + '{';
			i = j + 1;
			continue;
		}
		// Re-emit any leading whitespace verbatim, then the scoped
		// selectors, then the `{`.
		const leading = selectorList.match(/^\s*/)?.[0] ?? '';
		const trailing = selectorList.match(/\s*$/)?.[0] ?? '';
		const scoped = trimmed.split(',')
			.map((s) => rewriteIframeSelector(s.trim(), scope))
			.join(', ');
		out += leading + scoped + trailing + '{';
		i = j + 1;
	}
	return out;
}
