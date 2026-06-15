import { nxScreen } from '@switch-web/runtime';
import type { HtmlElement, HtmlNode } from '../html/html-parser.js';
import { installPointerLockOnDocumentShim } from '../polyfills/pointer-lock.js';
import { setCursorFromCss } from '../input/page-mouse-forwarder.js';
import {
	getLiveRoot, getLiveWindow, getLiveWindowProxy, LiveElement, resetLiveRoot, setOwnerDocument,
	setWebGLBackedPredicate, wrapCanvasCtx2dForRepaint,
} from './live-dom.js';

/**
 * Per-element offscreen drawn into by an inline `<script>`. The layout
 * looks an element up here and, if present, emits an `ImageBox` whose
 * `image` is the offscreen so the painter draws it at the canvas slot.
 *
 * Absent from the map ⇒ no script populated this canvas; the layout
 * falls back to the empty placeholder rectangle.
 */
export type CanvasOutputs = Map<HtmlElement, OffscreenCanvas>;

/**
 * Output of `runPageScripts`. The shell holds onto this so it can
 * resize a target canvas and re-execute the same scripts when entering
 * (or leaving) fullscreen-canvas mode — a responsive script that reads
 * `canvas.width` / `canvas.height` then redraws to fit the new size.
 */
export interface PageScriptContext {
	outputs: CanvasOutputs;
	/** True iff any inline `<script>` body was found. Used by the shell
	 * to decide whether fullscreen-canvas mode is meaningful. */
	hasScripts: boolean;
	/** Re-run every inline script. If `resizes` is given, each named
	 * offscreen is resized first (setting `width`/`height` clears the
	 * canvas per the spec) so the script's redraw lands on a clean
	 * surface at the new dimensions. Returns the same `outputs` map
	 * (offscreen instances are reused). Promise resolves once every
	 * script's async body has settled. */
	rerun(resizes?: Map<HtmlElement, { width: number; height: number }>): Promise<CanvasOutputs>;
	/** First `<canvas>` in document order, or `null` if the page has
	 * none. The fullscreen-canvas mode targets this element. */
	firstCanvas(): HtmlElement | null;
}

/**
 * Run every inline `<script>` body found in the parsed tree, with a
 * minimal `document` shim that lets a script reach the page's
 * `<canvas>` elements by id. Each script body is wrapped in an
 * `AsyncFunction` so it can `await fetch('brewser://history/')` and
 * other promises at the top level. Scripts run sequentially in
 * document order — early scripts can set globals later ones depend
 * on. There's still no event loop: `requestAnimationFrame`,
 * `setTimeout`, etc. aren't provided, so once a script's awaited
 * chain settles its drawing is final.
 *
 * Errors thrown by a script are swallowed (logged via `console.debug`
 * so they don't trigger the nx.js render-mode switch — see the
 * console-error-switches-render-mode memory) so a broken script can't
 * take the rest of the page down with it.
 */
const DEFAULT_CANVAS_WIDTH = 300;
const DEFAULT_CANVAS_HEIGHT = 150;

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as new (
	...argNamesAndBody: string[]
) => AsyncFn;

interface CanvasShim {
	width: number;
	height: number;
	// Loosened to allow `'webgl'`/`'experimental-webgl'` for the WebGL
	// experiments page — return type is `unknown` because inline scripts
	// evaluate untyped at runtime and the concrete shape (GL context vs
	// 2D context vs null) varies per kind. Whether nx.js's OffscreenCanvas
	// actually exposes a GL context is the experiment.
	getContext(kind: string, options?: unknown): unknown;
	// Three.js's `WebGLRenderer` constructor unconditionally registers
	// `webglcontextlost` / `webglcontextrestored` /
	// `webglcontextcreationerror` listeners. We don't support context
	// loss recovery (the shared screen GL context never goes away from
	// our perspective), so these are accepted as no-ops just to keep
	// Three.js's init from throwing "undefined is not a function".
	addEventListener(type: string, listener: unknown, options?: unknown): void;
	removeEventListener(type: string, listener: unknown, options?: unknown): void;
	// Cocos Creator's touchstart callback unconditionally calls
	// `this._canvas.focus()` (touchend/touchmove do not). Switch has no
	// focus model for a render canvas — a no-op is correct behaviour, but
	// the method has to exist or every touchstart throws `TypeError: focus
	// is not a function` and the engine never reaches `_eventTarget.emit`.
	focus(): void;
	/** Web Fullscreen API. Cocos / pvzge and many engines call
	 * `canvas.requestFullscreen()` to enter fullscreen-canvas mode
	 * (so the canvas fills the screen and the chrome strip disappears).
	 * The shell exposes `globalThis.__swbRequestFullscreenCanvas`; this
	 * method awaits it. Resolves immediately if already fullscreen. */
	requestFullscreen(options?: unknown): Promise<void>;
	/** Pages that size a canvas to its CSS box read
	 * `canvas.getBoundingClientRect()` (e.g. an audio visualizer's
	 * `resizeCanvas`). Returns the wired live element's layout box once
	 * layout has run; falls back to the offscreen's pixel dims before
	 * then. */
	getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number };
	/** Some engines (Cocos Creator's index.js) read
	 * `canvas.parentElement.getBoundingClientRect()` to size the canvas
	 * to its container. The CanvasShim is a flat wrapper that doesn't
	 * track DOM parentage, so we return a synthesized parent reporting
	 * the available screen box. */
	readonly parentElement: {
		readonly tagName: string;
		readonly clientWidth: number;
		readonly clientHeight: number;
		readonly offsetWidth: number;
		readonly offsetHeight: number;
		getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number };
		appendChild(child: unknown): unknown;
		removeChild(child: unknown): unknown;
		insertBefore(child: unknown): unknown;
	};
	readonly parentNode: CanvasShim['parentElement'];
	/** Cocos Creator (and other engines) set `canvas.style.cursor =
	 * "url(...) , auto"` after loading a cursor sprite. Switch has no
	 * cursor, but the assignment still has to succeed — a permissive
	 * bag accepts any CSS property write without affecting layout. */
	readonly style: Record<string, unknown>;
}

/** Thin shim returned by `document.getElementById(...)` for inline
 * `<script>` tags. Khronos WebGL conformance tests stash GLSL shader
 * source in `<script id="vshader" type="x-shader/x-vertex">` blocks and
 * read it back via `el.text` / `el.textContent`. Our HTML parser keeps
 * the text-node children, so we just need to forward them through. */
interface ScriptShim {
	id: string;
	type: string;
	/** Resolved-against-pageUrl URL for `<script src="...">`. Empty
	 * string for inline scripts. SystemJS's `prepareImport` reads `.src`
	 * (the IDL form, which auto-resolves) and passes it to `fetch`. */
	src: string;
	integrity: string;
	text: string;
	textContent: string;
	getAttribute(name: string): string | null;
	// SystemJS sets `.sp = true` on each script after scanning. The shim
	// must allow arbitrary mutable property assignment.
	[key: string]: unknown;
}

interface CanvasEntry {
	element: HtmlElement;
	offscreen: OffscreenCanvas;
	shim: CanvasShim;
	/** Set true if the script obtained a WebGL context on this canvas.
	 * After the script body finishes the runner reads the screen GL
	 * bridge framebuffer back into the OffscreenCanvas at this entry's
	 * dimensions so the painter blits the rendered pixels at the
	 * canvas's layout slot. */
	hasWebGL: boolean;
	/** First non-2D context kind the script asked for, used to enforce
	 * the WebGL spec's "one kind per canvas" rule at the per-canvas
	 * layer (the Screen / native EGL layer below is shared and lets
	 * either kind through). Empty until the first `getContext` call. */
	contextKind: '' | 'webgl' | 'webgl2';
}

/**
 * Lazily-acquired shared screen WebGL context. nx.js's `OffscreenCanvas`
 * refuses any context kind other than `'2d'` (see
 * [[nxjs-offscreen-no-webgl]]), so inline `<canvas>` elements cannot own
 * a real WebGL context. The single WebGL surface in nx.js lives on the
 * screen canvas, and the GPU bridge prototype must be enabled for draws
 * to land in a readable framebuffer instead of being software-rasterized
 * straight into cairo. All inline-canvas `getContext('webgl')` calls
 * return this same context; the runner reads the bridge FBO back into
 * each canvas's offscreen between scripts so they appear isolated.
 *
 * Trade-offs of the shared-context model:
 *   - GL state (programs, buffers, textures) leaks across `<canvas>`
 *     elements on the same page. The first script's draws survive into
 *     the second's bridge FBO until the next script's `gl.clear()`.
 *   - The bridge writes its FBO to screen cairo on `gl.clear()`; pages
 *     with WebGL get a brief on-screen flicker during parse, which the
 *     subsequent page paint overwrites.
 *   - Only the recognised shader-name allowlist works (see
 *     [[nxjs-webgl-shader-names]]).
 */
