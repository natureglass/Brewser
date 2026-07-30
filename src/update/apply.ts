/**
 * src/update/apply.ts — stage → chainload → self-apply (copy + two renames) →
 * post-apply confirm → rollback. The destructive window (rename old away, rename
 * new in) is timed and logged in ms; on the rig's hardware run it was ~51 ms.
 *
 * ADAPTED from the brewser-updater-test rig's apply.ts. All UI goes through an
 * injected `UpdaterUi` (splash pre-shell, or the DOM modal in-shell) — this
 * module draws nothing. Re-targeted to Brewser's paths + build identity.
 */
import { BREWSER_COUNTER, BREWSER_VERSION } from './config';
import * as gfs from './guarded-fs';
import {
	ANTI_ROLLBACK_PATH,
	advanceHighWater,
	type Journal,
	type JournalManifest,
	transition,
	writeJournal,
} from './journal';
import { log, span, status } from './log';
import { BREWSER_NRO, PREVIOUS_NRO, RECOVERY_ALIAS, SWAP_TMP, underUpdate } from './paths';
import { type UpdaterUi, mib, nextFrames } from './ui';
import { chunkedHashFile, nroMagicCheck } from './verify';

export const PART_PATH = underUpdate('payload.part');
export const STAGED_PATH = underUpdate('payload.staged');
export const PREV_PATH = underUpdate('prev.bin');

export class ApplyError extends Error {
	constructor(
		public reason: string,
		message: string,
	) {
		super(message);
		this.name = 'ApplyError';
	}
}

/** Streamed file copy through the guarded writer. Returns bytes copied. */
export async function copyFile(
	src: string,
	dst: string,
	onProgress?: (bytes: number, total: number) => void,
): Promise<number> {
	const stat = Switch.statSync(src);
	if (!stat) throw new ApplyError('COPY_SRC_MISSING', `copy source missing: ${src}`);
	const total = stat.size;
	gfs.removeIfExists(dst);
	const reader = Switch.file(src).stream().getReader();
	const writer = gfs.writableFor(dst).getWriter();
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await writer.write(value);
			bytes += value.byteLength;
			onProgress?.(bytes, total);
		}
	} finally {
		try {
			await writer.close();
		} catch (err) {
			log('copy-writer-close-error', { dst, err: String(err) });
		}
	}
	log('copy-done', { src, dst, bytes, total });
	return bytes;
}

/** Chunked-hash a file, reporting progress through the UI. */
async function hashWithUi(ui: UpdaterUi, label: string, path: string) {
	ui.status(label);
	const stat = Switch.statSync(path);
	const total = stat ? stat.size : 0;
	const end = span(`hash:${path}`);
	const res = await chunkedHashFile(path, undefined, (bytes) =>
		ui.progress(total ? bytes / total : -1, `${mib(bytes)} hashed`),
	);
	end({ bytes: res.totalBytes });
	return res;
}

/**
 * Stage a verified download: part → staged, journal update, and the visible
 * recovery alias copy is created NOW (before the destructive phase exists).
 */
export async function stageVerifiedPart(ui: UpdaterUi, j: Journal, manifest: JournalManifest): Promise<Journal> {
	gfs.removeIfExists(STAGED_PATH);
	gfs.rename(PART_PATH, STAGED_PATH);
	let journal = transition(j, 'staged', {
		manifest,
		stagedPath: STAGED_PATH,
		toVersion: manifest.version,
	});
	ui.status('Preparing recovery copy…');
	await copyFile(STAGED_PATH, RECOVERY_ALIAS, (n, t) => ui.progress(n / t, `${mib(n)} / ${mib(t)}`));
	journal = { ...journal, recoveryReady: true };
	writeJournal(journal);
	log('recovery-alias-ready', { path: RECOVERY_ALIAS });
	return journal;
}

/** Chainload a staged/arbitrary NRO path. ARGLESS — argv[1] would be
 * interpreted by the runtime's resolve_entrypoint as an entrypoint override.
 * Never returns (the process exits on the next loop tick). */
