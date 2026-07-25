/**
 * Ambient types for globals the @switch-web/runtime engine installs at
 * RUNTIME. @nx.js/runtime pins `/// <reference no-default-lib>` — this
 * is not a browser, so lib.dom is deliberately absent — but the engine
 * provides a live-DOM `document` shim and an Image pipeline, and the
 * shell (plus the engine's own .d.ts, e.g. `getLoadedImage():
 * HTMLImageElement | null`) reference them by their web names.
 *
 * Keep these MINIMAL: only the surface the shell actually calls. If a
 * member is missing here, check the engine's live-DOM implementation
 * before widening the type — this file documents the shim contract, it
 * does not license assuming browser behaviour.
 */

/** Engine live-DOM element handle as returned by the `document` shim.
 * Structurally loose on purpose — the live-DOM exposes a jQuery-era
 * compat surface that varies by element kind. */
interface ShellLiveElement {
	id: string;
	innerHTML: string;
	tagName?: string;
	parentNode: { removeChild(el: unknown): void } | null;
	appendChild(el: unknown): unknown;
	addEventListener(type: string, cb: (ev?: unknown) => void): void;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	style?: Record<string, string>;
	[key: string]: unknown;
}

/** Decoded image handle from the engine's image pipeline (what
 * `LiveElement.getLoadedImage()` returns; also produced by the style
 * background loader). At runtime this IS an nx.js `Image` (a valid
 * `CanvasImageSource` for the painter) — the web name exists only
 * because the engine's live-DOM types spell it the DOM way. */
interface HTMLImageElement extends Image {
	src: string;
}

/** The engine's modal-layer dialog element (`<browser-modal>` root /
 * `createElement('dialog')`). */
interface HTMLDialogElement extends ShellLiveElement {
	open: boolean;
	close(): void;
	showModal(): void;
}

declare const document: {
	getElementById(id: string): ShellLiveElement | null;
	createElement(tag: string): ShellLiveElement;
	body: ShellLiveElement;
};