let sharedScreenGL: WebGLRenderingContext | null = null;
let sharedScreenGLAttempted = false;
let sharedScreenGLError: string | null = null;
// WebGL 2 sister of `sharedScreenGL`. Lazily acquired the first time an
// inline `<canvas>` requests context kind `'webgl2'`. Backed by the same
// native EGL/GLES context as the WebGL 1 surface — the JS class identity is
// what differs (Three.js detects WebGL 2 via
// `gl.constructor.name === 'WebGL2RenderingContext'`), so pages must commit
// to one kind per session.
let sharedScreenGL2: WebGLRenderingContext | null = null;
let sharedScreenGL2Attempted = false;
let sharedScreenGL2Error: string | null = null;

function getSharedScreenGL(): WebGLRenderingContext | null {
	if (sharedScreenGLAttempted) return sharedScreenGL;
	sharedScreenGLAttempted = true;
	try {
		const screen = nxScreen();
		// Cast to pick up the local WebGL typings — nx.js's public
		// `.d.ts` types `getContext(string)` as returning `null`
		// regardless.
		const gl = (screen as unknown as {
			getContext(id: 'webgl'): WebGLRenderingContext | null;
		}).getContext('webgl');
		if (!gl) {
			sharedScreenGLError = 'screen.getContext("webgl") returned null';
			return null;
		}
		// Enable the GPU bridge — without it the bridge FBO doesn't
		// exist, textured draws fall through to software cairo, and
		// `gl.readPixels` reads from the default framebuffer (which is
		// not what the script's draws land in). `enableGpuBridgePrototype`
		// returns the resulting enabled state.
		const enableFn = (gl as unknown as {
			enableGpuBridgePrototype?: (b: boolean) => boolean;
		}).enableGpuBridgePrototype;
		if (typeof enableFn !== 'function') {
			sharedScreenGLError = 'enableGpuBridgePrototype is not exposed';
			return null;
		}
		try {
			const ok = enableFn.call(gl, true);
			if (!ok) {
				sharedScreenGLError = 'enableGpuBridgePrototype(true) returned false';
				return null;
			}
		} catch (e) {
			sharedScreenGLError =
				'enableGpuBridgePrototype threw: ' +
				(e instanceof Error ? e.message : String(e));
			return null;
		}
		// Disable the bridge auto-flush. We drive readback ourselves via
		// `gl.readPixels` per rAF tick (and the painter blits the
		// resulting OffscreenCanvas at the canvas's layout slot), so the
		// bridge's automatic 1280×720 readback + write-to-screen on every
		// `gl.clear` is redundant work that also causes a visible
		// fullscreen flash on the first frame (the bridge writes the FBO
		// to screen cairo before the page paint covers it). Best-effort:
		// the function may not exist on older nxjs builds, which is fine.
		const setAutoFlush = (gl as unknown as {
			setBridgeAutoFlush?: (b: boolean) => boolean;
		}).setBridgeAutoFlush;
		if (typeof setAutoFlush === 'function') {
			try {
				setAutoFlush.call(gl, false);
			} catch (_) {
				// non-fatal
			}
		}
		sharedScreenGL = gl;
		(globalThis as { __inlineCanvasGlError?: string | null }).__inlineCanvasGlError = null;
		return gl;
	} catch (err) {
		sharedScreenGLError =
			'screen WebGL acquire threw: ' +
			(err instanceof Error ? err.message : String(err));
		(globalThis as { __inlineCanvasGlError?: string | null }).__inlineCanvasGlError = sharedScreenGLError;
		return null;
	}
}

function getSharedScreenGL2(): WebGLRenderingContext | null {
	if (sharedScreenGL2Attempted) return sharedScreenGL2;
	sharedScreenGL2Attempted = true;
	try {
		const screen = nxScreen();
		const gl = (screen as unknown as {
			getContext(id: 'webgl2'): WebGLRenderingContext | null;
		}).getContext('webgl2');
		if (!gl) {
			sharedScreenGL2Error =
				'screen.getContext("webgl2") returned null';
			return null;
		}
		const enableFn = (gl as unknown as {
			enableGpuBridgePrototype?: (b: boolean) => boolean;
		}).enableGpuBridgePrototype;
		if (typeof enableFn === 'function') {
			try {
				enableFn.call(gl, true);
			} catch (_) {
				// non-fatal
			}
		}
		const setAutoFlush = (gl as unknown as {
			setBridgeAutoFlush?: (b: boolean) => boolean;
		}).setBridgeAutoFlush;
		if (typeof setAutoFlush === 'function') {
			try {
				setAutoFlush.call(gl, false);
			} catch (_) {
				// non-fatal
			}
		}
		sharedScreenGL2 = gl;
		return gl;
	} catch (err) {
		sharedScreenGL2Error =
			'screen WebGL 2 acquire threw: ' +
			(err instanceof Error ? err.message : String(err));
		return null;
	}
}

export interface RunPageScriptsOptions {
	/**
	 * When `false`, `<script>` elements in the tree are ignored entirely:
	 * no collection, no execution. `<canvas>` elements are still
	 * registered so the painter can still draw their (empty) placeholders.
	 *
	 * The shell gates this on the page URL — only `brewser://` pages
	 * are trusted to run inline scripts. Fetched external pages can ship
	 * arbitrary JavaScript that calls DOM APIs we don't implement
	 * (e.g. `document.createElement`, `addEventListener`); if such a
	 * script ALSO sets a `setTimeout`, the eventual callback's
	 * `TypeError: not a function` escapes our try/catch (we only catch
	 * the immediate script body) and lands in nx.js's unhandled-error
	 * path, which flips the canvas into text-render mode. Defaults to
	 * `true` for backward compatibility with the existing callers.
	 */
	allowScripts?: boolean;
	/**
	 * Page URL of the document being parsed. Used to resolve relative
	 * `<script src="...">` URLs (e.g. `assets/main.js` →
	 * `brewser://X/Y/assets/main.js`). When omitted, external scripts
	 * with relative srcs are skipped with a debug log.
	 */
	pageUrl?: string;
	/**
	 * Phase 3b (2026-05-26): when `true`, skip the `resetLiveRoot()`
	 * call that normally fires inside `buildDocumentShim`. The caller is
	 * expected to have already populated the live root with the page
	 * content (via `populateLiveRoot`) so scripts see `document.body`
	 * pre-filled with the parsed DOM rather than starting empty.
	 *
	 * When `false` (default), behavior is unchanged: live root is reset
	 * for each navigation and scripts start with an empty document.body.
	 */
	preserveLiveRoot?: boolean;
}

interface ScriptRef {
	kind: 'inline' | 'src';
	/** For `inline` this is the body text; for `src` it's the unresolved
	 * `src` attribute value (resolved against `pageUrl` at exec time). */
	value: string;
}