export async function chainload(path: string): Promise<never> {
	log('chainload', { path });
	await nextFrames(3);
	// launch() queues the next NRO via envSetNextLoad and requests event-loop
	// exit — but it RETURNS to JS; the process actually exits on the next tick.
	// Suspend forever so control returns to the loop and the exit lands.
	new Switch.Application(path).launch();
	await new Promise<never>(() => {});
	throw new Error('chainload: process did not exit'); // unreachable
}

/**
 * STAGED / RECOVERY / RESTORE-role apply: re-verify own file, then copy + two
 * renames, then chainload the installed path. `selfPath` is the running NRO.
 *
 * Returns without swapping (idempotent refusal) when the update is already
 * applied. `allowDowngrade` marks an intentional RESTORE (older build).
 */
export async function selfApply(
	ui: UpdaterUi,
	journal: Journal,
	selfPath: string,
	opts?: { allowDowngrade?: boolean },
): Promise<void> {
	const manifest = journal.manifest;
	if (!manifest) throw new ApplyError('NO_MANIFEST', 'journal has no manifest');
	const allowDowngrade = !!opts?.allowDowngrade;

	// 1. Re-hash own file (also proves reading our own mounted NRO works).
	const self = await hashWithUi(ui, 'Verifying update…', selfPath);
	if (self.rootHash !== manifest.rootHash) {
		transition(journal, 'failed', { failReason: 'self-hash-mismatch' });
		throw new ApplyError('SELF_HASH_MISMATCH', `staged self hash != journal manifest`);
	}
	log('self-verify-ok', { rootHash: self.rootHash, bytes: self.totalBytes });

	// 1b. IDEMPOTENT REFUSAL: if the installed build ALREADY equals the build we
	// would install, the swap is a no-op — a stale relaunch must not re-trigger a
	// destructive swap. Cheap size pre-filter first. Skipped for a RESTORE.
	if (!allowDowngrade) {
		const installed = Switch.statSync(BREWSER_NRO);
		if (installed && installed.size === self.totalBytes) {
			const inst = await hashWithUi(ui, 'Checking installed build…', BREWSER_NRO);
			if (inst.rootHash === self.rootHash) {
				log('self-apply-noop', { reason: 'already-installed', rootHash: self.rootHash });
				return;
			}
		}
	}

	let j = transition(journal, 'applying', allowDowngrade ? { allowDowngrade: true } : undefined);

	// 2. Pre-window cleanup (outside the destructive window). The visible
	// -previous.nro is deliberately NOT removed here — it must stay launchable
	// through the risky window in case THIS build is bad. It is superseded only
	// at boot-ok, once this build has proven itself.
	gfs.removeIfExists(SWAP_TMP);

	// 3. Long copy while the live binary is still intact: self → same-dir temp.
	ui.status('Installing update…');
	const endCopy = span('self-copy');
	await copyFile(selfPath, SWAP_TMP, (n, t) => ui.progress(n / t, `${mib(n)} / ${mib(t)}`));
	endCopy();

	// 4. Verify the copy before anything destructive happens.
	const copyHash = await hashWithUi(ui, 'Verifying install…', SWAP_TMP);
	if (copyHash.rootHash !== manifest.rootHash) {
		gfs.removeIfExists(SWAP_TMP);
		transition(j, 'failed', { failReason: 'copy-hash-mismatch' });
		throw new ApplyError('COPY_HASH_MISMATCH', 'temp copy hash mismatch — aborted before touching the installed NRO');
	}
	const magic = await nroMagicCheck(SWAP_TMP, manifest.nroSize);
	if (!magic.ok) {
		gfs.removeIfExists(SWAP_TMP);
		transition(j, 'failed', { failReason: 'copy-magic-mismatch' });
		throw new ApplyError('COPY_MAGIC', `temp copy failed NRO0/size check (magic=${magic.magic})`);
	}

	// 5. Clear the backup slot (still outside the window).
	gfs.removeIfExists(PREV_PATH);
	const firstInstall = !Switch.statSync(BREWSER_NRO);

	// 6. THE DESTRUCTIVE WINDOW — two metadata operations, timed.
	ui.status('Finalizing…');
	await nextFrames(2);
	const t0 = performance.now();
	let t1 = t0;
	if (!firstInstall) {
		gfs.rename(BREWSER_NRO, PREV_PATH); // cross-directory
		t1 = performance.now();
	}
	gfs.rename(SWAP_TMP, BREWSER_NRO); // same-directory
	const t2 = performance.now();
	const windowMs = t2 - t0;
	log('rename-window', {
		firstInstall,
		renameOldMs: Math.round((t1 - t0) * 1000) / 1000,
		renameNewMs: Math.round((t2 - t1) * 1000) / 1000,
		windowMs: Math.round(windowMs * 1000) / 1000,
	});

	j = transition(j, 'applied', { note: `windowMs=${windowMs.toFixed(2)}` });

	// 7. Chainload the final path.
	return chainload(BREWSER_NRO);
}

