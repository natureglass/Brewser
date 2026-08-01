/**
 * src/update/journal.ts — crash-consistent state that survives chainloads and
 * power loss. One JSON file under UPDATE_DIR. Corrupt or truncated content must
 * never crash the updater: readJournal() degrades to a typed "corrupt" result
 * instead of throwing.
 *
 * ADAPTED from the brewser-updater-test rig's journal.ts (re-targeted paths).
 */
import * as gfs from './guarded-fs';
import { underUpdate } from './paths';

export const JOURNAL_PATH = underUpdate('journal.json');
const JOURNAL_TMP = underUpdate('journal.json.tmp');

/**
 * Anti-rollback high-water file. Holds the highest build `counter` ever
 * successfully applied on this card. Separate from the transient journal so a
 * new flow's newJournal() cannot silently lower the floor. NEVER lowered — not
 * even by an intentional RESTORE.
 */
export const ANTI_ROLLBACK_PATH = underUpdate('anti-rollback.json');
const ANTI_ROLLBACK_TMP = underUpdate('anti-rollback.json.tmp');

export type JournalState =
	| 'idle'
	| 'downloading'
	| 'downloaded'
	| 'staged'
	| 'applying'
	| 'applied'
	| 'boot-ok'
	| 'failed';

/** Embedded copy of the verified manifest (or a self-derived one for
 * recovery/restore). Self-derived manifests set keyId '(local)'. */
export interface JournalManifest {
	schema: 1;
	keyId: string; // fingerprint of the verifying key, or '(local)' for self-derived
	version: string; // semver (display + ordering)
	counter: number; // never-reused monotonic build number (anti-downgrade)
	nroSize: number;
	url: string;
	chunkSize: number;
	chunks: string[]; // hex SHA-256 per chunk
	rootHash: string; // hex SHA-256 over concatenated raw chunk digests
	components?: Record<string, unknown>; // display-only metadata
}

export interface Journal {
	state: JournalState;
	runId: string;
	logFile: string;
	fromVersion: string;
	toVersion: string;
	manifest: JournalManifest | null;
	stagedPath: string | null;
	recoveryReady: boolean;
	appliedCounter?: number;
	/** ms timestamps keyed by state transition, for the timeline. */
	ts: Record<string, number>;
	failReason?: string;
	note?: string;
}

export type JournalReadResult =
	| { ok: true; journal: Journal }
	| { ok: false; missing: true }
	| { ok: false; missing?: false; corrupt: true; raw: string; error: string };

export function readJournal(): JournalReadResult {
	let raw: string;
	try {
		const stat = Switch.statSync(JOURNAL_PATH);
		if (!stat) return { ok: false, missing: true };
		const buf = Switch.readFileSync(JOURNAL_PATH);
		if (!buf) return { ok: false, missing: true };
		raw = new TextDecoder().decode(buf);
	} catch (err) {
		return { ok: false, corrupt: true, raw: '', error: String(err) };
	}
	try {
		const j = JSON.parse(raw);
		if (typeof j !== 'object' || j === null || typeof j.state !== 'string') {
			return { ok: false, corrupt: true, raw, error: 'missing required fields' };
		}
		return { ok: true, journal: j as Journal };
	} catch (err) {
		return { ok: false, corrupt: true, raw, error: String(err) };
	}
}

/**
 * Write via tmp + remove + rename. Not atomic on HOS (rename does not
 * overwrite), but keeps the window where the journal is absent to a single
 * metadata op instead of a partial write.
 */
export function writeJournal(j: Journal): void {
	const body = JSON.stringify(j, null, 2);
	gfs.mkdir(underUpdate(''));
	gfs.writeFile(JOURNAL_TMP, body);
	gfs.removeIfExists(JOURNAL_PATH);
	gfs.rename(JOURNAL_TMP, JOURNAL_PATH);
}

export function newJournal(runId: string, logFile: string, fromVersion: string): Journal {
	return {
		state: 'idle',
		runId,
		logFile,
		fromVersion,
		toVersion: '',
		manifest: null,
		stagedPath: null,
		recoveryReady: false,
		ts: { created: Date.now() },
	};
}

export function transition(j: Journal, state: JournalState, extra?: Partial<Journal>): Journal {
	const next: Journal = { ...j, ...extra, state };
	next.ts = { ...j.ts, [state]: Date.now() };
	writeJournal(next);
	return next;
}

export function deleteJournal(): void {
	gfs.removeIfExists(JOURNAL_TMP);
	gfs.removeIfExists(JOURNAL_PATH);
}

// ── Anti-rollback high-water ─────────────────────────────────────────────

/** Raw stored high-water counter, or null if the file is missing/corrupt. */
function readHighWaterRaw(): number | null {
	try {
		const stat = Switch.statSync(ANTI_ROLLBACK_PATH);
		if (!stat) return null;
		const buf = Switch.readFileSync(ANTI_ROLLBACK_PATH);
		if (!buf) return null;
		const j = JSON.parse(new TextDecoder().decode(buf));
		if (typeof j?.counter === 'number' && Number.isInteger(j.counter) && j.counter >= 0) {
			return j.counter;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * The effective anti-rollback floor = max(runningCounter, stored). On a
 * missing/unparseable/corrupt file, fall back to `runningCounter` — NEVER to 0.
 * Since runningCounter is baked into the binary, that fallback is already a
 * strong anchor and losing the file only relaxes the floor to the running
 * build. (Anyone who can edit the SD can replace the NRO outright; this file is
 * not defending against that.)
 */
export function readHighWaterFloor(runningCounter: number): number {
	const stored = readHighWaterRaw();
	return Math.max(runningCounter, stored ?? runningCounter);
}

/** Raise the high-water to `counter` if higher. NEVER lowers it. Returns the new
 * value. Best-effort: a write failure is non-fatal (logged by caller). */
export function advanceHighWater(counter: number): number {
	const cur = readHighWaterRaw() ?? 0;
	const next = Math.max(cur, counter);
	if (next !== cur || readHighWaterRaw() === null) {
		gfs.mkdir(underUpdate(''));
		gfs.writeFile(ANTI_ROLLBACK_TMP, JSON.stringify({ counter: next }));
		gfs.removeIfExists(ANTI_ROLLBACK_PATH);
		gfs.rename(ANTI_ROLLBACK_TMP, ANTI_ROLLBACK_PATH);
	}
	return next;
}
