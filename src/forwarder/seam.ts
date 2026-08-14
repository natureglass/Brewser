/**
 * src/forwarder/seam.ts — installs `globalThis.__brewserCreateForwarder` so the
 * in-shell app modal (forwarder-modal.js) can (a) probe an installed app to
 * render the confirmation dialog and (b) generate the forwarder NRO on-device.
 *
 * Mirrors installSelfUpdateSeam: the heavy generation module (generate.ts, which
 * pulls in the pack library) is imported LAZILY inside the API methods, so merely
 * installing the seam costs nothing on a normal boot.
 */

/** Progress surface the generator reports through (same shape as UpdaterUi). */
export interface ForwarderUi {
	status(message: string): void;
	progress(frac: number, label?: string): void;
}

export interface ForwarderProbe {
	/** manifest.json + entry file both present on disk. */
	installed: boolean;
	/** App display name (for the dialog + generated NACP title). */
	title: string;
	/** Whether the "embed a copy" checkbox may be offered. */
	canEmbed: boolean;
	/** Sum of the installed bundle file sizes (the "adds ~SIZE" figure). */
	embedSizeBytes: number;
	/** Why embed is unavailable, if `canEmbed` is false. */
	reason?: 'not-installed' | 'no-inventory';
}

export interface ForwarderResult {
	outcome: 'ok' | 'error';
	/** Absolute path of the generated `.nro` on success. */
	path?: string;
	reason?: string;
	message?: string;
}

export interface ForwarderApi {
	/** Inspect an installed app to drive the confirmation dialog. Never throws. */
	probe(appId: string): Promise<ForwarderProbe>;
	/** Generate the forwarder NRO. Reports progress through `ui`. Never throws —
	 * failures come back as `{ outcome: 'error', ... }` and leave no partial file. */
	create(
		opts: { appId: string; embed: boolean },
		ui: ForwarderUi,
	): Promise<ForwarderResult>;
}

declare global {
	// eslint-disable-next-line no-var
	var __brewserCreateForwarder: ForwarderApi | undefined;
}

export function installForwarderSeam(): void {
	const api: ForwarderApi = {
		async probe(appId) {
			try {
				const { probeForwarder } = await import('./generate.js');
				return await probeForwarder(appId);
			} catch (err) {
				return {
					installed: false,
					title: appId,
					canEmbed: false,
					embedSizeBytes: 0,
					reason: 'not-installed',
				};
			}
		},
		async create(opts, ui) {
			try {
				const { createForwarder } = await import('./generate.js');
				return await createForwarder(opts, ui);
			} catch (err) {
				return {
					outcome: 'error',
					reason: 'ERROR',
					message: String((err as { message?: string })?.message ?? err),
				};
			}
		},
	};
	globalThis.__brewserCreateForwarder = api;
}
