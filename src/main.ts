import { installPolyfills } from '@switch-web/runtime';
import { BrowserShell } from './browser-shell.js';

async function main() {
	// Shell is constructed BEFORE the polyfill install block so the
	// storage drivers receive its profile + currentPageUrl closure —
	// that's how local-storage + indexed-db route writes to a `dev/`
	// sub-namespace when the active page is under `brewser://dev/`.
	// Pages don't run until `shell.run()` below, so install order is
	// safe.
	//
	// `installPolyfills` bundles the runtime's standard polyfill set
	// (safe-console redirect, storage, MessageChannel, FileReader, XHR,
	// MutationObserver, getComputedStyle, Web Audio stubs, Pointer
	// Lock) in the order the runtime expects — safe-console first so
	// nx.js's `console.log` path can't flip text-render mode mid-boot.
	// See `@switch-web/runtime/install-polyfills.ts` for the exact
	// order + the "why" comments that used to live inline here.
	const shell = new BrowserShell();
	installPolyfills({
		profile: shell.getProfile(),
		getCurrentUrl: () => shell.getCurrentPageUrl(),
	});

	await shell.run();
}

main().catch((error) => {
	console.debug('[brewser] fatal error:', error);
});
