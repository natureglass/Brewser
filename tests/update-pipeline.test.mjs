// Host-side proof that the self-update sign/verify/hash pipeline is
// self-consistent AND fails closed on tampering (Phase 1, second no-hardware
// gate). Hermetic: it mints THROWAWAY ephemeral keys in-process, so it needs no
// keys/ dir and mints no production trust root. It re-implements the client
// verify path EXACTLY as src/update/verify.ts will (envelope keyId selection →
// ECDSA-P256 P1363 over the raw payload bytes → payload.keyId binding →
// SHA-256 per 4 MiB chunk → root = SHA-256 over concatenated raw chunk digests
// → NRO0 magic). Hardware still proves the runtime's NATIVE crypto agrees.
//
// Run: node tests/update-pipeline.test.mjs

import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { subtle } = webcrypto;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(pathToFileURL(join(ROOT, 'scripts', 'update', 'manifest-lib.mjs')).href);
const { CHUNK_SIZE, ENVELOPE_FORMAT, buildManifest, hashBytes, signEnvelope, generateEphemeralKey } = lib;

let fail = 0;
let pass = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.error(`  FAIL ${m}`)));

// ── Build a realistic multi-chunk fake NRO payload (9.5 MiB → 3 chunks) ────
function makeNro(bytes) {
	const buf = Buffer.alloc(bytes);
	// Fill with a deterministic pattern so chunk boundaries carry real content.
	for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + 7) & 0xff;
	buf.write('NRO0', 0x10, 'latin1'); // magic verify.ts asserts at 0x10
	return buf;
}
const PAYLOAD = makeNro(Math.floor(9.5 * 1024 * 1024));

// ── The baked keyring the client would compile in (active + backup) ────────
const active = await generateEphemeralKey();
const backup = await generateEphemeralKey();
const keyring = [
	{ id: active.keyId, spki: active.spkiB64, role: 'active' },
	{ id: backup.keyId, spki: backup.spkiB64, role: 'backup' },
];

