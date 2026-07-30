#!/usr/bin/env node
/**
 * scripts/bump-version.mjs — bump the Brewser release version + build counter
 * for a self-update release (run by `make` / `make release`).
 *
 * Both must advance EVERY release, for different halves of the update:
 *   - package.json `version` (patch bump, e.g. 0.1.2 → 0.1.3): the semver the
 *     runtime's versions check string-compares. It flows into
 *     romfs/configs/current.json (baked, "what I shipped with") and the served
 *     versions.json, so an OLDER install DETECTS the newer build.
 *   - scripts/update/build-info.json `counter` (+1): the never-reused monotonic
 *     anti-downgrade counter baked into the NRO (__BREWSER_COUNTER__) and
 *     emitted in the signed manifest, so the client ACCEPTS the update and
 *     refuses a rollback.
 *
 * Surgical string edits (not a full JSON rewrite) so the rest of each file —
 * key order, comments, formatting — is untouched and the git diff stays to the
 * two changed numbers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const biPath = join(root, 'scripts', 'update', 'build-info.json');

// ── package.json version: patch bump ────────────────────────────────────────
let pkgText = readFileSync(pkgPath, 'utf8');
const vm = pkgText.match(/"version"\s*:\s*"([^"]+)"/);
if (!vm) {
	console.error('[bump] package.json has no "version" field');
	process.exit(1);
}
const oldVersion = vm[1];
const parts = oldVersion.split('.');
const li = parts.length - 1;
const patch = parseInt(String(parts[li]).replace(/[^0-9].*$/, ''), 10);
if (!Number.isFinite(patch)) {
	console.error(`[bump] cannot parse a patch number from version "${oldVersion}"`);
	process.exit(1);
}
parts[li] = String(patch + 1);
const newVersion = parts.join('.');
pkgText = pkgText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${newVersion}$2`);
writeFileSync(pkgPath, pkgText);

// ── build-info.json counter: +1 ─────────────────────────────────────────────
let biText = readFileSync(biPath, 'utf8');
const cm = biText.match(/"counter"\s*:\s*(\d+)/);
if (!cm) {
	console.error('[bump] scripts/update/build-info.json has no "counter" field');
	process.exit(1);
}
const oldCounter = Number(cm[1]);
const newCounter = oldCounter + 1;
biText = biText.replace(/("counter"\s*:\s*)\d+/, `$1${newCounter}`);
writeFileSync(biPath, biText);

console.log(`[bump] version ${oldVersion} → ${newVersion}   counter ${oldCounter} → ${newCounter}`);
