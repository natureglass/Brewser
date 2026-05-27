// Idempotent sync of the Khronos WebGL 2 conformance corpus into romfs.
//
// Source: D:/Workspace/WebGL/sdk/tests/{conformance2,js}/...
// Destination: romfs/pages/full-webgl2-conformance/sdk/tests/{conformance2,js}/...
//
// Mirror of sync-khronos-tests.mjs but pointing at the WebGL 2 corpus.
// Two destinations need the same `js/` helpers, but the corpora live under
// different folders so we keep them physically separate to avoid path
// rewrites inside the test HTML.
//
// Also generates `assets/tests.json` with the enumerated test list, parsed
// from each directory's `00_test_list.txt`. The runner fetches this JSON
// at startup to know which tests to run.

import { readdir, readFile, writeFile, mkdir, copyFile, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..');

const SRC_BASE = 'D:/Workspace/WebGL/sdk/tests';
const SRC_CONFORMANCE = join(SRC_BASE, 'conformance2').replace(/\\/g, '/');
const SRC_JS = join(SRC_BASE, 'js').replace(/\\/g, '/');
const SRC_RESOURCES = join(SRC_BASE, 'resources').replace(/\\/g, '/');

const DST_BASE = join(REPO_ROOT, 'romfs/pages/full-webgl2-conformance/sdk/tests').replace(/\\/g, '/');
const DST_CONFORMANCE = join(DST_BASE, 'conformance2').replace(/\\/g, '/');
const DST_JS = join(DST_BASE, 'js').replace(/\\/g, '/');
const DST_RESOURCES = join(DST_BASE, 'resources').replace(/\\/g, '/');
const TESTS_JSON_PATH = join(REPO_ROOT, 'romfs/pages/full-webgl2-conformance/assets/tests.json').replace(/\\/g, '/');

// No top-level dirs to exclude for WebGL 2 (no ogles equivalent).
const EXCLUDE_DIRS = new Set();

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
	try { await utimes(dstPath, srcStat.atime, srcStat.mtime); } catch {}
	copied++;
}

async function collectTests(rootDir, relPrefix, out) {
	const listPath = join(rootDir, '00_test_list.txt');
	if (!existsSync(listPath)) return;
	const text = await readFile(listPath, 'utf8');
	for (let line of text.split(/\r?\n/)) {
		line = line.trim();
		if (!line || line.startsWith('//') || line.startsWith('#')) continue;
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
	console.log('[sync-khronos-webgl2] Copying conformance2 HTML tree…');
	await walkAndCopy(SRC_CONFORMANCE, DST_CONFORMANCE, { isUnderTopConformance: true });
	console.log('[sync-khronos-webgl2] Copying js/ helpers tree…');
	await walkAndCopy(SRC_JS, DST_JS);
	console.log('[sync-khronos-webgl2] Copying resources/ images + helpers…');
	// Tests reference `../../../resources/red-green.png` etc. Needed for
	// every image-source test (~900 tests) to actually have a file to
	// load via `wtu.loadTexture`.
	await walkAndCopy(SRC_RESOURCES, DST_RESOURCES);

	console.log('[sync-khronos-webgl2] Enumerating test list…');
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
	console.log(`[sync-khronos-webgl2] Done in ${elapsed}s: ${copied} copied, ${skipped} unchanged, ${tests.length} tests enumerated.`);
}

main().catch((err) => {
	console.error('[sync-khronos-webgl2] FAILED', err);
	process.exit(1);
});