export async function runPageScripts(
	root: HtmlElement,
	options: RunPageScriptsOptions = {},
): Promise<PageScriptContext> {
	const { allowScripts = true, pageUrl, preserveLiveRoot = false } = options;
	if (allowScripts) ensureRAFInstalled();
	const outputs: CanvasOutputs = new Map();
	const byId = new Map<string, CanvasEntry>();
	const ordered: CanvasEntry[] = [];
	const scripts: ScriptRef[] = [];
	// Register per-page readback hook so `tickAnimationFrames` can
	// refresh any WebGL-tagged OffscreenCanvases between rAF firings.
	// Cleared by `clearAnimationFrames` on navigation.
	pageReadbackHook = () => readbackWebGLEntries(ordered);

	const scriptShimsById = new Map<string, ScriptShim>();
	// Document-order list of EVERY script tag — needed for
	// `document.querySelectorAll('script')` / `'script[src]'`. SystemJS's
	// `prepareImport` iterates these to find `type="systemjs-importmap"` /
	// `type="systemjs-module"` tags and dispatch their loaders. Previously
	// only id-tagged scripts were tracked (for `getElementById` access to
	// shader source blocks etc.), which made the importmap tag invisible
	// and forced pages to register the import map programmatically.
	const scriptShimsAll: ScriptShim[] = [];
	visit(root, (el) => {
		if (el.tag === 'canvas') {
			const entry = createCanvasEntry(el);
			outputs.set(el, entry.offscreen);
			ordered.push(entry);
			if (el.attrs.id) byId.set(el.attrs.id, entry);
		} else if (el.tag === 'script') {
			const id = el.attrs.id ?? '';
			const type = el.attrs.type ?? '';
			const rawSrc = el.attrs.src ?? '';
			const integrity = el.attrs.integrity ?? '';
			const isJsType = type === '' || /^(text|application)\/(java|ecma)script$/i.test(type);
			const text = collectText(el);
			// Resolve `src` against pageUrl so SystemJS's `fetch(n.src, ...)`
			// gets a fully-qualified URL regardless of where the page lives.
			// Matches the HTML IDL behavior where `script.src` is absolute.
			let resolvedSrc = '';
			if (rawSrc) {
				if (pageUrl) {
					try { resolvedSrc = new URL(rawSrc, pageUrl).href; }
					catch { resolvedSrc = rawSrc; }
				} else {
					resolvedSrc = rawSrc;
				}
			}
			const shim: ScriptShim = {
				id, type, src: resolvedSrc, integrity, text, textContent: text,
				getAttribute(name) {
					if (name === 'id') return id || null;
					if (name === 'type') return type || null;
					if (name === 'src') return rawSrc || null;
					if (name === 'integrity') return integrity || null;
					const v = el.attrs[name];
					return v === undefined ? null : v;
				},
			};
			scriptShimsAll.push(shim);
			// id-keyed entry is the lookup path for getElementById (e.g.
			// `<script id="vshader" type="x-shader/x-vertex">` blocks read
			// back via their id by Khronos test pages).
			if (id) scriptShimsById.set(id, shim);
			// Only queue for execution if it's a JS-typed (or untyped)
			// script. Khronos shader script tags would fail to parse as
			// AsyncFunction bodies; skipping them avoids wasted work.
			if (allowScripts && isJsType) {
				if (rawSrc) {
					scripts.push({ kind: 'src', value: rawSrc });
				} else if (text.trim()) {
					scripts.push({ kind: 'inline', value: text });
				}
			}
		}
	});

	const documentShim = buildDocumentShim(byId, ordered, scriptShimsById, scriptShimsAll, preserveLiveRoot, pageUrl);
	const consoleShim = buildConsoleShim();

	// Install per-page globals so SystemJS / indirect-eval'd module bodies
	// (which run in global scope, not the per-script `document` param) see
	// the right `document`, `location`, and `navigator`. Done ONCE per page
	// nav before any script runs; persists for the page's lifetime.
	// Per-page nav into a new page overwrites these.
	installPageGlobals(documentShim, pageUrl);

	const execAll = async () => {
		for (const script of scripts) {
			// Reset sticky WebGL state before each script body — UNTIL a
			// script has acquired WebGL. Inline-canvas scripts share the
			// same screen GL context; a previous script's `gl.enable
			// (SCISSOR_TEST)` with a (0,0,0,0) scissor box would make a
			// later script's `gl.clear()` write a zero-sized region (i.e.
			// nothing). Resetting key state here gives every script the
			// re-apply its state on its next present.
			//
			// BUT: once a script has set up a stateful WebGL client
			// (e.g., Three.js's `WebGLRenderer`), subsequent
			// `gl.disable(SCISSOR_TEST)` / `gl.viewport(...)` calls
			// silently invalidate that client's internal state cache.
			// The client thinks its cached state is still applied, so
			// next render doesn't re-issue the right viewport — Three.js
			// then renders the cube into a 1×1 region left over from
			// its capability probe. So once a script has taken
			// ownership of the WebGL state, we don't touch it.
			const anyScriptOwnsWebGL = ordered.some((e) => e.hasWebGL);
			if (!anyScriptOwnsWebGL) {
				resetScreenGLForScript();
			}
			let body: string;
			if (script.kind === 'inline') {
				body = script.value;
			} else {
				const resolved = resolveScriptUrl(script.value, pageUrl);
				if (!resolved) {
					console.debug('[script src unresolved]', script.value);
					continue;
				}
				try {
					const response = await fetch(resolved);
					if (!response.ok) {
						console.debug('[script src fetch !ok]', resolved, response.status);
						continue;
					}
					body = await response.text();
				} catch (err) {
					console.debug('[script src fetch threw]', resolved, err);
					continue;
				}
			}
			try {
				// `AsyncFunction` evaluates with full access to the
				// runtime's globals (`fetch`, `Switch`, etc.). `window` is
				// shadowed by a per-page Proxy (`getLiveWindowProxy`) so
				// `window.addEventListener` for mouse/touch lands in this
				// page's LiveWindow registry; other window props fall
				// through to globalThis.
				const fn = new AsyncFunctionCtor('document', 'console', 'window', body);
				await fn(documentShim, consoleShim, getLiveWindowProxy());
			} catch (err) {
				// console.debug avoids the render-mode switch that
				// console.error / .log / .warn / .info would trigger
				// (see feedback_console_error_switches_render_mode.md).
				console.debug('[page script error]', err);
			}
			// Pull any pixels the script drew via WebGL back into the
			// corresponding OffscreenCanvas. Done between scripts so the
			// next one can issue its own draws without overwriting the
			// previous canvas's output. Cheap no-op if no canvas in the
			// page used WebGL.
			readbackWebGLEntries(ordered);
		}
	};

	const elementToEntry = new Map<HtmlElement, CanvasEntry>();
	for (const entry of ordered) elementToEntry.set(entry.element, entry);

	const rerun = async (
		resizes?: Map<HtmlElement, { width: number; height: number }>,
	): Promise<CanvasOutputs> => {
		if (resizes) {
			for (const [el, size] of resizes) {
				const entry = elementToEntry.get(el);
				if (!entry) continue;
				// Setting width or height on an OffscreenCanvas clears it,
				// which is what we want — the rerun's draw starts on a
				// clean surface at the new dimensions.
				entry.offscreen.width = Math.max(1, Math.round(size.width));
				entry.offscreen.height = Math.max(1, Math.round(size.height));
			}
		}
		// Re-install the per-page WebGL-readback hook in case the caller
		// just ran `clearAnimationFrames()` (which nulls the hook as part
		// of its page-navigation contract). Without this, scripts that
		// queue rAF callbacks during the rerun would draw into the bridge
		// FBO but never get read back into the offscreen, so the
		// fullscreen-canvas paint sees a blank/empty image. The original
		// page-script setup installed the same hook once on first run.
		pageReadbackHook = () => readbackWebGLEntries(ordered);
		await execAll();
		return outputs;
	};

	if (scripts.length > 0) await execAll();

	return {
		outputs,
		hasScripts: scripts.length > 0,
		rerun,
		firstCanvas: () => ordered[0]?.element ?? null,
	};
}

/**
 * For every entry that picked up a WebGL context, snapshot the bridge
 * framebuffer region the script drew into and copy it back into the
 * entry's OffscreenCanvas.
 *
 * nx.js's `gl.readPixels` uses canvas-y top-down coordinates (matches
 * `gl.viewport` and `gl.scissor` in nx.js — the translation to
 * GL-bottom-up happens inside `nx_webgl_read_pixels`). A script that
 * draws via `gl.viewport(0, 0, canvasW, canvasH)` lands its pixels in
 * the top-left `canvasW × canvasH` region of the screen FBO; we read
 * back that same region with `readPixels(0, 0, canvasW, canvasH)`.
 *
 * Returned bytes are still in GL row order (bottom-row-first within
 * the read rect), so we flip rows while copying into a
 * `Uint8ClampedArray` so `putImageData` lands the image upright.
 * Tagged `hasWebGL` entries larger than the screen are clamped — the
 * extra rows/cols stay as the default-cleared transparent black from
 * `createImageData`.
 */
/**
 * Set of OffscreenCanvas instances that have had a WebGL context
 * acquired on them this page. The shell looks up its layout's
 * `ImageBox.image` against this set to decide whether to use the
 * bridge→screen direct copy or fall back to `drawImage(offscreen)`.
 */
const webGLBackedCanvases = new WeakSet<OffscreenCanvas>();
export function isWebGLBackedCanvas(c: OffscreenCanvas): boolean {
	return webGLBackedCanvases.has(c);
}
// Let LiveElement.isWebGLBacked() consult this set at call time so a
// late `getContext('webgl2')` (Cocos Creator, lazy Three.js init) still
// flips the painter onto the bridge→screen copy path. See the
// commentary on `isWebGLBacked()` in live-dom.ts for why the cached
// `_webglBacked` flag isn't enough on its own.
setWebGLBackedPredicate(isWebGLBackedCanvas);

/**
 * Copy a sub-rect of the shared screen WebGL bridge FBO directly into
 * the screen canvas's 2D backing at (dstX, dstY). Used by the shell's
 * overlay to skip the OffscreenCanvas + drawImage hop for animated
 * inline-canvas WebGL pages. Returns `false` if the runtime build
 * doesn't have the C-level hook or the shared GL context isn't
 * acquired yet (caller falls back to `drawImage(offscreen)`).
 */
/** Pointer to the WebGL context the CURRENT page acquired. Updated by
 * each inline canvas's `getContext('webgl' | 'webgl2')`. Bridge-side
 * code (clearSharedScreenGLBridge, readbackWebGLEntries, copyBridgeToScreen)
 * needs to dispatch against THIS context — NOT against "whichever
 * shared context exists." Each WebGL kind owns its own native EGL
 * backend with its own bridge FBO + bridge programs (every
 * `nx_webgl_context_new` calls `nx_webgl_egl_create`, allocating a
 * fresh backend); calling `copyBridgeToCanvas` on the v1 wrapper reads
 * v1's FBO, on the v2 wrapper reads v2's FBO. If the current page used
 * WebGL2 but we dispatch against the v1 wrapper from a prior page, we
 * read an empty/stale FBO and the canvas stays black. Repros as the
 * "WebGL1-then-WebGL2 black-canvas" pattern. */
