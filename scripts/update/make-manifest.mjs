#!/usr/bin/env node
/**
 * scripts/update/make-manifest.mjs — emit a signed update.json for a Brewser
 * release NRO.
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ RELEASE INVARIANT: `counter` is a NEVER-REUSED, monotonically        │
 *   │ increasing build number. It must be strictly greater than the last   │
 *   │ counter ever emitted — including for a re-release of the same semver. │
 *   │ This script persists the last emitted counter in keys/.release-      │
 *   │ counter and REFUSES to emit a counter ≤ it. Never edit that file to  │
 *   │ lower it. (A rolled-back user's anti-rollback high-water stays at the │
 *   │ bad build's counter; the fix must ship as a HIGHER counter.)          │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * The download URL is advisory here — the client downloads from its OWN pinned
 * config (raw natureglass/Brewser dist/), so moving the hosting location needs
 * only a client rebuild, not a manifest re-sign. The manifest authenticates the
 * BYTES (size + chunk hashes + rootHash).
 *
 * Usage:
 *   node scripts/update/make-manifest.mjs <payload.nro> <version> <counter> <payloadUrl> [outDir] [--key active|backup]
 *
 * Example (output lands in dist/ alongside brewser.nro, for pushing to
 * natureglass/Brewser dist/):
 *   node scripts/update/make-manifest.mjs dist/brewser.nro 0.1.3 3 \
 *     https://raw.githubusercontent.com/natureglass/Brewser/main/dist/brewser.nro \
 *     dist
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildManifest,
	hashFile,
	keyFingerprint,
	loadPrivateKey,
	signEnvelope,
	spkiDerFromPem,
} from './manifest-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
let keyRole = 'active';
const keyFlag = argv.indexOf('--key');
if (keyFlag >= 0) {
	keyRole = argv[keyFlag + 1];
	argv.splice(keyFlag, 2);
}
const [payloadPath, version, counterStr, payloadUrl, outDir = 'dist'] = argv;

if (!payloadPath || !version || !counterStr || !payloadUrl) {
	console.error(
		'Usage: node scripts/update/make-manifest.mjs <payload.nro> <version> <counter> <payloadUrl> [outDir] [--key active|backup]',
	);
	process.exit(1);
}
if (keyRole !== 'active' && keyRole !== 'backup') {
	console.error(`--key must be "active" or "backup", got "${keyRole}"`);
	process.exit(1);
}
if (!existsSync(payloadPath)) {
	console.error(`payload not found: ${payloadPath}`);
	process.exit(1);
}

const counter = Number(counterStr);
if (!Number.isInteger(counter) || counter <= 0) {
	console.error(`counter must be a positive integer, got "${counterStr}"`);
	process.exit(1);
}

// ── Never-reused counter enforcement ────────────────────────────────────
const counterFile = join(root, 'keys', '.release-counter');
let last = 0;
if (existsSync(counterFile)) {
	last = Number(readFileSync(counterFile, 'utf8').trim()) || 0;
}
if (counter <= last) {
	console.error(
		`REFUSING: counter ${counter} ≤ last emitted ${last}.\n` +
			`The counter must be strictly greater than every counter ever emitted,\n` +
			`including for a re-release of the same version. Bump it (${last + 1} or higher).`,
	);
	process.exit(1);
}

const privPath = join(root, 'keys', `${keyRole}.key.pem`);
const pubPath = join(root, 'keys', `${keyRole}.pub.pem`);
if (!existsSync(privPath) || !existsSync(pubPath)) {
	console.error(`missing ${keyRole} key (${privPath}) — run: node scripts/update/gen-keys.mjs`);
	process.exit(1);
}

const keyId = await keyFingerprint(spkiDerFromPem(readFileSync(pubPath, 'utf8')));
const { chunks, rootHash, size } = await hashFile(payloadPath);
const manifest = buildManifest({
	version,
	counter,
	keyId,
	size,
	url: payloadUrl,
	chunks,
	rootHash,
	components: { brewser: version, counter },
});
const privateKey = await loadPrivateKey(readFileSync(privPath, 'utf8'));
const envelope = await signEnvelope(manifest, privateKey);

const outPath = isAbsolute(outDir) ? outDir : join(root, outDir);
mkdirSync(outPath, { recursive: true });
const dst = join(outPath, 'update.json');
writeFileSync(dst, JSON.stringify(envelope, null, 2) + '\n');

// Persist the new high-water counter only after a successful write.
writeFileSync(counterFile, String(counter) + '\n');

console.log(`Wrote ${dst}`);
console.log(`  version:  ${version}`);
console.log(`  counter:  ${counter} (was ${last})`);
console.log(`  key:      ${keyRole} (${keyId})`);
console.log(`  size:     ${size} bytes (${(size / 1048576).toFixed(2)} MiB)`);
console.log(`  chunks:   ${chunks.length} × 4 MiB`);
console.log(`  rootHash: ${rootHash}`);
console.log(`  url:      ${payloadUrl}`);
console.log(`\nPush ${payloadPath} + ${dst} to natureglass/Brewser dist/ (git).`);
