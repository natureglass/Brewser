import { installPolyfills } from '@switch-web/runtime';
import { BrowserShell } from './browser-shell.js';
import { detectUpdaterRole } from './update/role.js';
import { installSelfUpdateSeam } from './update/seam.js';

// Boot timing anchor for the boot-splash residual diagnostic. Captured at
// the very top of the JS entry — first line of execution after import
// resolution — so the splash's `[boot] splash-first-paint (+Nms since
// js-t0)` log can quantify the JS-side post-import-to-first-paint
// interval. Pairs with the C-side `[boot] t0` + `[skia] GPU screen
// surface ready (+Nms since t0)` logs to give the user T_Skia (the
// pre-Skia black ceiling = engine boot + V8 init + module eval, the
// part that needs a framebuffer-level patch to cover) and T_splash
// (post-Skia interval, should be sub-frame with the splash hoist fix).
(globalThis as { __bootT0?: number }).__bootT0 = Date.now();
console.debug(`[boot] js-t0 = ${Date.now()}`);

// Suppress the nx.js runtime's default "PLUS → $.exit()" behavior so
// Brewser's own action-bus can handle PLUS according to its buttonMapping
// (e.g. an app whose `manifest.json buttonMapping` says `"exit": "PLUS"`
// wants the exit action to walk one nav step back to the launcher, NOT
// hard-kill the whole Brewser process). Without this, the runtime's
// `$.onFrame(plusDown => dispatchEvent(beforeunload) → $.exit())` handler
// (packages/runtime/src/index.ts) always wins because it fires BEFORE
// the shell's per-tick action-bus dispatch — the process ends before
// browser-shell's `case 'exit'` even runs.
//
// preventDefault is idempotent for `beforeunload`; page scripts that
// register their own listeners still see the event and can do their own
// cleanup. This wrapper guarantees `defaultPrevented=true` so the
// runtime doesn't self-exit, and Brewser's shell decides on context.
globalThis.addEventListener('beforeunload', (event) => {
	event.preventDefault();
});

async function main() {
	// Self-update boot gate — BEFORE the browser shell. Config-free and cheap
	// (one statSync of the usually-absent journal on a normal boot). Only a
	// genuine update role dynamically loads the heavy applier, so a normal boot
	// never evaluates the updater config/keyring. STAGED / RECOVERY never return
	// (they chainload the installed NRO); POST-APPLY confirms the
	// freshly-installed build, stamps current.json, then returns here so the user
	// lands in the browser on the updated version. Any failure falls through to a
	// normal boot — the updater must never wedge the app.
	try {
		const role = detectUpdaterRole();
		if (role.kind !== 'normal') {
			const applier = await import('./update/applier.js');
			await applier.runRole(role);
		}
	} catch (error) {
		console.debug('[brewser] self-update boot gate error, continuing to shell:', error);
	}

	// Expose the in-shell self-update API for the download modal. Cheap: the
	// heavy flow/apply modules load lazily on first use, so this never evaluates
	// the updater config/keyring on a normal boot.
	installSelfUpdateSeam();

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
		permissionPolicy: shell.getPermissionPolicy(),
	});

	await shell.run();
}

main().catch((error) => {
	console.debug('[brewser] fatal error:', error);
});
