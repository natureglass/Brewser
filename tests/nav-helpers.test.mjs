// Regression test for the flat-layout app-dir extraction (Phase 3).
// nav-helpers.ts is dependency-free, so it's bundled on the fly with the
// project's esbuild and imported — the test exercises the shipped source.
//
// Run: node tests/nav-helpers.test.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'navhelpers-'));
const outFile = join(outDir, 'nav-helpers.mjs');
execFileSync('node', [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(ROOT, 'src', 'shell', 'nav-helpers.ts'),
  '--bundle', '--format=esm', `--outfile=${outFile}`,
], { stdio: 'pipe' });

const { extractAppDirFromUrl } = await import(pathToFileURL(outFile).href);

const cases = [
  // Flat layout — the platform contract since catalogue v2.
  ['brewser://apps/com.natureglass.midilab/index.html', 'apps/com.natureglass.midilab/'],
  ['brewser://apps/com.natureglass.phase3probe/assets/deep/file.png', 'apps/com.natureglass.phase3probe/'],
  ['brewser://apps/com.x.y/index.html?a=1#frag', 'apps/com.x.y/'],
  ['brewser://apps/com.x.y/', 'apps/com.x.y/'],
  // Sideloaded dir with a non-reverse-DNS name still gets app context
  // (must fail toward the sandbox, never toward shell grant-all).
  ['brewser://apps/myapp/index.html', 'apps/myapp/'],
  // Legacy tiered path resolves to the TIER dir — no manifest there, so
  // the launch runs sandboxed deny-by-default (D1: tiered installs are
  // not-installed; no migration).
  ['brewser://apps/featured/com.x.y/index.html', 'apps/featured/'],
  // Non-app URLs get no app context.
  ['brewser://apps/com.x.y', null],          // no tail segment
  ['brewser://apps/', null],
  ['brewser://home/', null],
  ['brewser://settings/index.html', null],
  ['https://example.com/apps/com.x.y/index.html', null],
  ['romfs:/apps/com.x.y/index.html', null],
];

let failures = 0;
for (const [input, expected] of cases) {
  const got = extractAppDirFromUrl(input);
  if (got === expected) {
    console.log(`pass  ${input} -> ${JSON.stringify(got)}`);
  } else {
    failures++;
    console.error(`FAIL  ${input} -> ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
}

rmSync(outDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall nav-helper cases pass');