let activePageGL: WebGLRenderingContext | null = null;

/** Returns the GL context the current page acquired. Falls back to
 * whichever shared context exists when no page has acquired yet (e.g.
 * called from the initial paint before any inline canvas ran its
 * getContext). */
function getAnySharedScreenGL(): WebGLRenderingContext | null {
	return activePageGL ?? sharedScreenGL ?? sharedScreenGL2;
}

// 2026-06-07 pvzge investigation: diagnostic counter for copyBridgeToScreen.
// Always logs the FIRST call (proves identity of the gl + screen at first use)
// and then every Nth call so the bridge-to-screen path is observable across
// the run without spamming the log. Toggle `__brewserBridgeDebug = true` from
// the page or shell to switch to per-call verbose mode.
let copyBridgeCallCount = 0;
const COPY_BRIDGE_LOG_EVERY = 600;

export function copyBridgeToScreen(
	srcX: number,
	srcY: number,
	srcW: number,
	srcH: number,
	dstX: number,
	dstY: number,
): boolean {
	const rawGl = getAnySharedScreenGL();
	const gl = rawGl as unknown as {
		copyBridgeToCanvas?: (
			sx: number,
			sy: number,
			sw: number,
			sh: number,
			dstCanvas: unknown,
			dx: number,
			dy: number,
		) => boolean;
	} | null;
	const verbose = (globalThis as { __brewserBridgeDebug?: boolean })
		.__brewserBridgeDebug === true;
	const tick = ++copyBridgeCallCount;
	const shouldLog = verbose || tick === 1 || tick === 2 || tick === 10
		|| tick === 60 || (tick % COPY_BRIDGE_LOG_EVERY) === 0;
	if (!gl || typeof gl.copyBridgeToCanvas !== 'function') {
		if (shouldLog) {
			const which = rawGl === activePageGL
				? 'activePageGL'
				: rawGl === sharedScreenGL
					? 'sharedScreenGL'
					: rawGl === sharedScreenGL2 ? 'sharedScreenGL2' : 'null';
			console.debug('[bridge] tick=' + tick
				+ ' NO-OP src=' + which
				+ ' glTruthy=' + !!gl
				+ ' copyFnType=' + (gl ? typeof gl.copyBridgeToCanvas : 'n/a'));
		}
		return false;
	}
	// Pass the canvas (Screen), NOT its 2D context. `installBrowserShim`
	// wraps the 2D context in a Proxy so its JS class id no longer
	// matches the canvas-context class id the C side looks for. The
	// Screen canvas itself isn't wrapped — `nxScreen()` returns the
	// raw object — so `JS_GetOpaque` on the C side finds the nx_canvas_t
	// directly.
	const screen = nxScreen();
	try {
		const ok = gl.copyBridgeToCanvas(srcX, srcY, srcW, srcH, screen, dstX, dstY);
		if (shouldLog) {
			const which = rawGl === activePageGL
				? 'activePageGL'
				: rawGl === sharedScreenGL
					? 'sharedScreenGL'
					: rawGl === sharedScreenGL2 ? 'sharedScreenGL2' : 'unknown';
			const screenCtor = (screen && (screen as { constructor?: { name?: string } }).constructor?.name) || 'n/a';
			console.debug('[bridge] tick=' + tick
				+ ' src=' + which
				+ ' args=[' + srcX + ',' + srcY + ',' + srcW + ',' + srcH
				+ '->' + dstX + ',' + dstY + ']'
				+ ' screen=' + screenCtor + ':' + (screen as { width?: number }).width
				+ 'x' + (screen as { height?: number }).height
				+ ' ok=' + ok);
		}
		return ok;
	} catch (err) {
		console.debug('[bridge] tick=' + tick + ' THREW', err);
		return false;
	}
}

function readbackWebGLEntries(entries: CanvasEntry[]): void {
	const gl = getAnySharedScreenGL();
	if (!gl) return;
	let screenW = 0;
	let screenH = 0;
	try {
		const screen = nxScreen();
		screenW = screen.width;
		screenH = screen.height;
	} catch (_) {
		return;
	}
	for (const entry of entries) {
		if (!entry.hasWebGL) continue;
		const w = entry.offscreen.width;
		const h = entry.offscreen.height;
		if (w <= 0 || h <= 0) continue;
		const readW = Math.min(w, screenW);
		const readH = Math.min(h, screenH);
		// Allocate as Uint8ClampedArray so we can wrap it in an
		// `ImageData` directly without `createImageData()`'s extra
		// 921600-byte zero-init + a redundant `dst.set(bytes)` copy.
		// gl.readPixels accepts any byte-typed view.
		const bytes = new Uint8ClampedArray(readW * readH * 4);
		try {
			gl.readPixels(
				0,
				0,
				readW,
				readH,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				bytes,
			);
		} catch (err) {
			console.debug('[canvas-runner] readPixels failed', err);
			continue;
		}
		const ctx = entry.offscreen.getContext('2d');
		if (!ctx) continue;
		// nxjs's `gl.readPixels` returns rows in canvas-y top-down
		// (the bridge does the Y-flip in C). For the common case
		// where readW == w and readH == h we wrap `bytes` in an
		// `ImageData` directly — no allocation, no copy on the JS
		// side. Smaller readbacks fall through to the createImageData
		// path.
		let imageData: ImageData;
		if (readW === w && readH === h) {
			imageData = new ImageData(bytes, w, h);
		} else {
			imageData = ctx.createImageData(w, h);
			const dst = imageData.data;
			const srcStride = readW * 4;
			const dstStride = w * 4;
			for (let y = 0; y < readH; y++) {
				dst.set(
					bytes.subarray(y * srcStride, y * srcStride + srcStride),
					y * dstStride,
				);
			}
		}
		ctx.putImageData(imageData, 0, 0);
	}
}

/**
 * Resolve a `<script src="...">` value against the page URL.
 *
 *   - Absolute URLs with a scheme (`https://`, `brewser://`, `romfs:`,
 *     `sdmc:`, etc.) pass through unchanged.
 *   - Root-relative paths (`/foo/bar.js`) attach to the page URL's
 *     scheme + authority.
 *   - Relative paths (`assets/main.js`) resolve against the directory
 *     of the page URL.
 *
 * Returns `null` when the src is empty or `pageUrl` is missing for a
 * relative reference (we can't fabricate a base out of thin air).
 */
function resolveScriptUrl(src: string, pageUrl: string | undefined): string | null {
	if (!src) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src;
	if (!pageUrl) return null;
	const baseMatch = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/i.exec(pageUrl);
	if (!baseMatch) return null;
	const baseScheme = baseMatch[1] ?? '';
	const basePath = baseMatch[2] ?? '';
	if (src.startsWith('/')) {
		return baseScheme + src;
	}
	const trimmed = basePath.endsWith('/')
		? basePath
		: basePath.slice(0, basePath.lastIndexOf('/') + 1);
	return baseScheme + trimmed + src;
}

/**
 * Page-script animation-frame queue. nx.js doesn't provide
 * `requestAnimationFrame` itself; pages that want continuous rendering
 * (e.g. Three.js demos) call our shim, which enqueues the callback.
 * The browser shell drains the queue once per main-loop iteration via
 * `tickAnimationFrames()`, giving pages a steady ~60 Hz tick aligned
 * with the rest of the shell's input + scroll polling.
 *
 * Each tick swaps the queue out so callbacks that re-register
 * themselves (the common pattern) fire on the NEXT tick, not the
 * current one — matches browser rAF semantics.
 */
let rafQueue: Array<(t: number) => void> = [];
let rafNextId = 1;
const rafCancelled = new Set<number>();
const rafIdByCallback = new WeakMap<(t: number) => void, number>();
let rafInstalled = false;
/** Sticky flag: true once any callback has been queued on the current
 * page (cleared by `clearAnimationFrames` on navigation). Lets the
 * shell decide to skip the cached-layout fast path and re-paint from
 * layout each frame so animated canvases stay fresh. */
let pageHasAnimated = false;
/** Optional callback the runner uses to refresh the OffscreenCanvases
 * of every WebGL-tagged entry after rAF callbacks fire. Set once per
 * page by `runPageScripts`; cleared by `clearAnimationFrames`. */
let pageReadbackHook: (() => void) | null = null;

interface RAFCarrier {
	requestAnimationFrame?: (cb: (t: number) => void) => number;
	cancelAnimationFrame?: (id: number) => void;
}

/** Install `requestAnimationFrame` / `cancelAnimationFrame` on
 * `globalThis` exactly once. Page scripts access them through the
 * runtime's global scope (AsyncFunction inherits globals). The shell
 * drives the queue via `tickAnimationFrames()`. */
