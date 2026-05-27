// Idempotent sync of the Khronos WebGL 1 conformance corpus into romfs.
//
// Source: D:/Workspace/WebGL/sdk/tests/{conformance,js}/...
// Destination: romfs/pages/full-webgl1-conformance/sdk/tests/{conformance,js}/...
//
// Also generates `assets/tests.json` with the enumerated test list, parsed
// from each directory's `00_test_list.txt`. The runner fetches this JSON
// at startup to know which tests to run.
//
// Idempotent: skips files whose mtime matches the source. Safe to run
// every build.
//
// The `ogles/` sub-suite is excluded (it's auto-generated GLSL permutation
// noise — 141 files, tens of thousands of assertions).

import { readdir, readFile, writeFile, mkdir, copyFile, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..');

const SRC_BASE = 'D:/Workspace/WebGL/sdk/tests';
const SRC_CONFORMANCE = join(SRC_BASE, 'conformance').replace(/\\/g, '/');
const SRC_JS = join(SRC_BASE, 'js').replace(/\\/g, '/');

const DST_BASE = join(REPO_ROOT, 'romfs/pages/full-webgl1-conformance/sdk/tests').replace(/\\/g, '/');
const DST_CONFORMANCE = join(DST_BASE, 'conformance').replace(/\\/g, '/');
const DST_JS = join(DST_BASE, 'js').replace(/\\/g, '/');
const TESTS_JSON_PATH = join(REPO_ROOT, 'romfs/pages/full-webgl1-conformance/assets/tests.json').replace(/\\/g, '/');

const EXCLUDE_DIRS = new Set(['ogles']);

let copied = 0;
let skipped = 0;
let testCount = 0;

async function walkAndCopy(srcDir, dstDir, opts = {}) {
	const { isUnderTopConformance = false } = opts;
	await mkdir(dstDir, { recursive: true });
	const entries = await readdir(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (isUnderTopConformance && EXCLUDE_DIRS.has(entry.name)) continue;
			await walkAndCopy(
				join(srcDir, entry.name),
				join(dstDir, entry.name),
				{ isUnderTopConformance: false },
			);
		} else if (entry.isFile()) {
			await copyIfNewer(join(srcDir, entry.name), join(dstDir, entry.name));
		}
	}
}

async function copyIfNewer(srcPath, dstPath) {
	let srcStat;
	try { srcStat = await stat(srcPath); }
	catch { return; }
	if (existsSync(dstPath)) {
		try {
			const dstStat = await stat(dstPath);
			if (Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 2000 &&
			    dstStat.size === srcStat.size) {
				skipped++;
				return;
			}
		} catch { /* fall through to copy */ }
	}
	await copyFile(srcPath, dstPath);
	// Preserve mtime for idempotency.
	try { await utimes(dstPath, srcStat.atime, srcStat.mtime); } catch {}
	copied++;
}

/**
 * Recursively parse `00_test_list.txt` files starting from the top-level
 * conformance manifest. Each line is either a test `.html`, a sub-manifest
 * (`<dir>/00_test_list.txt`), or a comment. Lines may be prefixed with
 * `--min-version X.Y.Z` / `--max-version X.Y.Z` / `--slow` flags; we strip
 * them. Excludes ogles/.
 */
async function collectTests(rootDir, relPrefix, out) {
	const listPath = join(rootDir, '00_test_list.txt');
	if (!existsSync(listPath)) return;
	const text = await readFile(listPath, 'utf8');
	for (let line of text.split(/\r?\n/)) {
		line = line.trim();
		if (!line || line.startsWith('//') || line.startsWith('#')) continue;
		// Strip recognized leading flags.
		line = line
			.replace(/--min-version\s+\S+\s*/g, '')
			.replace(/--max-version\s+\S+\s*/g, '')
			.replace(/--slow\s*/g, '')
			.trim();
		if (!line) continue;
		if (line.endsWith('00_test_list.txt')) {
			const subdirRaw = line.slice(0, line.length - '00_test_list.txt'.length);
			const subdir = subdirRaw.replace(/\/$/, '');
			if (!subdir) continue;
			const topSegment = subdir.split('/')[0];
			if (EXCLUDE_DIRS.has(topSegment)) continue;
			await collectTests(
				join(rootDir, subdir),
				relPrefix ? posix.join(relPrefix, subdir) : subdir,
				out,
			);
		} else if (line.endsWith('.html')) {
			const rel = relPrefix ? posix.join(relPrefix, line) : line;
			out.push(rel);
			testCount++;
		}
	}
}

async function main() {
	const t0 = Date.now();
	console.log('[sync-khronos] Copying conformance HTML tree…');
	await walkAndCopy(SRC_CONFORMANCE, DST_CONFORMANCE, { isUnderTopConformance: true });
	console.log('[sync-khronos] Copying js/ helpers tree…');
	await walkAndCopy(SRC_JS, DST_JS);

	console.log('[sync-khronos] Enumerating test list…');
	const tests = [];
	await collectTests(SRC_CONFORMANCE, '', tests);
	tests.sort();

	await mkdir(dirname(TESTS_JSON_PATH), { recursive: true });
	const json = JSON.stringify({
		generated: new Date().toISOString(),
		count: tests.length,
		tests: tests.map((rel) => ({
			rel,
			name: rel.replace(/\.html$/, '').replace(/\//g, '-'),
		})),
	}, null, 1);
	await writeFile(TESTS_JSON_PATH, json);

	const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
	console.log(`[sync-khronos] Done in ${elapsed}s: ${copied} copied, ${skipped} unchanged, ${tests.length} tests enumerated.`);
}

main().catch((err) => {
	console.error('[sync-khronos] FAILED', err);
	process.exit(1);
});
