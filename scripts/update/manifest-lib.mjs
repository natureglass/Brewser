/**
 * scripts/update/manifest-lib.mjs — shared helpers for the Brewser self-update
 * release tooling (gen-keys / make-manifest) and the host pipeline test.
 *
 * ADAPTED from the brewser-updater-test rig's manifest-lib.mjs. The chunking /
 * root-hash / envelope logic here MUST stay byte-compatible with the client
 * verifier (src/update/verify.ts once ported): CHUNK_SIZE, SHA-256 per chunk,
 * root = SHA-256 over concatenated raw chunk digests, and the ECDSA-P256 /
 * P1363 signature the runtime's crypto.subtle.verify expects.
 *
 * Production envelope format "brewser-update/1" (FRESH — no back-compat, since
 * this is the first fielded Brewser self-updater). FORWARD-COMPAT RULE: a client
 * that only understands format N can never read a format N+1 manifest, so it can
 * never update again. Ship read-support for "brewser-update/2" in a release
 * BEFORE anything emits it.
 *
 *   envelope = { format, keyId, payload(b64), signature(b64 P1363 r‖s) }
 *   payload (signed bytes) = UTF-8 of JSON.stringify(manifest, null, 2):
 *     { schema:1, keyId, version, counter, nroSize, chunkSize, chunks[],
 *       rootHash, components?, url }
 *
 * - keyId is the SIGNING KEY FINGERPRINT ("k_" + sha256(spkiDER).hex[:16]),
 *   stable per key and role-independent. It appears in BOTH the envelope
 *   (selector) and the signed payload (bound); the client asserts they match.
 * - counter is a never-reused, monotonically increasing build number. The
 *   release invariant (never emit ≤ the last emitted) is enforced in
 *   make-manifest.mjs, NOT here.
 * - version (semver) and components are display / ordering metadata.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { subtle } = webcrypto;

export const CHUNK_SIZE = 4 * 1024 * 1024; // must equal src/update/verify.ts CHUNK_SIZE
export const ENVELOPE_FORMAT = 'brewser-update/1';
export const MANIFEST_SCHEMA = 1;

function toHex(buf) {
	return Buffer.from(buf).toString('hex');
}

async function sha256(bytes) {
	return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/**
 * Key fingerprint = "k_" + first 16 hex chars of SHA-256(SPKI DER). Stable per
 * public key, independent of which role ("active"/"backup") the client assigns
 * it. Must match the client verifier's fingerprint derivation exactly.
 */
export async function keyFingerprint(spkiDer) {
	const h = toHex(await sha256(Buffer.from(spkiDer)));
	return `k_${h.slice(0, 16)}`;
}

/** Compute { chunks[], rootHash, size } for a file, matching verify.ts. */
export async function hashFile(path) {
	const data = readFileSync(path);
	return hashBytes(data);
}

/** Same as hashFile but for an in-memory buffer (used by the host test). */
export async function hashBytes(data) {
	const chunks = [];
	const digests = [];
	for (let off = 0; off < data.length; off += CHUNK_SIZE) {
		const slice = data.subarray(off, Math.min(off + CHUNK_SIZE, data.length));
		const d = await sha256(slice);
		digests.push(d);
		chunks.push(toHex(d));
	}
	const cat = Buffer.concat(digests.map((d) => Buffer.from(d)));
	const rootHash = toHex(await sha256(cat));
	return { chunks, rootHash, size: data.length };
}

/** Build the canonical (unsigned) manifest object. */
export function buildManifest({ version, counter, keyId, size, url, chunks, rootHash, components }) {
	if (!Number.isInteger(counter) || counter <= 0) {
		throw new Error(`counter must be a positive integer, got ${counter}`);
	}
	const m = {
		schema: MANIFEST_SCHEMA,
		keyId,
		version,
		counter,
		nroSize: size,
		chunkSize: CHUNK_SIZE,
		chunks,
		rootHash,
	};
	if (components && typeof components === 'object') m.components = components;
	m.url = url;
	return m;
}

/** Load a PKCS8 PEM private key for ECDSA-P256 signing. */
export async function loadPrivateKey(pem) {
	const b64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, '')
		.replace(/-----END PRIVATE KEY-----/, '')
		.replace(/\s+/g, '');
	const der = Buffer.from(b64, 'base64');
	return subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Load an SPKI PEM public key (for deriving the fingerprint from a keypair). */
export function spkiDerFromPem(pem) {
	const b64 = pem
		.replace(/-----BEGIN PUBLIC KEY-----/, '')
		.replace(/-----END PUBLIC KEY-----/, '')
		.replace(/\s+/g, '');
	return Buffer.from(b64, 'base64');
}

/**
 * Wrap a manifest object into the signed envelope. Signs the EXACT payload
 * bytes (so the client verifies before parsing). WebCrypto ECDSA emits a
 * 64-byte P1363 r||s signature — the format the runtime expects.
 *
 * `envelopeKeyId` defaults to manifest.keyId; pass a different value only for a
 * negative test that deliberately mismatches envelope vs payload keyId.
 */
export async function signEnvelope(manifest, privateKey, envelopeKeyId) {
	const payloadBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
	const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, payloadBytes));
	if (sig.length !== 64) {
		throw new Error(`expected 64-byte P1363 signature, got ${sig.length}`);
	}
	return {
		format: ENVELOPE_FORMAT,
		keyId: envelopeKeyId ?? manifest.keyId,
		payload: payloadBytes.toString('base64'),
		signature: Buffer.from(sig).toString('base64'),
	};
}

/** Generate an ephemeral keypair (for negative tests / hermetic pipeline test).
 * Returns { privateKey, spkiDer, spkiB64, keyId }. */
export async function generateEphemeralKey() {
	const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const spki = Buffer.from(await subtle.exportKey('spki', kp.publicKey));
	return {
		privateKey: kp.privateKey,
		spkiDer: spki,
		spkiB64: spki.toString('base64'),
		keyId: await keyFingerprint(spki),
	};
}
