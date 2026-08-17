#!/usr/bin/env node
/**
 * scripts/update/verify-release.mjs — release gate: prove that dist/update.json
 * + dist/brewser.nro are self-consistent and would be ACCEPTED on-device.
 *
 * It bundles the ACTUAL client verifier (src/update/verify.ts) with esbuild and
 * runs it against the keyring built from keys/{active,backup}.pub — i.e. the
 * exact code + trust anchors baked into the NRO. Then it re-hashes the real NRO
 * and checks chunks + rootHash + NRO0 magic against the signed manifest.
 *
 * Run: node scripts/update/verify-release.mjs [dist/update.json] [dist/brewser.nro]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashFile } from './manifest-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = process.argv[2] || join(root, 'dist', 'update.json');
const nroPath = process.argv[3] || join(root, 'dist', 'brewser.nro');

for (const p of [manifestPath, nroPath]) {
	if (!existsSync(p)) {
		console.error(`missing ${p}`);
		process.exit(1);
	}
}

// Keyring exactly as the NRO bakes it (public files).
const keyring = [];
for (const role of ['active', 'backup']) {
	const id = join(root, 'keys', `${role}.keyid`);
	const spki = join(root, 'keys', `${role}.pub.spki.b64`);
	if (existsSync(id) && existsSync(spki)) {
		keyring.push({ id: readFileSync(id, 'utf8').trim(), spki: readFileSync(spki, 'utf8').trim(), role });
	}
}
if (keyring.length === 0) {
	console.error('no keys/ found — cannot verify (run gen-keys.mjs)');
	process.exit(1);
}

// Bundle the real client verifier.
const outDir = mkdtempSync(join(tmpdir(), 'verify-release-'));
const outFile = join(outDir, 'verify.mjs');
execFileSync('node', [
	join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
	join(root, 'src', 'update', 'verify.ts'),
	'--bundle', '--format=esm', `--outfile=${outFile}`,
], { stdio: 'pipe' });
const { verifyManifestEnvelope } = await import(pathToFileURL(outFile).href);

let fail = 0;
const ok = (c, m) => (c ? console.log(`  PASS ${m}`) : (console.error(`  FAIL ${m}`), fail++));

// 1. Signature + shape via the actual client verifier + baked keyring.
let manifest;
try {
	manifest = await verifyManifestEnvelope(readFileSync(manifestPath, 'utf8'), keyring);
	ok(true, `signature verifies under baked key (v${manifest.version}, counter ${manifest.counter})`);
} catch (err) {
	ok(false, `verifyManifestEnvelope threw: ${err && err.reason ? err.reason : err}`);
	console.error(`\nRELEASE VERIFY FAILED.`);
	rmSync(outDir, { recursive: true, force: true });
	process.exit(1);
}

// 2. Re-hash the real NRO; chunks + rootHash must match the manifest.
const { chunks, rootHash, size } = await hashFile(nroPath);
ok(size === manifest.nroSize, `NRO size matches manifest (${size})`);
let firstMismatch = -1;
for (let i = 0; i < manifest.chunks.length; i++) if (chunks[i] !== manifest.chunks[i]) { firstMismatch = i; break; }
ok(chunks.length === manifest.chunks.length, `chunk count matches (${chunks.length})`);
ok(firstMismatch === -1, 'every chunk hash matches the manifest');
ok(rootHash === manifest.rootHash, 'root hash matches the manifest');

// 3. NRO0 magic.
const head = readFileSync(nroPath).subarray(0x10, 0x14).toString('latin1');
ok(head === 'NRO0', `NRO0 magic at 0x10 (got "${head}")`);

rmSync(outDir, { recursive: true, force: true });
console.log(fail === 0
	? `\n✅ Release verified — the console's verifier would ACCEPT this update.json + brewser.nro.`
	: `\n❌ ${fail} check(s) FAILED — do NOT publish.`);
process.exit(fail === 0 ? 0 : 1);
