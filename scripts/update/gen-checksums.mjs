#!/usr/bin/env node
/**
 * scripts/update/gen-checksums.mjs — write dist/checksums.txt: a plain SHA256
 * (whole-file) line per published release binary, in the standard `sha256sum`
 * text format (`<hex>  <name>`), so `cd dist && sha256sum -c checksums.txt`
 * verifies the files and the hashes match `Get-FileHash -Algorithm SHA256`.
 *
 * This deliberately does NOT reuse manifest-lib.mjs's hashFile(): that produces
 * the update manifest's CHUNKED rootHash (a Merkle-ish digest over 4 MiB
 * chunks), which is NOT the same value as a flat SHA256 of the bytes. The
 * checksums file is for humans / `sha256sum -c`, so it must be the plain digest.
 *
 * Runs as the last step of `make release` (after the NRO is signed + moved into
 * dist/), and standalone via `make checksums`. It is implemented in Node rather
 * than a shell loop on purpose: under Windows/MSYS `make`, sequential
 * `sha256sum … >> file` appends inside a recipe silently lose the large NRO's
 * line (make's child shell + cygwin O_APPEND race). Node's crypto+fs is immune.
 *
 * The forwarder .nsp is built elsewhere (it needs signing keys) and only lives
 * in dist/; it is hashed if present and skipped-with-a-note if absent — never
 * fabricated. A file that exists but cannot be read is a hard error (so a locked
 * / mid-write binary fails the build loudly instead of dropping silently).
 *
 * Run: node scripts/update/gen-checksums.mjs [distDir] [file ...]
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// argv[2] = dist dir (default dist/), argv[3..] = file names to hash (relative
// to the dist dir). Defaults cover the two published binaries.
const distDir = process.argv[2] || join(root, 'dist');
const names =
	process.argv.length > 3
		? process.argv.slice(3)
		: ['brewser.nro', 'brewser-forwarder.nsp'];

function sha256(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(path)
			.on('error', reject)
			.on('data', (chunk) => hash.update(chunk))
			.on('end', () => resolve(hash.digest('hex')));
	});
}

const lines = [];
for (const name of names) {
	const path = join(distDir, name);
	if (!existsSync(path)) {
		console.log(`[checksums] skip (missing): ${name}`);
		continue;
	}
	let hex;
	try {
		hex = await sha256(path);
	} catch (err) {
		console.error(`[checksums] ERROR hashing ${name}: ${err?.message ?? err}`);
		process.exit(1);
	}
	// Two-space separator = sha256sum "text mode": verifiable with `sha256sum -c`.
	lines.push(`${hex}  ${name}`);
}

if (lines.length === 0) {
	console.error(`[checksums] no binaries found in ${distDir} — nothing to hash`);
	process.exit(1);
}

const outPath = join(distDir, 'checksums.txt');
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`[checksums] wrote ${outPath}`);
for (const line of lines) console.log(line);