const MiB = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;

/** Enumerate exactly what remains on the card, with sizes (footprint audit). */
export function enumerateFootprint(): string[] {
	const durable: Array<[string, string]> = [
		[BREWSER_NRO, 'installed build'],
		[PREVIOUS_NRO, 'visible last-known-good'],
		[ANTI_ROLLBACK_PATH, 'anti-rollback high-water'],
	];
	const shouldBeGone: Array<[string, string]> = [
		[STAGED_PATH, 'staged payload'],
		[PART_PATH, 'download part'],
		[PREV_PATH, 'transient prev.bin'],
		[RECOVERY_ALIAS, 'recovery alias'],
		[SWAP_TMP, 'swap temp'],
	];
	const lines: string[] = ['RETAINED:'];
	let bytes = 0;
	for (const [p, what] of durable) {
		const s = Switch.statSync(p);
		if (s) {
			bytes += s.size;
			lines.push(`  ${p} — ${MiB(s.size)} (${what})`);
		} else {
			lines.push(`  ${p} — (absent) (${what})`);
		}
	}
	lines.push(`RETAINED TOTAL (excl. logs): ${MiB(bytes)}`);
	const leftovers = shouldBeGone.filter(([p]) => Switch.statSync(p));
	if (leftovers.length) {
		lines.push('UNEXPECTED LEFTOVERS:');
		for (const [p, what] of leftovers) lines.push(`  !! ${p} still present (${what})`);
	} else {
		lines.push('CLEANED: staged / part / prev.bin / alias / temp all gone.');
	}
	log('footprint', { lines });
	return lines;
}

/**
 * Read the versions THIS build shipped with (romfs:/configs/current.json) and
 * write them to the on-disk configs/current.json (via the dedicated single-file
 * guard). This clears the sticky "New Brewser Version available" banner, which
 * otherwise never clears because current.json is seeded missing-only and never
 * rewritten by the check. Best-effort — a failure just leaves the banner.
 */
async function stampCurrentJson(): Promise<void> {
	try {
		const resp = await fetch('romfs:/configs/current.json');
		if (!resp.ok) {
			log('current-json-stamp-skip', { reason: `romfs HTTP ${resp.status}` });
			return;
		}
		const text = await resp.text();
		JSON.parse(text); // validate before writing
		gfs.writeCurrentJson(text);
		log('current-json-stamped', { bytes: text.length });
	} catch (err) {
		log('current-json-stamp-error', { err: String(err) });
	}
}

/**
 * POST-APPLY-role: verify the running (installed) binary matches the journal,
 * then delete the now-stale recovery alias, promote the just-replaced build to
 * the VISIBLE last-known-good -previous.nro (a rename of prev.bin, not a second
 * copy), advance the anti-rollback high-water, delete the staged payload, stamp
 * current.json, and write boot-ok.
 */
