/**
 * src/update/seam.ts — installs `globalThis.__brewserSelfUpdate` so an in-shell
 * page script (self-update-modal.js) can drive the download → stage → chainload
 * flow from the INSTALLED role.
 *
 * The heavy modules (flow/apply → config/net/verify) are imported LAZILY inside
 * the API methods, so merely installing the seam costs nothing and a normal boot
 * never evaluates the updater config/keyring (verified: they stay `__esm`
 * lazy-wrapped in the bundle).
 */
import type { UpdaterUi } from './ui';

export interface SelfUpdatePrepareResult {
	/** 'staged' → verified + staged, ready to apply; 'up-to-date' → nothing newer;
	 * 'error' → failed (see reason/message). */
	outcome: 'staged' | 'up-to-date' | 'error';
	version?: string;
	stagedPath?: string;
	reason?: string;
	message?: string;
}

export interface SelfUpdateApi {
	/** Check → decide → download → verify → stage. Reports progress through `ui`.
	 * Does NOT chainload — the caller confirms, then calls applyStaged. */
	prepare(ui: UpdaterUi): Promise<SelfUpdatePrepareResult>;
	/** Chainload the staged build (never returns on success — the console
	 * relaunches into the staged NRO, which self-applies + reboots). */
	applyStaged(stagedPath: string): Promise<void>;
}

declare global {
	// eslint-disable-next-line no-var
	var __brewserSelfUpdate: SelfUpdateApi | undefined;
}

export function installSelfUpdateSeam(): void {
	const api: SelfUpdateApi = {
		async prepare(ui: UpdaterUi): Promise<SelfUpdatePrepareResult> {
			try {
				const { runDownloadAndStage } = await import('./flow.js');
				const res = await runDownloadAndStage(ui, String(Date.now()));
				if (!res.decision.accept) {
					return { outcome: 'up-to-date', version: res.decision.manifestVersion };
				}
				return {
					outcome: 'staged',
					version: res.manifest.version,
					stagedPath: res.journal.stagedPath ?? undefined,
				};
			} catch (err) {
				return { outcome: 'error', reason: (err as any)?.reason ?? 'ERROR', message: String(err) };
			}
		},
		async applyStaged(stagedPath: string): Promise<void> {
			const { chainload } = await import('./apply.js');
			await chainload(stagedPath); // never returns on success
		},
	};
	globalThis.__brewserSelfUpdate = api;
}
