#!/usr/bin/env node
/**
 * scripts/update/gen-keys.mjs — generate the TWO ECDSA P-256 signing keypairs
 * the Brewser client bakes as a keyring: `active` and `backup` (key rotation).
 *
 * For each role R in {active, backup} writes under brewser-v8/keys/:
 *   <R>.key.pem         PKCS8 private key   (GITIGNORED — local only)
 *   <R>.pub.pem         SPKI public key (PEM, for humans)
 *   <R>.pub.spki.b64    SPKI public key (base64 DER, one line) — baked into NRO
 *   <R>.keyid           the fingerprint "k_<16 hex>" — baked in + humans
 *
 * The two pubkeys + fingerprints are compiled into the NRO as a keyring at build
 * time (esbuild --define __BREWSER_KEYRING_JSON__). The `backup` PRIVATE key is
 * meant to be moved OFFLINE after generation and never used routinely.
 *
 * The keyId is role-INDEPENDENT: it is the fingerprint of the key, so today's
 * `backup` keeps the same id when it becomes tomorrow's `active`. "active" /
 * "backup" are only file names / client roles, never part of the id.
 *
 * Refuses to overwrite an existing private key unless --force is passed, so you
 * don't silently invalidate an already-published pubkey. --force regenerates
 * BOTH; to rotate ONE key deliberately, replace its files by hand.
 *
 * DELIBERATE: this mints the production trust root. Run it only when you are
 * ready to safeguard keys/backup.key.pem offline. The hermetic pipeline test
 * (tests/update-pipeline.test.mjs) uses throwaway ephemeral keys, so it does
 * NOT require these files.
 *
 * Run: node scripts/update/gen-keys.mjs
 */
import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { subtle } = webcrypto;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const keysDir = join(root, 'keys');
mkdirSync(keysDir, { recursive: true });
const force = process.argv.includes('--force');

function toPem(der, label) {
	const b64 = Buffer.from(der).toString('base64');
	const lines = b64.match(/.{1,64}/g).join('\n');
	return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

async function fingerprint(spkiDer) {
	const h = Buffer.from(await subtle.digest('SHA-256', spkiDer)).toString('hex');
	return `k_${h.slice(0, 16)}`;
}

async function genRole(role) {
	const privPath = join(keysDir, `${role}.key.pem`);
	if (existsSync(privPath) && !force) {
		console.error(
			`Refusing to overwrite ${privPath} (pass --force to regenerate BOTH keys).\n` +
				`Regenerating invalidates any NRO already built with the old keyring.`,
		);
		process.exit(1);
	}
	const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', kp.privateKey));
	const spki = Buffer.from(await subtle.exportKey('spki', kp.publicKey));
	const spkiB64 = spki.toString('base64');
	const keyId = await fingerprint(spki);

	writeFileSync(privPath, toPem(pkcs8, 'PRIVATE KEY'));
	writeFileSync(join(keysDir, `${role}.pub.pem`), toPem(spki, 'PUBLIC KEY'));
	writeFileSync(join(keysDir, `${role}.pub.spki.b64`), spkiB64 + '\n');
	writeFileSync(join(keysDir, `${role}.keyid`), keyId + '\n');
	return { role, keyId };
}

const active = await genRole('active');
const backup = await genRole('backup');

console.log('Wrote keyring (active + backup) to keys/:');
for (const k of [active, backup]) {
	console.log(`  ${k.role}: keyId ${k.keyId}  (${k.role}.key.pem / ${k.role}.pub.spki.b64 / ${k.role}.keyid)`);
}
console.log('\nNEXT:');
console.log('  - Move keys/backup.key.pem OFFLINE (do not use it routinely).');
console.log('  - Rebuild the NRO so the keyring is compiled in (esbuild --define).');