function ensureRAFInstalled(): void {
	if (rafInstalled) return;
	rafInstalled = true;
	const carrier = globalThis as unknown as RAFCarrier;
	carrier.requestAnimationFrame = (cb) => {
		if (typeof cb !== 'function') return 0;
		pageHasAnimated = true;
		const id = rafNextId++;
		rafIdByCallback.set(cb, id);
		rafQueue.push(cb);
		return id;
	};
	carrier.cancelAnimationFrame = (id) => {
		rafCancelled.add(id);
	};
}

/**
 * Fire every callback queued since the last tick. Returns `true` if
 * at least one callback ran (lets the caller skip a screen present
 * when nothing happened). The queue is swapped before firing so
 * callbacks that re-register themselves run on the NEXT tick rather
 * than spinning forever inside one tick.
 */
export function tickAnimationFrames(): boolean {
	if (rafQueue.length === 0) return false;
	const pending = rafQueue;
	rafQueue = [];
	const now = performance.now();
	let fired = false;
	for (const cb of pending) {
		const id = rafIdByCallback.get(cb);
		if (id !== undefined && rafCancelled.has(id)) {
			rafCancelled.delete(id);
			continue;
		}
		try {
			cb(now);
			fired = true;
		} catch (err) {
			console.debug('[rAF callback threw]', err);
		}
	}
	// NOTE: we no longer fire `pageReadbackHook` per tick. The shell's
	// overlay copies the bridge FBO directly into the screen canvas
	// via `copyBridgeToScreen` for WebGL-backed slots — saves the
	// per-frame `gl.readPixels` + `putImageData` pair (~9 ms). The
	// post-script-body readback (still called from `execAll`) keeps
	// the per-canvas OffscreenCanvas backing in sync for code that
	// reads from the offscreen directly.
	return fired;
}

/** Drop any queued animation-frame callbacks. Called on navigation so
 * a leaving page's callbacks don't keep firing under the next page.
 * Also clears the per-page readback hook + animation-active flag. */
export function clearAnimationFrames(): void {
	rafQueue = [];
	rafCancelled.clear();
	pageHasAnimated = false;
	pageReadbackHook = null;
}

/** Wipe the shared screen GL bridge FBO so pixels from the previous
 * page don't bleed onto the next page's canvas slot before its first
 * rAF tick fires. The shared GL contexts (v1 + v2) are acquired once
 * each per process and each owns its OWN native EGL backend with its
 * own bridge FBO — so we have to clear BOTH if both are acquired.
 * Otherwise an A→B→A pattern that touches both kinds (e.g. WebGL1 →
 * WebGL2 → WebGL1) leaves the un-cleared backend holding stale content
 * that `copyBridgeToScreen` would show on the next paint. No-op when
 * no shared context has been acquired yet. */
export function clearSharedScreenGLBridge(): void {
	clearBridgeFor(sharedScreenGL);
	clearBridgeFor(sharedScreenGL2);
}

function clearBridgeFor(gl: WebGLRenderingContext | null): void {
	if (!gl) return;
	try {
		// Defensively reset the bits that could mask the clear.
		gl.colorMask(true, true, true, true);
		gl.disable(gl.SCISSOR_TEST);
		gl.clearColor(0, 0, 0, 0);
		gl.clearDepth(1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	} catch (err) {
		console.debug('[canvas-runner] clearBridgeFor failed', err);
	}
}

/** True iff at least one callback is queued. Lets the shell choose a
 * shorter poll interval when an animation is active. */
export function hasPendingAnimationFrames(): boolean {
	return rafQueue.length > 0;
}

/** True iff the current page has called `requestAnimationFrame` at
 * least once (sticky until navigation). The shell uses this to skip
 * the cached-layout fast path on animated pages so updated canvas
 * frames make it to the screen. */
export function pageHasAnimationActivity(): boolean {
	return pageHasAnimated;
}

/**
 * Reset the script-relevant GL state on the shared screen WebGL
 * context. Called once per script body before execution so each script
 * starts with predictable state regardless of what the previous script
 * left behind. No-op if the shared context hasn't been acquired yet.
 *
 * Symptom that drove the broader reset (2026-05-27): navigating from
 * one Three.js demo directly to another left the second demo's canvas
 * black. Three.js's WebGLRenderer assumes spec-default state at
 * construction; bindings / programs / vertex-attribs leaked from the
 * previous renderer caused the new one to draw against stale buffers
 * or skip draws entirely (no visible error). nx.js demos that own all
 * their GL setup (useProgram + bind buffers explicitly) weren't
 * affected, which matched the user's repro that "nx.js demo always
 * works."
 */
function resetScreenGLForScript(): void {
	const gl = getAnySharedScreenGL();
	if (!gl) return;
	let screenW = 0;
	let screenH = 0;
	try {
		const screen = nxScreen();
		screenW = screen.width;
		screenH = screen.height;
	} catch (_) {
		return;
	}
	try {
		// Capability + scissor state.
		gl.disable(gl.SCISSOR_TEST);
		gl.scissor(0, 0, screenW, screenH);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.BLEND);
		gl.disable(gl.CULL_FACE);
		gl.disable(gl.STENCIL_TEST);
		gl.disable(gl.POLYGON_OFFSET_FILL);
		// Blend factors + equation to ES 2.0 defaults (ONE, ZERO,
		// FUNC_ADD) so the next page's GL context behaves as if freshly
		// created. Otherwise the shared screen-GL context preserves the
		// previous page's last-used blend mode — Three.js demos that
		// switch blend modes per material leave `(SRC_ALPHA,
		// ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)` or similar
		// behind. Khronos state tests that assert defaults fail without
		// this; demos that don't explicitly set blend rely on the spec
		// defaults being honored on entry.
		gl.blendFunc(gl.ONE, gl.ZERO);
		gl.blendEquation(gl.FUNC_ADD);
		gl.viewport(0, 0, screenW, screenH);
		gl.clearColor(0, 0, 0, 0);
		// Depth + cull + color mask defaults.
		gl.depthMask(true);
		gl.depthFunc(gl.LESS);
		gl.cullFace(gl.BACK);
		gl.frontFace(gl.CCW);
		gl.colorMask(true, true, true, true);
		// Program + bindings. Three.js's renderer queries / overwrites
		// these in its construction path; clearing them ensures any
		// stale ref to a program from the previous page (which is
		// still held alive by the shared context's `current_program`
		// JS ref until we drop it here) doesn't survive into the new
		// renderer's WebGLState cache.
		gl.useProgram(null);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
		gl.bindTexture(gl.TEXTURE_2D, null);
		gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.bindRenderbuffer(gl.RENDERBUFFER, null);
		// Disable every vertex attribute the GLES context advertises.
		// Three.js doesn't disable attribs it doesn't use; if the
		// previous page enabled attribs 3-7 pointing at deallocated
		// buffer ranges, the next page's draw would still feed those
		// pointers to the GPU even after Three.js's vertexAttribPointer
		// on attribs 0-2. The bridge dispatch routes through
		// `nx_webgl_egl_draw_passthrough` which honors enableVertexAttribArray
		// state, so leaked enables can corrupt or skip draws.
		try {
			const maxAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;
			if (typeof maxAttribs === 'number' && maxAttribs > 0) {
				for (let i = 0; i < maxAttribs; i++) {
					gl.disableVertexAttribArray(i);
				}
			}
		} catch (_) { /* getParameter may be locked while bridge is mid-flight */ }
		// VAO reset (WebGL2 only). On WebGL1 builds the call is a
		// no-op (gl.bindVertexArray is undefined).
		const gl2 = gl as unknown as {
			bindVertexArray?: (vao: WebGLVertexArrayObject | null) => void;
		};
		if (typeof gl2.bindVertexArray === 'function') {
			try { gl2.bindVertexArray(null); } catch (_) { /* swallow */ }
		}
		// Pixel-store defaults — affects subsequent texImage2D + readPixels.
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
		gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
		const UNPACK_FLIP_Y_WEBGL = 0x9240;
		const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
		try { gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, 0); } catch (_) { /* not all builds support it */ }
		try { gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0); } catch (_) { /* not all builds support it */ }
	} catch (err) {
		console.debug('[canvas-runner] resetScreenGLForScript failed', err);
	}
}

