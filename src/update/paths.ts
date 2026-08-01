/**
 * src/update/paths.ts — the safety kernel of the Brewser self-updater.
 *
 * ADAPTED from the hardware-proven `brewser-updater-test` rig, with the guard
 * INVERTED for production. The rig protected the real Brewser install by
 * DENYING `brewser.nro` and `sdmc:/switch/brewser/`. Here the updater IS
 * Brewser and legitimately swaps its own NRO, so the polarity flips:
 *
 *   - The installed NRO + a small, fixed set of swap/staging paths are the
 *     ALLOWED mutation surface (default-deny allow-list).
 *   - The user-data subtrees under `sdmc:/switch/brewser/` (configs, apps,
 *     shell, themes, logs, assets) are DENIED, checked first as defense in
 *     depth — the swap must never touch them even if the allow-list logic rots.
 *   - The single exception, `configs/current.json` (the post-apply version
 *     stamp), sits under the DENIED `configs/` tree and is therefore NOT
 *     reachable via `guardPath` at all — only the separate single-file
 *     `guardCurrentJson()` may target it.
 *
 * HARD RULE (mirrors the rig): every filesystem mutation goes through
 * `guardPath()` (via guarded-fs.ts) except the one current.json write. Pure
 * TypeScript with no runtime imports, so the host test
 * (tests/update-guardpath.test.mjs) exercises the exact code that ships.
 */

// ── The updater's mutation surface (allowed) ────────────────────────────────

/** The installed Brewser NRO — the swap target. The ONLY loose Brewser file in
 * `/switch/` the updater replaces (rig's TEST_NRO_PATH analogue). */
export const BREWSER_NRO = 'sdmc:/switch/brewser.nro';

/** Brewser's data root. User data lives here; the updater may write ONLY the
 * `update/` staging subtree below it (and, via a separate guard,
 * configs/current.json). Not itself an allowed mutation target. */
export const BREWSER_DATA_ROOT = 'sdmc:/switch/brewser/';

/** Updater staging directory (NO trailing slash). journal, anti-rollback,
 * payload.part / payload.staged, and prev.bin all live under here. */
export const UPDATE_DIR = 'sdmc:/switch/brewser/update';

/** Visible recovery alias: a launchable copy of the NEW build, created at stage
 * time so an interrupted swap is recoverable WITHOUT a PC. Deleted at boot-ok.
 * Top-level `.nro` so hbmenu lists it (rig's RECOVERY_ALIAS analogue). */
export const RECOVERY_ALIAS = 'sdmc:/switch/brewser-update.nro';

/** LEGACY — the removed restore-to-previous system's last-known-good alias.
 * No longer created or promoted (the RESTORE role + rollback were removed).
 * Retained ONLY so it stays in the guardPath allow-list and boot-ok can DELETE
 * a leftover copy from an install that predates the removal. */
export const PREVIOUS_NRO = 'sdmc:/switch/brewser-previous.nro';

/** Same-directory swap temp: `selfApply` copies the new binary here (same dir
 * as BREWSER_NRO) so the final rename is same-directory. Dot-prefixed and
 * non-`.nro` so hbmenu should not list it. */
export const SWAP_TMP = 'sdmc:/switch/.brewser.new';

/** The version stamp the applier rewrites post-apply so "New Brewser Version
 * available" clears (seeded missing-only + never rewritten by the check, so it
 * otherwise sticks forever). Written via `guardCurrentJson`, NOT `guardPath`. */
export const CURRENT_JSON_PATH = 'sdmc:/switch/brewser/configs/current.json';

// ── Denied user-data subtrees (defense in depth, checked BEFORE the allow
//    list). The swap must never mutate these. Deliberately NOT the blanket
//    data root and NOT `update/`, so staging still works. ─────────────────────
const FORBIDDEN_PREFIXES = [
	'sdmc:/switch/brewser/configs/',
	'sdmc:/switch/brewser/apps/',
	'sdmc:/switch/brewser/shell/',
	'sdmc:/switch/brewser/themes/',
	'sdmc:/switch/brewser/logs/',
	'sdmc:/switch/brewser/assets/',
];

export class GuardPathError extends Error {
	constructor(path: string, reason: string) {
		super(`guardPath REFUSED "${path}": ${reason}`);
		this.name = 'GuardPathError';
	}
}

/**
 * Normalize for comparison only (the original string is what gets used for the
 * actual FS call when allowed): lowercase (FAT is case-insensitive),
 * backslashes to forward slashes, collapse duplicate slashes.
 */
