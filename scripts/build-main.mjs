#!/usr/bin/env node
/**
 * scripts/build-main.mjs — esbuild bundle of src/main.ts, INJECTING the
 * self-updater's build identity + signing keyring via `--define`.
 *
 * Replaces the plain `esbuild` CLI in package.json's "build" script. Identical
 * esbuild options (bundle, sourcemap, no sources-content, es2022, esm,
 * outdir=build) plus three defines the updater's config.ts reads:
 *   __BREWSER_VERSION__      <- package.json version
 *   __BREWSER_COUNTER__      <- scripts/update/build-info.json counter
 *   __BREWSER_KEYRING_JSON__ <- keys/{active,backup}.{keyid,pub.spki.b64}
 *
 * If the keys are absent, the keyring bakes as [] and the app still builds and
 * boots normally — config.ts is defensive, so every update simply fails closed
 * (KEY_UNKNOWN). This keeps a keyless dev build working.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '0.0.0');

let counter = 0;
try {
	counter = Number(JSON.parse(readFileSync(join(root, 'scripts', 'update', 'build-info.json'), 'utf8')).counter) || 0;
} catch {
	console.warn('[build-main] scripts/update/build-info.json missing/invalid — counter=0');
}

// Assemble the baked keyring [{ id, spki, role }] from the public key files.
function readKey(role) {
	const spkiPath = join(root, 'keys', `${role}.pub.spki.b64`);
	const idPath = join(root, 'keys', `${role}.keyid`);
	if (!existsSync(spkiPath) || !existsSync(idPath)) return null;
	return { id: readFileSync(idPath, 'utf8').trim(), spki: readFileSync(spkiPath, 'utf8').trim(), role };
}
const keyring = [readKey('active'), readKey('backup')].filter(Boolean);
if (keyring.length === 0) {
	console.warn('[build-main] no keys/ found — baking EMPTY keyring (updates will fail closed). Run: node scripts/update/gen-keys.mjs');
} else {
	console.log(`[build-main] keyring: ${keyring.map((k) => `${k.role}=${k.id}`).join(', ')}`);
}
console.log(`[build-main] version=${version} counter=${counter}`);

await esbuild.build({
	entryPoints: [join(root, 'src', 'main.ts')],
	bundle: true,
	sourcemap: true,
	sourcesContent: false,
	target: 'es2022',
	format: 'esm',
	outdir: join(root, 'build'),
	define: {
		__BREWSER_VERSION__: JSON.stringify(version),
		__BREWSER_COUNTER__: JSON.stringify(counter),
		// Double-encode: the token is replaced by a STRING LITERAL whose value is
		// the JSON text; config.ts then JSON.parse()s it.
		__BREWSER_KEYRING_JSON__: JSON.stringify(JSON.stringify(keyring)),
	},
	logLevel: 'info',
});