function createCanvasEntry(el: HtmlElement): CanvasEntry {
	const width = parsePositive(el.attrs.width) ?? DEFAULT_CANVAS_WIDTH;
	const height = parsePositive(el.attrs.height) ?? DEFAULT_CANVAS_HEIGHT;
	const offscreen = new OffscreenCanvas(width, height);
	const entry: CanvasEntry = {
		element: el,
		offscreen,
		shim: null as unknown as CanvasShim,
		hasWebGL: false,
		contextKind: '',
	};
	// Synthesized parent reporting the Switch screen box (1280×720). Used
	// by engines that size canvas to its container via
	// `canvas.parentElement.getBoundingClientRect()` (Cocos Creator does
	// this in its boot scripts). The CanvasShim itself doesn't track the
	// real DOM parent, but the screen box is the right answer for
	// fullscreen-style games — they want to fill the available area.
	const SCREEN_W = 1280, SCREEN_H = 720;
	const screenParent = {
		tagName: 'DIV',
		clientWidth: SCREEN_W,
		clientHeight: SCREEN_H,
		offsetWidth: SCREEN_W,
		offsetHeight: SCREEN_H,
		getBoundingClientRect() {
			return { x: 0, y: 0, top: 0, left: 0, right: SCREEN_W, bottom: SCREEN_H, width: SCREEN_W, height: SCREEN_H };
		},
		appendChild(child: unknown) { return child; },
		removeChild(child: unknown) { return child; },
		insertBefore(child: unknown) { return child; },
	};
	// Permissive style bag. Plain reads/writes pass through; the
	// `cursor` key is intercepted via a Proxy so the page-mouse
	// forwarder can pick up Cocos/etc. `canvas.style.cursor = "url(...)"`
	// writes and load the sprite. Other CSS props are stored but inert
	// — the Switch has no live canvas CSS engine.
	const styleStorage: Record<string, unknown> = {};
	const styleBag = new Proxy(styleStorage, {
		set(target, prop, value) {
			target[prop as string] = value;
			if (prop === 'cursor') {
				try {
					const cssVal = typeof value === 'string' ? value : (value == null ? null : String(value));
					setCursorFromCss(cssVal);
				} catch (_) { /* swallow — leave the value stored */ }
			}
			return true;
		},
	}) as Record<string, unknown>;
	entry.shim = {
		get width() { return offscreen.width; },
		set width(v: number) { offscreen.width = v; },
		get height() { return offscreen.height; },
		set height(v: number) { offscreen.height = v; },
		get parentElement() { return screenParent; },
		get parentNode() { return screenParent; },
		get style() { return styleBag; },
		// Forward listener registration to the matching live canvas
		// element. The shim is what page scripts hold via the canvas
		// reference they cached at boot (Cocos Creator's `this._canvas`,
		// engines that ran `document.querySelector('canvas')` from an
		// inline script), but the actual dispatch site is the live element
		// — `page-touch-forwarder.ts` walks the live root and dispatches
		// TouchEvent / PointerEvent on each `<CANVAS>` LiveElement. Without
		// this forwarding, Cocos's `addEventListener('touchstart', ...)`
		// drops the handler and the game gets no input despite renders.
		// Three.js's GL-context-loss listeners still work because the live
		// element silently accepts unknown event types (no listeners
		// registered → dispatch no-op).
		addEventListener(type: unknown, listener: unknown, _options?: unknown): void {
			if (typeof type !== 'string' || typeof listener !== 'function') return;
			const liveEl = findLiveElement(
				getLiveRoot(),
				(el) => el.tagName === 'CANVAS'
					&& (el as unknown as { getOffscreen?: () => unknown }).getOffscreen?.() === offscreen,
			);
			if (liveEl) liveEl.addEventListener(type, listener as Function);
		},
		removeEventListener(type: unknown, listener: unknown, _options?: unknown): void {
			if (typeof type !== 'string' || typeof listener !== 'function') return;
			const liveEl = findLiveElement(
				getLiveRoot(),
				(el) => el.tagName === 'CANVAS'
					&& (el as unknown as { getOffscreen?: () => unknown }).getOffscreen?.() === offscreen,
			);
			if (liveEl) liveEl.removeEventListener(type, listener as Function);
		},
		focus() { /* Switch has no focus model — required for Cocos's touchstart callback */ },
		/* 2026-06-08 ROUND 46: Web Fullscreen API. Forwards to the shell's
		 * fullscreen-canvas flow via globalThis.__swbRequestFullscreenCanvas,
		 * installed at shell construction. Resolves once mode flipped. */
		requestFullscreen(_options?: unknown): Promise<void> {
			const trigger = (globalThis as { __swbRequestFullscreenCanvas?: () => Promise<void> })
				.__swbRequestFullscreenCanvas;
			if (typeof trigger === 'function') return trigger();
			return Promise.resolve();
		},
		getBoundingClientRect() {
			// Find the live canvas element this offscreen is wired into and
			// return its layout box. Wiring + layout both happen AFTER page
			// scripts run, so an init-time call (before layout) falls back
			// to the offscreen's pixel dims — a render-loop call (after
			// layout) gets the real, stable CSS box.
			const liveEl = findLiveElement(
				getLiveRoot(),
				(el) => el.tagName === 'CANVAS'
					&& (el as unknown as { getOffscreen?: () => unknown }).getOffscreen?.() === offscreen,
			);
			if (liveEl) {
				const r = liveEl.getBoundingClientRect() as { width: number; height: number; x?: number; y?: number; top?: number; left?: number; right?: number; bottom?: number };
				if (r && r.width > 0 && r.height > 0) {
					return {
						x: r.x ?? r.left ?? 0, y: r.y ?? r.top ?? 0,
						top: r.top ?? 0, left: r.left ?? 0,
						right: r.right ?? r.width, bottom: r.bottom ?? r.height,
						width: r.width, height: r.height,
					};
				}
			}
			const w = offscreen.width, h = offscreen.height;
			return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h };
		},
		getContext(kind, _options) {
			if (kind === '2d') {
				// Page scripts reach the canvas through this shim, NOT
				// through LiveElement.getContext — so the live-dom wrap
				// must be applied here too. Without it, ctx.fillRect etc.
				// write to the offscreen with no signal to the engine
				// and the canvas freezes at its first paint (the
				// shell's per-frame `overlayLiveAnimatedCanvases` walk
				// also stays gated off because `hasPageCanvas2dActivity`
				// is set inside the wrap). Idempotent — re-getContext
				// returns the same wrapped instance.
				const ctx = offscreen.getContext('2d');
				if (ctx) wrapCanvasCtx2dForRepaint(ctx);
				return ctx;
			}
			if (kind === 'webgl' || kind === 'experimental-webgl') {
				// Per WebGL spec, a canvas hosts one context kind. If
				// the script already pinned 'webgl2' on this inline
				// canvas, refuse.
				if (entry.contextKind && entry.contextKind !== 'webgl')
					return null;
				// Route to the shared screen WebGL context (see
				// `getSharedScreenGL` for why). The runner reads the
				// bridge FBO back into THIS entry's offscreen after the
				// script finishes so the painter blits the rendered
				// pixels at the canvas's layout slot. For per-frame
				// updates the shell uses the direct bridge→screen
				// copy and the offscreen is just the layout placeholder.
				const gl = getSharedScreenGL();
				if (gl) {
					entry.hasWebGL = true;
					entry.contextKind = 'webgl';
					webGLBackedCanvases.add(offscreen);
					// This page now owns v1; route bridge-side ops
					// (copyBridgeToCanvas / readPixels / clear) through
					// THIS context so they hit the v1 EGL backend the
					// page is actually drawing into.
					activePageGL = gl;
				}
				return gl;
			}
			if (kind === 'webgl2') {
				if (entry.contextKind && entry.contextKind !== 'webgl2')
					return null;
				// Same shared-context model as WebGL 1, with the WebGL 2
				// JS class returned so Three.js's
				// `gl.constructor.name === 'WebGL2RenderingContext'`
				// detection flips. Note: each kind owns its OWN native
				// EGL backend (every `nx_webgl_context_new` calls
				// `nx_webgl_egl_create` — they don't share a backend
				// despite the screen.ts comment), so `activePageGL`
				// must point at THIS context for bridge readback to
				// see the v2 FBO the page draws into.
				const gl = getSharedScreenGL2();
				if (gl) {
					entry.hasWebGL = true;
					entry.contextKind = 'webgl2';
					webGLBackedCanvases.add(offscreen);
					activePageGL = gl;
				}
				return gl;
			}
			return null;
		},
	};
	return entry;
}

/** Depth-first, document-order search of a live subtree for the first
 * element matching `pred`. */
function findLiveElement(root: LiveElement, pred: (el: LiveElement) => boolean): LiveElement | null {
	if (pred(root)) return root;
	for (const child of root.children) {
		const hit = findLiveElement(child, pred);
		if (hit) return hit;
	}
	return null;
}

/** Collect every element in a live subtree matching `pred`, in document order. */
function findAllLiveElements(root: LiveElement, pred: (el: LiveElement) => boolean, out: LiveElement[]): void {
	if (pred(root)) out.push(root);
	for (const child of root.children) findAllLiveElements(child, pred, out);
}

/** Build a match predicate for a SIMPLE selector — `#id`, `.class`, or a
 * bare `tag`. Compound / descendant selectors return null (unsupported).
 * Used so `document.querySelector` / `getElementById` resolve ordinary
 * page elements out of the live DOM tree, not just the canvas/script
 * shims the runner tracks. */