export async function postApplyConfirm(ui: UpdaterUi, journal: Journal, selfPath: string): Promise<Journal> {
	const manifest = journal.manifest;
	let hashOk = false;
	let selfRoot = '(skipped)';
	if (manifest) {
		const self = await hashWithUi(ui, 'Confirming update…', selfPath);
		selfRoot = self.rootHash;
		hashOk = self.rootHash === manifest.rootHash;
	}
	const versionOk =
		journal.toVersion === '' ||
		journal.toVersion === '(rollback)' ||
		journal.toVersion === '(restore)' ||
		journal.toVersion === BREWSER_VERSION;
	log('post-apply-check', {
		hashOk,
		versionOk,
		runningVersion: BREWSER_VERSION,
		runningCounter: BREWSER_COUNTER,
		expectedVersion: journal.toVersion,
		selfRoot,
		expectedRoot: manifest?.rootHash,
	});
	if (!hashOk || !versionOk) {
		const j = transition(journal, 'failed', {
			failReason: `post-apply mismatch (hashOk=${hashOk} versionOk=${versionOk})`,
		});
		return j;
	}

	// Cleanup, in order:
	gfs.removeIfExists(RECOVERY_ALIAS); // 1. the alias was the NEW build — no longer needed
	if (Switch.statSync(PREV_PATH)) {
		gfs.removeIfExists(PREVIOUS_NRO); // 2. promote prev.bin → visible last-known-good
		gfs.rename(PREV_PATH, PREVIOUS_NRO);
		log('previous-nro-promoted', { from: PREV_PATH, to: PREVIOUS_NRO });
	}
	gfs.removeIfExists(STAGED_PATH); // 3. delete the staged payload
	const appliedCounter = manifest?.counter ?? BREWSER_COUNTER; // 4. advance high-water (never lowers)
	let highWater = appliedCounter;
	try {
		highWater = advanceHighWater(appliedCounter);
	} catch (err) {
		log('highwater-write-error', { err: String(err) });
	}
	await stampCurrentJson(); // 5. clear the "new version" banner

	const j = transition(journal, 'boot-ok', {
		appliedCounter,
		note: 'alias deleted; prev.bin→-previous.nro; staged deleted; high-water advanced; current.json stamped',
	});
	log('boot-ok', { appliedCounter, highWater, ...{ footprint: enumerateFootprint() } });
	return j;
}

/** Rollback: chainload the VISIBLE last-known-good -previous.nro, which boots
 * the RESTORE role and self-applies the older build (an intentional downgrade;
 * the high-water is NOT lowered). Callable from a shell menu. */
export async function rollback(): Promise<void> {
	if (!Switch.statSync(PREVIOUS_NRO)) {
		throw new ApplyError('NO_PREVIOUS', 'no -previous.nro to restore (none retained yet)');
	}
	await chainload(PREVIOUS_NRO); // boots RESTORE role; never returns on success
}

/**
 * Build a self-derived staged journal for RECOVERY (reinstall the new build) or
 * RESTORE (reinstall the older -previous.nro). The running binary IS the source;
 * it hashes itself and applies over the installed path.
 */
export async function buildSelfDerivedJournal(
	ui: UpdaterUi,
	runId: string,
	logFile: string,
	selfPath: string,
	kind: 'recovery' | 'restore',
): Promise<Journal> {
	const self = await hashWithUi(ui, kind === 'restore' ? 'Preparing restore…' : 'Preparing recovery…', selfPath);
	const stat = Switch.statSync(selfPath);
	const manifest: JournalManifest = {
		schema: 1,
		keyId: '(local)',
		version: BREWSER_VERSION,
		counter: BREWSER_COUNTER,
		nroSize: stat?.size ?? self.totalBytes,
		url: kind === 'restore' ? 'local:-previous.nro' : 'local:recovery-alias',
		chunkSize: 4 * 1024 * 1024,
		chunks: self.chunks,
		rootHash: self.rootHash,
	};
	const j: Journal = {
		state: 'staged',
		runId,
		logFile,
		fromVersion: kind === 'restore' ? '(installed)' : '(recovery)',
		toVersion: kind === 'restore' ? '(restore)' : BREWSER_VERSION,
		manifest,
		stagedPath: selfPath,
		recoveryReady: true,
		allowDowngrade: kind === 'restore',
		ts: { created: Date.now(), staged: Date.now() },
	};
	writeJournal(j);
	return j;
}
