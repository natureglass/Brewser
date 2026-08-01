/**
 * src/update/config.ts — the one place that points the Brewser self-updater at
 * its release host + carries the compiled-in build identity and signing
 * keyring.
 *
 * ADAPTED from the brewser-updater-test rig's config.ts. The build-time values
 * (__BREWSER_*) are injected by esbuild `--define` in the NRO build step; a
 * build that forgets them fails loudly at module load (JSON.parse of undefined),
 * which is the intended tripwire. Nothing here is imported into the app's bundle
 * until the updater is wired into main.ts (Phase 4), so it stays dormant — and
 * therefore harmless — until the --define wiring lands.
 *
 * DECIDED (2026-07-29): host on raw.githubusercontent.com; the download URL is
 * derived HERE (not from the signed manifest), so a hosting move needs only a
 * client rebuild. The manifest authenticates the BYTES.
 */
import type { TrustedKey } from './verify';

// ── Release hosting (raw.githubusercontent.com/natureglass/Brewser/dist/) ────

/** The repo path the release NRO + manifest live at. `dist/` at the repo root
 * maps to D:\Workspace\brewser\dist\ locally (user-set). CONFIRM the branch
 * (`main` assumed) before the first release. */
const RELEASE_OWNER_REPO = 'natureglass/Brewser';
const RELEASE_REF = 'main';
const RELEASE_FOLDER = 'dist';
export const BASE_URL = `https://raw.githubusercontent.com/${RELEASE_OWNER_REPO}/${RELEASE_REF}/${RELEASE_FOLDER}`;

/** The signed manifest URL. */
export const MANIFEST_URL = `${BASE_URL}/update.json`;

/** The payload NRO URL (client-derived; the manifest's own `url` is advisory). */
export const PAYLOAD_URL = `${BASE_URL}/brewser.nro`;

/**
 * Redirect-hop host allowlist. raw.githubusercontent.com serves a DIRECT 200
 * (no redirect) — hardware-proven. GitHub Release assets 302 to
 * release-assets.githubusercontent.com, which HANGS un-abortably, so it is
 * deliberately absent. Every hop is logged; correct this from on-device
 * evidence if raw ever resolves through another host.
 */
export const HOST_ALLOWLIST = ['raw.githubusercontent.com'];

/** Force `accept-encoding: identity`: the payload is verified byte-for-byte, so
 * transfer compression only adds a decode path and breaks Content-Length ==
 * file size. */
export const IDENTITY_HEADERS: Record<string, string> = { 'accept-encoding': 'identity' };

// ── Timeouts (the runtime's fetch has NO built-in timeout, and abort does NOT
//    interrupt a stuck connect — HW finding; net.ts uses independent timers). ─
export const MANIFEST_TIMEOUT_MS = 20_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const DOWNLOAD_STALL_MS = 60_000;
export const MAX_REDIRECT_HOPS = 10;

/** Free-space preflight: need FREE_SPACE_MULTIPLIER × payload + margin. */
export const FREE_SPACE_MULTIPLIER = 3;
export const FREE_SPACE_MARGIN = 64 * 1024 * 1024;

// ── Compiled-in build identity + signing keyring (esbuild --define) ──────────

declare const __BREWSER_VERSION__: string; // semver of this build (display + ordering)
declare const __BREWSER_COUNTER__: number; // never-reused monotonic build number (anti-downgrade)
declare const __BREWSER_KEYRING_JSON__: string; // JSON [{id, spki, role}] — active + backup pubkeys

// DEFENSIVE: a build that forgets the --define must FAIL CLOSED, not crash at
// boot. `typeof <undeclared>` is the one access that doesn't throw, so it
// guards each constant; an unwired build gets version 0.0.0 / counter 0 / an
// EMPTY keyring — the empty keyring makes every update fail KEY_UNKNOWN, so no
// update can happen, but the app still boots normally. With the --define in
// place, esbuild replaces each `__BREWSER_*__` (incl. inside `typeof`) so the
// real values are used.

/** This build's semver (display + belt-and-braces ordering). */
export const BREWSER_VERSION: string =
	typeof __BREWSER_VERSION__ !== 'undefined' ? __BREWSER_VERSION__ : '0.0.0';

/** This build's never-reused monotonic counter — the primary, parse-bug-proof
 * half of the downgrade guard (see decide.ts). */
export const BREWSER_COUNTER: number =
	typeof __BREWSER_COUNTER__ !== 'undefined' ? __BREWSER_COUNTER__ : 0;

/** The TWO trusted signing keys (active + backup). A manifest names which keyId
 * signed it; the client verifies against THAT key only (no try-both fallback).
 * `role` is informational; trust is by keyId. An unwired build gets []. */
export const KEYRING: TrustedKey[] = (() => {
	try {
		return typeof __BREWSER_KEYRING_JSON__ !== 'undefined' ? JSON.parse(__BREWSER_KEYRING_JSON__) : [];
	} catch {
		return [];
	}
})();
