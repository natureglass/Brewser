import type { PermissionPolicy } from '@switch-web/runtime';

export interface BrowserPermissionPolicyOptions {
	/** Whether to allow gamepad/controller input. Defaults to true. */
	allowGamepad?: boolean;
	/** Whether to allow touch input. Defaults to true. */
	allowTouch?: boolean;
	/** Whether to allow WebGL. Defaults to true. */
	allowWebGL?: boolean;
	/**
	 * Whether to allow `http(s)://` fetches via `NativeFetchLoader`.
	 *
	 * Defaults to `true` as of milestone C1: the `WebView` now routes
	 * `text/html` responses to `WebViewDelegate.onHtmlResponse` (currently a
	 * stub painter) instead of evaluating them as JS, so network HTML no
	 * longer crashes the page session. Set to `false` to gate network access
	 * back off — unknown URLs then short-circuit to a 403 inside the runtime
	 * fetch wrapper, which falls back to `brewser://error/`.
	 */
	allowNetwork?: boolean;
}

/**
 * Browser-side permission policy.
 *
 * Defaults (per `docs/security-model.md`):
 *  - local file access: denied for http(s) pages; the browser must register
 *    its own loader for `brewser://` / `nx-internal://` pages.
 *  - network access: **enabled by default** as of milestone C1. HTML
 *    responses are diverted to the browser's `onHtmlResponse` delegate
 *    instead of being eval'd as JS, so `http(s)://` URLs no longer crash
 *    the page session. Set `allowNetwork: false` to gate it back off.
 *  - gamepad / touch / WebGL: enabled.
 *  - persistent storage: allowed per origin (a profile/storage driver
 *    will be wired later).
 */
export class BrowserPermissionPolicy implements PermissionPolicy {
	private readonly gamepad: boolean;
	private readonly touch: boolean;
	private readonly webgl: boolean;
	private readonly network: boolean;

	constructor(options: BrowserPermissionPolicyOptions = {}) {
		this.gamepad = options.allowGamepad ?? true;
		this.touch = options.allowTouch ?? true;
		this.webgl = options.allowWebGL ?? true;
		this.network = options.allowNetwork ?? true;
	}

	/** Public read of the network gate so the shell can mirror it into `WebView.enableNetworkFetch`. */
	get networkEnabled(): boolean {
		return this.network;
	}

	allowLocalFile(_path: string): boolean {
		return false;
	}

	allowNetworkURL(url: string): boolean {
		// REVERTED 2026-06-03: the romfs:/sdmc: short-circuit (added
		// to silence the boot-probe's `network fetch denied: romfs:/main.js`
		// log noise) appears to have broken mediaplayer audio + video
		// playback by changing which loader claims sdmc:/ URLs. The cost
		// (silent regression) is dramatically worse than the log noise.
		if (!this.network) {
			return false;
		}
		return url.startsWith('http://') || url.startsWith('https://');
	}

	allowGamepad(): boolean {
		return this.gamepad;
	}

	allowTouch(): boolean {
		return this.touch;
	}

	allowWebGL(): boolean {
		return this.webgl;
	}

	allowPersistentStorage(_origin: string): boolean {
		return true;
	}
}
