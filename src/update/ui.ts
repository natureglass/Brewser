/**
 * src/update/ui.ts — the progress surface the applier + download flow report
 * through, and a couple of shared helpers.
 *
 * apply.ts / flow.ts never draw anything themselves; they call an injected
 * `UpdaterUi`. Two implementations exist: `splash.ts` (the pre-shell framebuffer
 * screen used by the STAGED / RECOVERY / RESTORE / POST-APPLY boot roles) and,
 * later, a DOM-modal adapter inside `self-update-modal.js` (the in-shell
 * download flow). This keeps the logic testable and UI-independent.
 */

export interface UpdaterUi {
	/** Coarse phase label ("Downloading…", "Verifying…", "Applying…"). */
	status(message: string): void;
	/** Fine progress in [0,1], or a negative value for indeterminate. `label` is
	 * an optional detail line (e.g. "34.1 / 68.0 MiB"). */
	progress(frac: number, label?: string): void;
}

/** A UI that shows nothing (headless / tests). */
export const NOOP_UI: UpdaterUi = {
	status() {
		/* no-op */
	},
	progress() {
		/* no-op */
	},
};

export function mib(n: number): string {
	return `${(n / 1048576).toFixed(1)} MiB`;
}

/**
 * Resolve after `n` presented frames. Used to guarantee a paint lands before a
 * blocking transition (esp. before `chainload`, which never returns). Works in
 * both the pre-shell splash context and the in-shell rAF loop.
 */
export function nextFrames(n = 2): Promise<void> {
	return new Promise((resolve) => {
		let left = n;
		function tick() {
			if (--left <= 0) resolve();
			else requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}
