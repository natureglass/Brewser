/**
 * src/update/decide.ts — the anti-downgrade decision (pure; host-testable).
 *
 * A NORMAL update requires BOTH: manifest.counter strictly greater than the
 * anti-rollback floor (never-reused counter — the primary, parse-bug-proof
 * guard) AND manifest.version strictly greater by semver (belt and braces).
 * `allowDowngrade` (RESTORE only) bypasses both; the NETWORK flow never passes
 * it, so a validly-signed OLD manifest is always refused.
 *
 * Extracted from the rig's flow.ts into its own pure module so the guard logic
 * is unit-tested independent of the UI-coupled flow.
 */
import type { JournalManifest } from './journal';

/**
 * Compare dotted-numeric semver cores. Returns -1 / 0 / 1, or NaN if either is
 * unparseable (fail-closed at the call site). Pre-release / build metadata is
 * stripped — the counter is the authoritative guard, semver is belt-and-braces.
 */
export function semverCmp(a: string, b: string): number {
	const core = (s: string) => s.split('+')[0].split('-')[0];
	const pa = core(a).split('.').map((x) => parseInt(x, 10));
	const pb = core(b).split('.').map((x) => parseInt(x, 10));
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

export interface UpdateDecision {
	accept: boolean;
	refuseCode?: 'DOWNGRADE_VERSION' | 'DOWNGRADE_COUNTER';
	runningVersion: string;
	runningCounter: number;
	floor: number;
	manifestVersion: string;
	manifestCounter: number;
}

/**
 * Decide whether `manifest` is a legitimate forward update given the running
 * build and the anti-rollback floor. `allowDowngrade` (RESTORE only) accepts
 * unconditionally; the network flow never passes it.
 */
export function decideUpdate(
	manifest: JournalManifest,
	runningVersion: string,
	runningCounter: number,
	floor: number,
	opts?: { allowDowngrade?: boolean },
): UpdateDecision {
	const allowDowngrade = !!opts?.allowDowngrade;
	const base = {
		runningVersion,
		runningCounter,
		floor,
		manifestVersion: manifest.version,
		manifestCounter: manifest.counter,
	};
	if (allowDowngrade) return { accept: true, ...base };
	if (manifest.counter <= floor) {
		return { accept: false, refuseCode: 'DOWNGRADE_COUNTER', ...base };
	}
	if (semverCmp(manifest.version, runningVersion) !== 1) {
		return { accept: false, refuseCode: 'DOWNGRADE_VERSION', ...base };
	}
	return { accept: true, ...base };
}
