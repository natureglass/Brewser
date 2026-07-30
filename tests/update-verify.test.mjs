// Host-side test of the ACTUAL client verifier src/update/verify.ts against
// artifacts produced by the release tooling (scripts/update/manifest-lib.mjs).
// This proves the shipping verify path and the signer do NOT drift: verify.ts
// is bundled with the project's esbuild and exercised directly (its pure crypto
// path needs no nx.js runtime — chunkedHashFile/nroMagicCheck touch Switch and
// are simply not called here). Node's global crypto.subtle stands in for the
// device's native crypto; hardware still proves the native path agrees.
//
// Run: node tests/update-verify.test.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'update-verify-'));
const outFile = join(outDir, 'verify.mjs');
execFileSync('node', [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(ROOT, 'src', 'update', 'verify.ts'),
  '--bundle', '--format=esm', `--outfile=${outFile}`,
], { stdio: 'pipe' });

const { verifyManifestEnvelope, VerifyError, ENVELOPE_FORMAT } = await import(pathToFileURL(outFile).href);
const lib = await import(pathToFileURL(join(ROOT, 'scripts', 'update', 'manifest-lib.mjs')).href);
const { buildManifest, hashBytes, signEnvelope, generateEphemeralKey } = lib;

let pass = 0;
let fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.error(`  FAIL ${m}`)));

// Fake multi-chunk NRO payload → real chunks/rootHash the manifest must carry.
const payload = Buffer.alloc(Math.floor(9.5 * 1024 * 1024));
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
payload.write('NRO0', 0x10, 'latin1');
const { chunks, rootHash, size } = await hashBytes(payload);

const active = await generateEphemeralKey();
const backup = await generateEphemeralKey();
const keyring = [
  { id: active.keyId, spki: active.spkiB64, role: 'active' },
  { id: backup.keyId, spki: backup.spkiB64, role: 'backup' },
];
const goodFields = { version: '0.1.3', counter: 3, size, url: 'https://x/dist/brewser.nro', chunks, rootHash };

async function expectReason(reason, envelopeObj, label) {
  try {
    await verifyManifestEnvelope(JSON.stringify(envelopeObj), keyring);
    ok(false, `${label}: expected ${reason} but ACCEPTED`);
  } catch (err) {
    const got = err instanceof VerifyError ? err.reason : `(${err && err.message})`;
    ok(got === reason, `${label}: rejected ${got}${got === reason ? '' : ` (wanted ${reason})`}`);
  }
}

// POSITIVE: a tooling-signed active-key manifest verifies through verify.ts.
{
  const m = buildManifest({ keyId: active.keyId, ...goodFields });
  const env = await signEnvelope(m, active.privateKey);
  const got = await verifyManifestEnvelope(JSON.stringify(env), keyring);
  ok(got.version === '0.1.3' && got.counter === 3 && got.rootHash === rootHash, 'active-key manifest verifies via verify.ts');
}
// POSITIVE: backup-key manifest verifies too (dual-key).
{
  const m = buildManifest({ keyId: backup.keyId, ...goodFields });
  const env = await signEnvelope(m, backup.privateKey);
  const got = await verifyManifestEnvelope(JSON.stringify(env), keyring);
  ok(got.keyId === backup.keyId, 'backup-key manifest verifies via verify.ts');
}
// NEGATIVE: envelope format bump the client can't read.
{
  const m = buildManifest({ keyId: active.keyId, ...goodFields });
  const env = await signEnvelope(m, active.privateKey);
  await expectReason('ENVELOPE_FORMAT', { ...env, format: 'brewser-update/2' }, 'future format');
}
// NEGATIVE: signature made by a DIFFERENT trusted key than the envelope names.
{
  const m = buildManifest({ keyId: active.keyId, ...goodFields });
  const env = await signEnvelope(m, backup.privateKey, active.keyId); // sig by backup, claims active
  await expectReason('SIG_INVALID', env, 'wrong-key signature');
}
// NEGATIVE: unknown signing key (not in keyring) — no try-both.
{
  const stranger = await generateEphemeralKey();
  const m = buildManifest({ keyId: stranger.keyId, ...goodFields });
  const env = await signEnvelope(m, stranger.privateKey);
  await expectReason('KEY_UNKNOWN', env, 'unknown key');
}
// NEGATIVE: envelope.keyId ≠ signed payload.keyId (binding).
{
  const m = buildManifest({ keyId: backup.keyId, ...goodFields }); // payload says backup
  const env = await signEnvelope(m, active.privateKey, active.keyId); // sig by active, envelope says active
  await expectReason('KEY_ID_MISMATCH', env, 'keyId binding');
}
// NEGATIVE: wrong schema in an otherwise-valid signed payload.
{
  const bad = { schema: 2, keyId: active.keyId, ...goodFields, nroSize: size, chunkSize: 4 * 1024 * 1024 };
  const env = await signEnvelope(bad, active.privateKey);
  await expectReason('MANIFEST_SHAPE', env, 'schema != 1');
}
// NEGATIVE: chunk count inconsistent with nroSize.
{
  const bad = buildManifest({ keyId: active.keyId, ...goodFields });
  bad.chunks = bad.chunks.slice(0, bad.chunks.length - 1); // drop one → count != ceil(size/chunk)
  const env = await signEnvelope(bad, active.privateKey);
  await expectReason('MANIFEST_SHAPE', env, 'chunk count mismatch');
}
// NEGATIVE: signature byte flipped → 64-byte P1363 but verifies false.
{
  const m = buildManifest({ keyId: active.keyId, ...goodFields });
  const env = await signEnvelope(m, active.privateKey);
  const sig = Buffer.from(env.signature, 'base64');
  sig[10] ^= 0xff;
  await expectReason('SIG_INVALID', { ...env, signature: sig.toString('base64') }, 'flipped signature byte');
}

console.log(`\nformat under test: ${ENVELOPE_FORMAT}`);
console.log(`${pass} passed, ${fail} failed`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
