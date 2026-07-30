/**
 * src/update/flow.ts — the download-side orchestration (INSTALLED role): fetch
 * signed manifest → verify signature → anti-downgrade decision → free-space
 * preflight → streamed download → chunked verify → stage (+ recovery alias).
 * On success it returns the staged journal; the caller (self-update-modal.js)
 * confirms with the user and chainloads the staged path.
 *
 * ADAPTED from the rig's flow.ts, with all UI removed: this module reports
 * through an injected `UpdaterUi` and THROWS FlowError on any failure — the
 * confirms / error surfaces live in the caller. Every failure is fail-closed
 * with a distinct reason, and the installed NRO's stat is snapshotted at start
 * and compared at exit so each run yields "brewser.nro untouched" evidence.
 */
import {
	BREWSER_COUNTER,
	BREWSER_VERSION,
	FREE_SPACE_MARGIN,
	FREE_SPACE_MULTIPLIER,
	KEYRING,
	MANIFEST_URL,
	PAYLOAD_URL,
} from './config';
import { PART_PATH, stageVerifiedPart } from './apply';
import { type UpdateDecision, decideUpdate } from './decide';
import * as gfs from './guarded-fs';
import {
	type Journal,
	type JournalManifest,
	newJournal,
	readHighWaterFloor,
	transition,
} from './journal';
import { getLogFile, log, span } from './log';
import { fetchText, streamDownload } from './net';
import { BREWSER_NRO, underUpdate } from './paths';
import { type UpdaterUi, mib } from './ui';
import {
	chunkedHashFile,
	firstChunkMismatch,
	nroMagicCheck,
	verifyManifestEnvelope,
} from './verify';

export class FlowError extends Error {
	constructor(
		public reason: string,
		message: string,
	) {
		super(message);
		this.name = 'FlowError';
	}
}

/** Fetch + signature-verify the manifest at `url` (default MANIFEST_URL). */
export async function fetchAndVerifyManifest(url: string = MANIFEST_URL): Promise<JournalManifest> {
	const endFetch = span('manifest-fetch');
	const { text } = await fetchText(url);
	endFetch({ bytes: text.length });
	const endVerify = span('manifest-verify');
	const manifest = await verifyManifestEnvelope(text, KEYRING);
	endVerify();
	log('manifest-ok', {
		version: manifest.version,
		counter: manifest.counter,
		nroSize: manifest.nroSize,
		chunks: manifest.chunks.length,
		keyId: manifest.keyId,
	});
	return manifest;
}

/** Anti-downgrade decision against the running build + high-water floor. */
export function decide(manifest: JournalManifest): UpdateDecision {
	const floor = readHighWaterFloor(BREWSER_COUNTER);
	const d = decideUpdate(manifest, BREWSER_VERSION, BREWSER_COUNTER, floor);
	log('update-decision', { ...d });
	return d;
}

/** Free-space preflight; throws FlowError('PREFLIGHT_SPACE') when short. */
export function preflightSpace(payloadSize: number, extraNeed = 0): void {
	const free = Switch.FileSystem.openSdmc().freeSpace();
	const need = BigInt(payloadSize * FREE_SPACE_MULTIPLIER + FREE_SPACE_MARGIN + extraNeed);
	log('preflight-space', { free: free.toString(), need: need.toString(), payloadSize });
	if (free < need) {
		throw new FlowError(
			'PREFLIGHT_SPACE',
			`insufficient free space: have ${free} bytes, need ${need} (${FREE_SPACE_MULTIPLIER}× payload + margin)`,
		);
	}
}

export interface NroSnapshot {
	exists: boolean;
	size?: number;
	mtime?: number;
}

export function snapshotInstalledNro(): NroSnapshot {
	const s = Switch.statSync(BREWSER_NRO);
	return s ? { exists: true, size: s.size, mtime: s.mtime } : { exists: false };
}

