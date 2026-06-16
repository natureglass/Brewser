import { type HtmlElement } from '../html/html-parser.js';
import { LiveElement } from './live-dom.js';
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
export declare function populateLiveRoot(parsed: HtmlElement): Map<HtmlElement, LiveElement>;
/**
 * Populate an arbitrary `LiveElement` root (not just the singleton
 * `getLiveRoot()`) from a parsed HtmlElement tree. Mirrors
 * {@link populateLiveRoot} but lets the caller own the target — the
 * HTML-driven virtual keyboard (`brewser://.../keyboard.html`) parses
 * into a SEPARATE root that the engine paints below
 * `KEYBOARD_LAYOUT.topY` while the host page stays untouched.
 *
 * `scope` (optional) is a CSS scope class. When supplied, the target
 * root gets `scope` added to its class list, AND every parsed `<style>`
 * block has its selectors rewritten via {@link scopeCssToSelector} so
 * its rules only match descendants of (or the root itself with class
 * `scope`). This prevents the keyboard's CSS from bleeding into the
 * host page's cascade (the kb's `body { … }` rule otherwise wins over
 * the host's via source-order, since the kb style sheets register
 * later).
 */
export declare function populateRootFromTree(target: LiveElement, parsed: HtmlElement, scope?: string): Map<HtmlElement, LiveElement>;
/** Parse an HTML fragment string and append the resulting LiveElements
 * as children of `target`. Backs the `element.innerHTML = '<markup>'`
 * setter so page scripts can build structured DOM (e.g. an audio
 * player's playlist rows: `<span class="num">01</span><strong>Title
 * </strong><span>subtitle</span>`). The caller clears `target`'s
 * existing children first. Reuses the same HtmlElement→LiveElement
 * converter the initial page load uses, so cascade matching, text
 * flow, and nested elements behave identically. */
export declare function parseFragmentInto(target: LiveElement, html: string): void;
/** Drive the async fetches for `<link rel=stylesheet>` placeholders
 * that `populateRootFromTree`'s head-walk already attached + slot-
 * reserved against the live cascade. When each fetch resolves, the
 * loader assigns the placeholder's textContent — that triggers
 * `registerStyleSheet` at the pre-reserved DOM-order slot, so the
 * external sheet cascades exactly where it would have appeared had
 * it loaded synchronously, regardless of whether subsequent inline
 * `<style>` blocks already registered.
 *
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
export declare function loadHeadLinkStylesheets(parsed: HtmlElement, pageUrl: string): Promise<void>;
export declare function isExternalCssLoading(): boolean;
export declare function loadHeadLinkStylesheetsWithFlag(parsed: HtmlElement, pageUrl: string): Promise<void>;
export declare function loadIframeContents(iframeEl: LiveElement, src: string): void;
export declare function scopeCssToSelector(cssText: string, scope: string): string;
//# sourceMappingURL=html-to-live.d.ts.map