function normalize(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

const NORM_BREWSER_NRO = normalize(BREWSER_NRO);
const NORM_RECOVERY = normalize(RECOVERY_ALIAS);
const NORM_PREVIOUS = normalize(PREVIOUS_NRO);
const NORM_SWAP_TMP = normalize(SWAP_TMP);
const NORM_UPDATE_DIR = normalize(UPDATE_DIR); // no trailing slash
const NORM_CURRENT_JSON = normalize(CURRENT_JSON_PATH);

/**
 * Validate that `p` is a location the updater is allowed to mutate. Throws
 * GuardPathError otherwise. Returns the input path unchanged on success (case
 * preserved for the actual FS call).
 *
 * Allowed, exactly:
 *   - BREWSER_NRO
 *   - RECOVERY_ALIAS
 *   - PREVIOUS_NRO (legacy — kept deletable so boot-ok can clean up a leftover;
 *     never created anymore, the restore system was removed)
 *   - SWAP_TMP
 *   - UPDATE_DIR (the staging dir itself) and anything strictly under it
 * Everything else — including every user-data subtree and configs/current.json
 * — is denied here.
 */
export function guardPath(p: string): string {
	if (typeof p !== 'string' || p.length === 0) {
		throw new GuardPathError(String(p), 'empty or non-string path');
	}
	const norm = normalize(p);

	// Absolute sdmc: paths only. Anything else (relative, romfs:, file:) is
	// either not the SD card or resolves against an unknown cwd.
	if (!norm.startsWith('sdmc:/')) {
		throw new GuardPathError(p, 'not an absolute sdmc:/ path');
	}

	// No '.' or '..' segments, ever. The updater never needs them, and
	// rejecting them outright is simpler and stricter than resolving them.
	for (const seg of norm.slice('sdmc:/'.length).split('/')) {
		if (seg === '.' || seg === '..') {
			throw new GuardPathError(p, "'.'/'..' path segments are forbidden");
		}
	}

	// Deny-list FIRST — defense in depth, independent of the allow-list below.
	// User data must be untouchable by the swap even if the allow-list rots.
	for (const badPrefix of FORBIDDEN_PREFIXES) {
		if (norm.startsWith(badPrefix)) {
			throw new GuardPathError(p, `under forbidden user-data tree "${badPrefix}"`);
		}
	}

	if (norm === NORM_BREWSER_NRO) return p;
	if (norm === NORM_RECOVERY) return p;
	if (norm === NORM_PREVIOUS) return p; // legacy: kept deletable for boot-ok cleanup only
	if (norm === NORM_SWAP_TMP) return p;
	if (norm === NORM_UPDATE_DIR) return p; // the staging dir itself (mkdir target)
	// Strictly under UPDATE_DIR/ (the trailing slash + length check defeats a
	// prefix-collision sibling like `…/updateX/foo`).
	if (norm.startsWith(`${NORM_UPDATE_DIR}/`) && norm.length > NORM_UPDATE_DIR.length + 1) {
		return p;
	}

	throw new GuardPathError(p, 'not in the allowed set');
}

/**
 * Separate single-file guard for the post-apply version stamp. `current.json`
 * sits under the DENIED `configs/` tree, so it is deliberately unreachable via
 * `guardPath` — only this function may target it, and it accepts nothing else.
 */
export function guardCurrentJson(p: string): string {
	if (typeof p !== 'string' || normalize(p) !== NORM_CURRENT_JSON) {
		throw new GuardPathError(String(p), 'only configs/current.json may be written here');
	}
	return p;
}

/**
 * Canonicalize the launch path from `$.selfNroPath` / `Switch.argv[0]`.
 * hbmenu/hbloader may hand us the NRO path with or without the `sdmc:` scheme;
 * native fopen and role comparison both want the explicit `sdmc:/…` form.
 * No-op when already schemed. Does NOT relax guardPath — mutations still
 * require literal `sdmc:/`.
 */
export function canonicalizeLaunchPath(p: string): string {
	if (typeof p !== 'string' || p.length === 0) return p;
	const lower = p.toLowerCase();
	if (lower.startsWith('sdmc:/')) return p;
	if (p.startsWith('/')) return `sdmc:${p}`; // "/switch/x" -> "sdmc:/switch/x"
	if (lower.startsWith('switch/')) return `sdmc:/${p}`; // "switch/x" -> "sdmc:/switch/x"
	return p;
}

/** Join a relative name onto UPDATE_DIR (convenience; still guarded by use).
 * `underUpdate('')` returns UPDATE_DIR itself (no trailing slash) so it stays an
 * exact-allowed mkdir target — a trailing slash would fail guardPath. */
export function underUpdate(rel: string): string {
	if (rel.startsWith('/')) rel = rel.slice(1);
	return rel === '' ? UPDATE_DIR : `${UPDATE_DIR}/${rel}`;
}

/** Case-insensitive path equality (FAT semantics). */
export function samePath(a: string, b: string): boolean {
	return normalize(a) === normalize(b);
}

/** True if `p` is strictly under UPDATE_DIR (case-insensitive). */
export function isUnderUpdate(p: string): boolean {
	const n = normalize(p);
	return n.startsWith(`${NORM_UPDATE_DIR}/`) && n.length > NORM_UPDATE_DIR.length + 1;
}