export function assertInstalledNroUntouched(before: NroSnapshot, context: string): boolean {
	const s = Switch.statSync(BREWSER_NRO);
	const after: NroSnapshot = s ? { exists: true, size: s.size, mtime: s.mtime } : { exists: false };
	const same = before.exists === after.exists && before.size === after.size && before.mtime === after.mtime;
	log('installed-nro-mutation-check', { context, before, after, untouched: same });
	return same;
}

/**
 * Download the payload to PART_PATH (streamed) and fully verify it. The download
 * URL is the client-configured PAYLOAD_URL — the manifest authenticates the
 * BYTES (size + chunk hashes + rootHash), not the location.
 */
export async function downloadAndVerifyPayload(
	ui: UpdaterUi,
	manifest: JournalManifest,
	opts?: { destPath?: string; url?: string; signal?: AbortSignal },
): Promise<void> {
	const dest = opts?.destPath ?? PART_PATH;
	const downloadUrl = opts?.url ?? PAYLOAD_URL;
	gfs.mkdir(underUpdate(''));
	gfs.removeIfExists(dest);

	ui.status('Downloading update…');
	const endDl = span('download');
	let bytes = 0;
	try {
		const res = await streamDownload(
			downloadUrl,
			dest,
			manifest.nroSize,
			(n, t) => ui.progress(n / t, `${mib(n)} / ${mib(t)}`),
			{ signal: opts?.signal },
		);
		bytes = res.bytes;
	} finally {
		endDl({ bytes });
	}

	if (bytes !== manifest.nroSize) {
		throw new FlowError('SIZE_MISMATCH', `downloaded ${bytes} bytes but manifest says ${manifest.nroSize}`);
	}

	ui.status('Verifying update…');
	const endVerify = span('chunk-verify');
	let actual;
	try {
		actual = await chunkedHashFile(dest, manifest.chunkSize, (n) => ui.progress(n / manifest.nroSize, `${mib(n)} hashed`));
	} finally {
		endVerify();
	}

	const mismatch = firstChunkMismatch(actual.chunks, manifest.chunks);
	if (mismatch >= 0) {
		throw new FlowError('CHUNK_MISMATCH', `chunk ${mismatch} hash mismatch`);
	}
	if (actual.rootHash !== manifest.rootHash) {
		throw new FlowError('ROOT_MISMATCH', 'all chunks match but root hash differs');
	}
	const magic = await nroMagicCheck(dest, manifest.nroSize);
	if (!magic.ok) {
		throw new FlowError('NRO_MAGIC', `payload failed NRO0 magic/size check (magic="${magic.magic}")`);
	}
}

export interface DownloadStageResult {
	journal: Journal;
	decision: UpdateDecision;
	manifest: JournalManifest;
}

/**
 * The full INSTALLED-role download+stage. Returns the staged journal on success
 * (the caller chainloads `journal.stagedPath`), or a not-accepted decision when
 * the offered build is not strictly newer (no download performed). THROWS
 * FlowError on any failure after acceptance — the installed NRO is never touched
 * by this path (staging only writes under update/ + the recovery alias).
 */
export async function runDownloadAndStage(
	ui: UpdaterUi,
	runId: string,
	opts?: { signal?: AbortSignal },
): Promise<DownloadStageResult> {
	const before = snapshotInstalledNro();
	log('flow-start', { runId, before });

	ui.status('Checking for updates…');
	const manifest = await fetchAndVerifyManifest();
	const decision = decide(manifest);
	if (!decision.accept) {
		// Not an error — just nothing to do. Caller shows "up to date".
		return { journal: newJournal(runId, getLogFile(), BREWSER_VERSION), decision, manifest };
	}

	preflightSpace(manifest.nroSize);
	await downloadAndVerifyPayload(ui, manifest, { signal: opts?.signal });

	let j: Journal = newJournal(runId, getLogFile(), BREWSER_VERSION);
	j = transition(j, 'downloaded', { toVersion: manifest.version, manifest });
	j = await stageVerifiedPart(ui, j, manifest);

	assertInstalledNroUntouched(before, 'pre-chainload (staging never touches the installed NRO)');
	return { journal: j, decision, manifest };
}
