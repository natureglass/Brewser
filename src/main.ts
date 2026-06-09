import { BrowserShell } from './browser-shell.js';
import { installGetComputedStyle } from './polyfills/css-computed.js';
import { installFileReader } from './polyfills/file-reader.js';
import { installMessageChannel } from './polyfills/message-channel.js';
import { installMutationObserver } from './polyfills/mutation-observer.js';
import { installPointerLock } from './polyfills/pointer-lock.js';
import { installSafeConsoleRedirect } from './polyfills/safe-console.js';
import { installWebAudioStubs } from './polyfills/web-audio-stubs.js';
import { installXMLHttpRequest } from './polyfills/xhr.js';
import { LiveElement } from './scripts/live-dom.js';
import { installIndexedDB } from './storage/indexed-db.js';
import { installLocalStorage } from './storage/local-storage.js';

async function main() {
	// Safe-console FIRST — before anything else can call console.log /
	// info / warn / error. nxjs's `console.log` flips the runtime out
	// of canvas mode into text-render mode, so any page bundle (Cocos
	// Creator, libraries loaded via SystemJS / indirect-eval module
	// bodies) that prints through the global console would freeze the
	// canvas and overwrite the framebuffer with the formatted text
	// (the "LoadScene db://… X.000ms" overlay that pvzge surfaced 2026-06-07).
	// Engine code already uses `.debug` only — this just hardens the
	// boundary against any unsafe call going through the global object.
	installSafeConsoleRedirect();

	// Install Web APIs that nxjs runtime doesn't ship (or ships in a
	// non-usable form for swb) BEFORE any page script can touch them.
	// See [[reference-swb-api-probe-results]] for the gap list.

	// Shell is constructed BEFORE storage so we can pass a closure that
	// reads the live `currentPageUrl` on each storage access — that's
	// how local-storage + indexed-db route writes to a `dev/` subdir
	// when the active page is under `brewser://dev/`. Pages don't run
	// until `shell.run()` below, so install order is safe.
	const shell = new BrowserShell();
	const getCurrentUrl = () => shell.getCurrentPageUrl();
	installLocalStorage(getCurrentUrl);
	installIndexedDB(getCurrentUrl);
	installMessageChannel();
	installFileReader();
	// XMLHttpRequest — Tier-1 polyfill backed by fetch(). Cocos Creator,
	// GameMaker HTML5, and Construct 3 exports all rely on XHR for asset
	// manifests and resource loading. See [[project-swb-itchio-compat-roadmap]]
	// Tier B.
	installXMLHttpRequest();
	// MutationObserver — modern JS frameworks (React/Vue/Lit) + jQuery's
	// modern attachments depend on it. Live-DOM fires `notify*` helpers
	// at every mutation site so observer callbacks are triggered async
	// (microtask) per spec. See [[project-swb-itchio-compat-roadmap]] A2.
	installMutationObserver();
	// getComputedStyle(el).getPropertyValue('...') — pages reading
	// resolved computed values for theming, --custom-prop access, layout-
	// driven UI libraries. Wraps live-css's getComputedLiveStyle into a
	// CSSStyleDeclaration-shaped object. See roadmap A3.
	installGetComputedStyle();
	// Stub out Web Audio methods we didn't implement (createMediaElementSource,
	// createAnalyser, etc.) so mediaplayer's bootAudioGraph doesn't throw a
	// TypeError mid-init and leave AudioContext half-constructed, which
	// caused a system-wide audio break (mediaplayer + video + Web Audio).
	installWebAudioStubs();
	// Pointer Lock needs LiveElement.prototype to mount requestPointerLock
	// on — the page-script `typeof Element` check resolves to this class.
	installPointerLock(LiveElement);

	await shell.run();
}

main().catch((error) => {
	console.debug('[brewser] fatal error:', error);
});