function liveSelectorPredicate(selector: string): ((el: LiveElement) => boolean) | null {
	const sel = selector.trim();
	if (!sel) return null;
	if (sel.charAt(0) === '#') {
		const id = sel.slice(1);
		return (el) => el.getAttribute('id') === id;
	}
	if (sel.charAt(0) === '.') {
		const cls = sel.slice(1);
		return (el) => (el.getAttribute('class') || '').split(/\s+/).indexOf(cls) >= 0;
	}
	// Bracket attribute selector — `[attr]` (existence) or
	// `[attr="value"]` / `[attr=value]` (equality). Settings.html's
	// inline script uses `[data-setting]` to walk every staged widget;
	// without this branch querySelectorAll returned null and the Save
	// button never enabled. Quoted and unquoted values both accepted.
	const attrMatch = /^\[([a-zA-Z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(sel);
	if (attrMatch) {
		const name = attrMatch[1];
		const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
		if (value === undefined) {
			return (el) => el.hasAttribute(name);
		}
		return (el) => el.getAttribute(name) === value;
	}
	if (/^[a-z][a-z0-9-]*$/i.test(sel)) {
		const want = sel.toUpperCase();
		return (el) => el.tagName === want;
	}
	return null;
}

function buildDocumentShim(
	byId: Map<string, CanvasEntry>,
	ordered: CanvasEntry[],
	scriptShimsById: Map<string, ScriptShim>,
	scriptShimsAll: ScriptShim[],
	preserveLiveRoot: boolean,
	pageUrl?: string,
) {
	// Reset live root per page navigation — live elements from the
	// previous page must not survive into the next.
	//
	// Phase 3b: in live-render mode the shell already populated the live
	// root with the parsed page DOM (via `populateLiveRoot`); a reset
	// here would wipe that content before scripts had a chance to see
	// it. Skip the reset when the caller pre-populated.
	if (!preserveLiveRoot) resetLiveRoot();
	const body = getLiveRoot();
	const documentEl = new LiveElement('html');
	// 2026-06-14: pre-mark `documentEl` as attached so the
	// `appendChild(body)` below doesn't trigger a `propagateAttached`
	// detach-then-attach cycle on the entire body subtree. The old
	// pre-modal-layer code happened to work because `attached=false`
	// only suppressed a tree-walk fast path that nothing in this code
	// path actually relied on; my modal-layer commit promoted the flag
	// into the registration trigger for `<browser-modal>` roots, so a
	// stale `propagateAttached(body, false, ...)` now unregisters every
	// modal in the page and the modal paint pass finds the registry
	// empty. Matching the same `attached=true` hack `LiveRoot`'s own
	// constructor and `rebuildKeyboardLiveRoot` use.
	documentEl.attached = true;
	const head = new LiveElement('head');
	// `documentElement` (<html>) owns `<head>` and `<body>`. lil-gui's
	// stylesheet injection looks for `document.head` then walks its
	// children via querySelector; needs to be a LiveElement so
	// appendChild + insertBefore plumb through.
	documentEl.appendChild(head);
	documentEl.appendChild(body);

	const shim = {
		body,
		documentElement: documentEl,
		head,
		// Spec strings page scripts probe to decide whether to wait
		// (`readyState === 'loading'`) or proceed (`'complete'`). The page
		// is fully parsed + populated by the time scripts run here, so
		// always report 'complete'. SystemJS's `prepareImport()` hangs on
		// 'loading' waiting for DOMContentLoaded — without this default,
		// Cocos Creator + any SystemJS-based bundle stalls forever.
		readyState: 'complete' as const,
		// Touch-event feature flags. Cocos Creator's input system probes
		// `document.documentElement.ontouchstart !== undefined` OR
		// `document.ontouchstart !== undefined` to decide whether to attach
		// touch listeners vs falling back to keyboard/mouse — with neither
		// defined, the engine registered only `keydown/keyup` on the
		// canvas and tap input never reached the game. Properties as null
		// satisfy the `!== undefined` check without claiming any specific
		// handler. The `'ontouchstart' in window` check is handled
		// separately in `getLiveWindowProxy()` via `has` trap. See pvzge
		// 2026-06-07 touch wiring.
		ontouchstart: null,
		ontouchmove: null,
		ontouchend: null,
		ontouchcancel: null,
		// Mouse-event feature flags. Pages that prefer the mouse path
		// (or that probe via `'onmousedown' in document` before binding
		// listeners) take the mouse branch and get the synthetic events
		// dispatched by the software-cursor driver in
		// `page-mouse-forwarder.ts`. Engines that don't probe (e.g.
		// hand-rolled `addEventListener('mousedown', ...)` callers) are
		// already satisfied by the LiveWindow listener registry.
		onmousedown: null,
		onmousemove: null,
		onmouseup: null,
		onclick: null,
		oncontextmenu: null,
		onpointerdown: null,
		onpointermove: null,
		onpointerup: null,
		// `document.baseURI` for relative-URL resolution. SystemJS, fetch,
		// and `new URL(rel, document.baseURI)` callers depend on this.
		baseURI: pageUrl ?? 'brewser://about:blank',
		// `window` shim — page scripts that register
		// `window.addEventListener('mousemove'/'mouseup'/'touchmove'/'touchend')`
		// (lil-gui slider/number drag pattern) get a real listener
		// registry that the canvas touch handler forwards into. See
		// `installCanvasTouch` in controller-shortcuts.ts. Other window
		// properties forward to globalThis for compat.
		window: getLiveWindow(),
		// `defaultView` is the DOM spec alias for the document's
		// window — addons probe it as a fallback when `window` is
		// undefined.
		defaultView: getLiveWindow(),
		getElementById(id: string): CanvasShim | ScriptShim | LiveElement | null {
			// Canvas / script shims the runner tracks win first (scripts
			// expect the canvas shim for a `<canvas>` id). Otherwise resolve
			// the element out of the live DOM tree — without this fallback
			// `getElementById` / `querySelector('#id')` returned null for
			// every ordinary element (an audio player's `#audio`, buttons,
			// sliders, …), so the page's listener wiring threw
			// "addEventListener of null" and aborted the whole script.
			const shimHit = byId.get(id)?.shim ?? scriptShimsById.get(id);
			if (shimHit) return shimHit;
			return findLiveElement(body, (el) => el.getAttribute('id') === id);
		},
		querySelector(selector: string): CanvasShim | ScriptShim | LiveElement | null {
			if (selector === 'canvas') return ordered[0]?.shim ?? null;
			if (selector === 'head') return head;
			if (selector === 'body') return body;
			if (selector === 'html') return documentEl;
			if (selector.startsWith('#')) return this.getElementById(selector.slice(1));
			// lil-gui: `document.querySelector('head link[rel=stylesheet], head style')`
			// — used to find an existing stylesheet so the injected
			// `<style>` lands before it. We don't have <link>; return the
			// first <style> child of head, or null.
			if (selector.includes('head') && (selector.includes('style') || selector.includes('link'))) {
				for (const child of head.children) {
					if (child.tagName === 'STYLE' || child.tagName === 'LINK') return child;
				}
				return null;
			}
			// Simple `.class` / `tag` selectors resolve from the live tree.
			const pred = liveSelectorPredicate(selector);
			if (pred) return findLiveElement(body, pred);
			return null;
		},
		querySelectorAll(selector: string): Array<CanvasShim | ScriptShim | LiveElement> {
			if (selector === 'canvas') return ordered.map((e) => e.shim);
			// Script-tag enumeration — SystemJS's `prepareImport` calls
			// `document.querySelectorAll('script')` to scan for
			// `systemjs-importmap` / `systemjs-module` tags, and a separate
			// `'script[src]'` call to locate the running module's URL.
			if (selector === 'script') return scriptShimsAll.slice();
			if (selector === 'script[src]') return scriptShimsAll.filter((s) => s.src !== '');
			if (selector.startsWith('#')) {
				const match = this.getElementById(selector.slice(1));
				return match ? [match] : [];
			}
			const pred = liveSelectorPredicate(selector);
			if (pred) {
				const out: LiveElement[] = [];
				findAllLiveElements(body, pred, out);
				return out;
			}
			return [];
		},
		getElementsByTagName(tag: string): Array<CanvasShim | ScriptShim | LiveElement> {
			const lower = tag.toLowerCase();
			if (lower === 'canvas') return ordered.map((e) => e.shim);
			if (lower === 'script') return scriptShimsAll.slice();
			if (lower === 'head') return [head];
			if (lower === 'body') return [body];
			if (lower === 'html') return [documentEl];
			// Walk the live tree (body + head) collecting by tag — used
			// by libs that probe for existing nodes before inserting.
			const out: LiveElement[] = [];
			const want = tag.toUpperCase();
			const visit = (el: LiveElement) => {
				if (el.tagName === want) out.push(el);
				for (const c of el.children) visit(c);
			};
			visit(documentEl);
			return out;
		},
		/**
		 * `document.createElement(tag)` — returns a LiveElement that
		 * pages can append into `document.body` / `document.head`. The
		 * painter walks `body`'s tree each frame; M2.0 still only
		 * paints `position:fixed` subtrees (full layout in M2.3).
		 *
		 * Tag passes through unchanged — the LiveElement records
		 * `tagName` and the painter (M2.1+) plus CSS cascade (M2.2)
		 * branch on it. Subclasses for input / select / option arrive
		 * in M2.4 when those need behaviour beyond a paintable rect.
		 */
		createElement(tag: string): LiveElement {
			// 2026-06-08 ROUND 30: `document.createElement('audio')` must
			// return an HTMLAudioElement-compatible object (in real browsers
			// it's equivalent to `new Audio()`). Cocos's DOM audio loader uses
			// `document.createElement("audio")` (not `new Audio()`) — without
			// this routing the returned LiveElement was a no-op paintable
			// rect, so audio.src/play/addEventListener/etc. did nothing.
			// Generic Web API behavior — any engine using <audio> via
			// createElement benefits.
			const lowerTag = typeof tag === 'string' ? tag.toLowerCase() : '';
			if (lowerTag === 'audio') {
				const AudioCtor = (globalThis as unknown as { Audio?: new () => unknown }).Audio;
				if (typeof AudioCtor === 'function') {
					try {
						console.debug('[createElement] routing audio → new Audio()');
						return new AudioCtor() as unknown as LiveElement;
					} catch (e) { console.debug('[createElement] audio routing threw: ' + String(e)); }
				}
			}
			return new LiveElement(tag);
		},
		/** `document.createTextNode(data)` — returns a `#text`-tagged
		 * LiveElement carrying inline-flow text. Append between element
		 * children to model real DOM mixed content like
		 * `<p>Hello <strong>world</strong>!</p>` where "Hello " and "!"
		 * are siblings of the <strong>. Live layout's inline-formatting
		 * context picks these up as text atoms. */
		createTextNode(data: string): LiveElement {
			const node = new LiveElement('#text');
			node.data = data == null ? '' : String(data);
			return node;
		},
		/** Document-level event listener. Three.js's `Timer.connect(document)`
		 * registers visibility / blur listeners we still don't dispatch on
		 * this platform — those just live harmlessly in the registry — but
		 * `keydown` is now wired up so pages can react to synthetic events
		 * the engine fires for D-pad / right-stick while a video is
		 * fullscreen (see controller-shortcuts.ts). Sharing the LiveWindow
		 * registry means handlers added via `document.addEventListener`
		 * AND `window.addEventListener` both fire on a single dispatch,
		 * which is close enough to the spec's bubble-through-document-
		 * then-window for our purposes. */
		addEventListener(type: string, listener: unknown, _opts?: unknown): void {
			if (typeof listener === 'function') {
				getLiveWindow().addEventListener(type, listener as Function);
			}
		},
		removeEventListener(type: string, listener: unknown, _opts?: unknown): void {
			if (typeof listener === 'function') {
				getLiveWindow().removeEventListener(type, listener as Function);
			}
		},
		dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
			return getLiveWindow().dispatchEvent(event);
		},
	};
	setOwnerDocument(shim);
	// Pointer Lock — adds exitPointerLock + pointerLockElement to this
	// per-page document shim. See src/polyfills/pointer-lock.ts for the
	// two-surface install (Element prototype + per-page document).
	installPointerLockOnDocumentShim(shim as unknown as Record<string, unknown>);
	return shim;
}

/** Install per-page-nav globals that SystemJS / indirect-eval'd module
 * bodies need to see. Modules eval'd via `(0, eval)(src)` (the SystemJS
 * pattern) run in GLOBAL scope, so their `document` / `location` /
 * `navigator` references resolve via globalThis — NOT the per-script
 * function's `document` parameter. Without this bridge, every Cocos /
 * Emscripten / SystemJS bundle stalls or throws at boot waiting for
 * properties that exist only on the per-script param.
 *
 * Called once per page nav, before any page script runs. Subsequent
 * page navs overwrite the values.
 */
function installPageGlobals(documentShim: object, pageUrl: string | undefined): void {
	const g = globalThis as Record<string, unknown>;

	// Bridge documentShim onto globalThis so module-scope `document.foo`
	// resolves to the per-page shim, not whatever was left over.
	try { g.document = documentShim; } catch (_) { /* ignore frozen */ }

	// Build a Location-shaped object from the current page URL. Cocos +
	// many other engines parse this at boot for behaviour gates and
	// asset path resolution. URL parsing is best-effort; an unparseable
	// or missing pageUrl falls back to `about:blank` shaped object.
	let loc: Record<string, unknown> | null = null;
	if (typeof pageUrl === 'string' && pageUrl.length > 0) {
		try {
			const u = new URL(pageUrl);
			loc = {
				href: pageUrl,
				origin: u.origin,
				protocol: u.protocol,
				host: u.host,
				hostname: u.hostname || (u.host.split(':')[0] ?? ''),
				port: u.port,
				pathname: u.pathname,
				search: u.search,
				hash: u.hash,
				reload() { /* no-op */ },
				assign(target: string) { /* no-op */ void target; },
				replace(target: string) { /* no-op */ void target; },
				toString() { return pageUrl; },
			};
		} catch (_) { /* malformed URL — fall through to default */ }
	}
	if (!loc) {
		loc = {
			href: 'about:blank', origin: 'null', protocol: 'about:', host: '',
			hostname: '', port: '', pathname: 'blank', search: '', hash: '',
			reload() {}, assign() {}, replace() {},
			toString() { return 'about:blank'; },
		};
	}
	try { g.location = loc; } catch (_) { /* ignore frozen */ }

	// Default desktop-Chrome UA on navigator. Cocos's `cc.sys` does
	// `navigator.userAgent.toLowerCase()` for platform detection and the
	// generic web path expects a desktop-shaped UA. The nxjs runtime's
	// own navigator (set up earlier in init) reports `@switch-web/runtime`
	// which Cocos's matcher doesn't recognise → falls through to mobile
	// detection paths that assume touch-only input. Override + extend.
	const DESKTOP_UA =
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
		'(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
	const navDefaults: Record<string, unknown> = {
		userAgent: DESKTOP_UA,
		appName: 'Netscape',
		appVersion: '5.0 (Windows)',
		appCodeName: 'Mozilla',
		platform: 'Win32',
		product: 'Gecko',
		productSub: '20030107',
		vendor: 'Google Inc.',
		vendorSub: '',
		language: 'en-US',
		languages: ['en-US', 'en'],
		onLine: true,
		cookieEnabled: false,
		doNotTrack: null,
		maxTouchPoints: 0,
		hardwareConcurrency: 4,
	};
	const existingNav = g.navigator as Record<string, unknown> | undefined;
	if (existingNav && typeof existingNav === 'object') {
		// Override userAgent (the runtime's `@switch-web/runtime` confuses
		// engine detection) and fill in any missing defaults.
		try { existingNav.userAgent = DESKTOP_UA; } catch (_) { /* ignore */ }
		for (const k of Object.keys(navDefaults)) {
			if (existingNav[k] === undefined) {
				try { existingNav[k] = navDefaults[k]; } catch (_) { /* ignore */ }
			}
		}
	} else {
		try { g.navigator = navDefaults; } catch (_) { /* ignore */ }
	}

}

function buildConsoleShim() {
	const route = (...args: unknown[]) => console.debug('[page]', ...args);
	const noop = () => { /* no-op */ };
	// All routed to console.debug (never the host console.error/log/warn/
	// info, which flip nx.js into text-render mode and freeze the canvas —
	// see feedback_console_error_switches_render_mode.md). `assert` was
	// previously MISSING: a page calling `console.assert(...)` (common in
	// self-test blocks) threw "console.assert is not a function", aborting
	// the whole script — e.g. the Brewser audio player's `init()` ran
	// `runSelfTests()` before `buildLibrary()`, so its playlist never
	// rendered. `assert` logs only on a failed condition and never throws.
	return {
		log: route,
		info: route,
		warn: route,
		error: route,
		debug: route,
		assert: (condition: unknown, ...args: unknown[]) => {
			if (!condition) console.debug('[page assert]', ...args);
		},
		group: route,
		groupCollapsed: route,
		groupEnd: noop,
		table: route,
		dir: route,
		dirxml: route,
		trace: route,
		count: noop,
		countReset: noop,
		time: noop,
		timeEnd: noop,
		timeLog: noop,
		clear: noop,
	};
}

function visit(node: HtmlNode, fn: (el: HtmlElement) => void): void {
	if (node.type !== 'element') return;
	fn(node);
	for (const child of node.children) visit(child, fn);
}

function collectText(el: HtmlElement): string {
	let out = '';
	for (const child of el.children) {
		if (child.type === 'text') out += child.text;
	}
	return out;
}

function parsePositive(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