// ── Re-implementation of the client verify path (mirrors verify.ts) ────────
async function importKeyById(keyId) {
	const trusted = keyring.find((k) => k.id === keyId);
	if (!trusted) throw new Error('KEY_UNKNOWN');
	return subtle.importKey('spki', Buffer.from(trusted.spki, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}
async function verifyEnvelope(env) {
	if (env.format !== ENVELOPE_FORMAT) throw new Error('ENVELOPE_FORMAT');
	if (typeof env.keyId !== 'string' || !env.keyId) throw new Error('ENVELOPE_FIELDS');
	const payloadBytes = Buffer.from(env.payload, 'base64');
	const sigBytes = Buffer.from(env.signature, 'base64');
	if (sigBytes.length !== 64) throw new Error('SIG_FORMAT');
	const key = await importKeyById(env.keyId); // throws KEY_UNKNOWN
	const good = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, payloadBytes);
	if (!good) throw new Error('SIG_INVALID');
	const m = JSON.parse(payloadBytes.toString('utf8'));
	if (m.keyId !== env.keyId) throw new Error('KEY_ID_MISMATCH');
	if (m.schema !== 1) throw new Error('MANIFEST_SHAPE');
	if (!/^k_[0-9a-f]{16}$/.test(m.keyId)) throw new Error('MANIFEST_SHAPE');
	if (!Number.isInteger(m.counter) || m.counter <= 0) throw new Error('MANIFEST_SHAPE');
	if (m.chunkSize !== CHUNK_SIZE) throw new Error('MANIFEST_SHAPE');
	if (!Array.isArray(m.chunks) || m.chunks.length !== Math.ceil(m.nroSize / m.chunkSize)) throw new Error('MANIFEST_SHAPE');
	return m;
}
async function verifyPayload(m, data) {
	if (data.length !== m.nroSize) throw new Error('SIZE_MISMATCH');
	const { chunks, rootHash } = await hashBytes(data);
	for (let i = 0; i < m.chunks.length; i++) if (chunks[i] !== m.chunks[i]) throw new Error('CHUNK_MISMATCH');
	if (rootHash !== m.rootHash) throw new Error('ROOT_MISMATCH');
	if (data.toString('latin1', 0x10, 0x14) !== 'NRO0') throw new Error('NRO_MAGIC');
}
async function expectThrow(reason, fn) {
	try {
		await fn();
		ok(false, `expected ${reason}, but it was ACCEPTED`);
	} catch (err) {
		ok(err.message === reason, `rejected with ${reason}${err.message === reason ? '' : ` (got ${err.message})`}`);
	}
}

// ── POSITIVE: active-key manifest verifies + payload matches ───────────────
const { chunks, rootHash, size } = await hashBytes(PAYLOAD);
const manifest = buildManifest({
	version: '0.1.3', counter: 3, keyId: active.keyId, size,
	url: 'https://raw.githubusercontent.com/natureglass/Brewser/main/dist/brewser.nro',
	chunks, rootHash, components: { brewser: '0.1.3' },
});
const envelope = await signEnvelope(manifest, active.privateKey);
ok(envelope.format === ENVELOPE_FORMAT, `envelope format ${ENVELOPE_FORMAT}`);
ok(size === Math.floor(9.5 * 1024 * 1024) && chunks.length === 3, `payload 9.5 MiB → ${chunks.length} chunks`);
{
	const m = await verifyEnvelope(envelope);
	await verifyPayload(m, PAYLOAD);
	ok(true, 'active-key manifest verifies + payload matches (full positive path)');
}

// ── POSITIVE: backup-key manifest also verifies ────────────────────────────
{
	const bm = buildManifest({ version: '0.1.3', counter: 3, keyId: backup.keyId, size, url: 'x', chunks, rootHash });
	const be = await signEnvelope(bm, backup.privateKey);
	const m = await verifyEnvelope(be);
	ok(m.keyId === backup.keyId, 'backup-key manifest verifies (dual-key)');
}

// ── NEGATIVE: tampered payload → CHUNK_MISMATCH ────────────────────────────
await expectThrow('CHUNK_MISMATCH', async () => {
	const bad = Buffer.from(PAYLOAD);
	bad[5 * 1024 * 1024] ^= 0xff; // flip a byte in chunk 2
	const m = await verifyEnvelope(envelope);
	await verifyPayload(m, bad);
});

// ── NEGATIVE: truncated payload → SIZE_MISMATCH ────────────────────────────
await expectThrow('SIZE_MISMATCH', async () => {
	const m = await verifyEnvelope(envelope);
	await verifyPayload(m, PAYLOAD.subarray(0, PAYLOAD.length - 1024));
});

// ── NEGATIVE: wrong-key signature under a trusted keyId → SIG_INVALID ───────
await expectThrow('SIG_INVALID', async () => {
	// Sign with backup's PRIVATE key but claim active's keyId (in keyring).
	const forged = { ...manifest, keyId: active.keyId };
	const env = await signEnvelope(forged, backup.privateKey, active.keyId);
	await verifyEnvelope(env);
});

// ── NEGATIVE: unknown signing key → KEY_UNKNOWN (no try-both fallback) ──────
await expectThrow('KEY_UNKNOWN', async () => {
	const stranger = await generateEphemeralKey();
	const sm = buildManifest({ version: '9.9.9', counter: 99, keyId: stranger.keyId, size, url: 'x', chunks, rootHash });
	const env = await signEnvelope(sm, stranger.privateKey);
	await verifyEnvelope(env); // stranger.keyId not in keyring
});

// ── NEGATIVE: envelope.keyId ≠ payload.keyId → KEY_ID_MISMATCH ──────────────
await expectThrow('KEY_ID_MISMATCH', async () => {
	// Valid signature by active, but envelope advertises backup's keyId. Both
	// keys are trusted, so importKey succeeds and the sig verifies — the BINDING
	// check (payload.keyId === envelope.keyId) is what must catch it.
	const env = await signEnvelope(manifest, active.privateKey, backup.keyId);
	// Re-sign the payload bytes with backup so the sig passes under backup's key,
	// but the SIGNED payload still says keyId=active → binding fails.
	const payloadBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
	const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, backup.privateKey, payloadBytes));
	env.signature = Buffer.from(sig).toString('base64');
	await verifyEnvelope(env);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
