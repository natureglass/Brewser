// Host-side test of the anti-downgrade decision (src/update/decide.ts). Pure
// module, bundled with the project's esbuild and exercised directly. Locks the
// load-bearing invariant: the flow accepts ONLY a strictly-newer build
// (counter > floor AND semver strictly greater) and refuses a validly-signed
// older one — there is no downgrade bypass (the restore system was removed).
//
// Run: node tests/update-decide.test.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'update-decide-'));
const outFile = join(outDir, 'decide.mjs');
execFileSync('node', [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(ROOT, 'src', 'update', 'decide.ts'),
  '--bundle', '--format=esm', `--outfile=${outFile}`,
], { stdio: 'pipe' });

const { semverCmp, decideUpdate } = await import(pathToFileURL(outFile).href);

let pass = 0;
let fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.error(`  FAIL ${m}`)));

// ── semverCmp ──────────────────────────────────────────────────────────────
ok(semverCmp('0.1.3', '0.1.2') === 1, '0.1.3 > 0.1.2');
ok(semverCmp('0.1.2', '0.1.3') === -1, '0.1.2 < 0.1.3');
ok(semverCmp('0.1.2', '0.1.2') === 0, '0.1.2 == 0.1.2');
ok(semverCmp('1.0.0', '0.9.9') === 1, '1.0.0 > 0.9.9');
ok(semverCmp('0.2.0', '0.1.99') === 1, '0.2.0 > 0.1.99 (numeric, not lexical)');
ok(semverCmp('0.1.3-rc1', '0.1.2') === 1, 'pre-release core compared (0.1.3-rc1 > 0.1.2)');
ok(Number.isNaN(semverCmp('bogus', '0.1.2')), 'unparseable → NaN (fail-closed at call site)');

// ── decideUpdate ─────────────────────────────────────────────────────────────
const m = (version, counter) => ({
  schema: 1, keyId: 'k_0000000000000000', version, counter, nroSize: 1, url: 'x',
  chunkSize: 4194304, chunks: ['00'.repeat(32)], rootHash: '00'.repeat(32),
});

// running 0.1.2 / counter 2, floor 2.
const RV = '0.1.2', RC = 2, FLOOR = 2;

ok(decideUpdate(m('0.1.3', 3), RV, RC, FLOOR).accept === true, 'strictly newer (0.1.3/c3) accepted');

let d = decideUpdate(m('0.1.2', 2), RV, RC, FLOOR);
ok(d.accept === false && d.refuseCode === 'DOWNGRADE_COUNTER', 'same counter refused (DOWNGRADE_COUNTER)');

d = decideUpdate(m('0.1.1', 1), RV, RC, FLOOR);
ok(d.accept === false && d.refuseCode === 'DOWNGRADE_COUNTER', 'older counter refused (DOWNGRADE_COUNTER)');

// counter advances past floor but version is not strictly newer → DOWNGRADE_VERSION.
d = decideUpdate(m('0.1.2', 3), RV, RC, FLOOR);
ok(d.accept === false && d.refuseCode === 'DOWNGRADE_VERSION', 'newer counter but same version refused (DOWNGRADE_VERSION)');

d = decideUpdate(m('0.1.1', 3), RV, RC, FLOOR);
ok(d.accept === false && d.refuseCode === 'DOWNGRADE_VERSION', 'newer counter but older version refused (DOWNGRADE_VERSION)');

// floor above running (a higher build was applied then rolled back): counter must clear the FLOOR, not just running.
d = decideUpdate(m('0.1.4', 4), '0.1.2', 2, 5);
ok(d.accept === false && d.refuseCode === 'DOWNGRADE_COUNTER', 'counter must clear the FLOOR (5), not just running (2)');

// No downgrade bypass exists any more (the restore-to-previous system was
// removed): even a validly-formed OLD build is refused, no exceptions.
d = decideUpdate(m('0.0.1', 1), RV, RC, FLOOR);
ok(d.accept === false, 'old build refused — no downgrade bypass (restore system removed)');

// unparseable version with a passing counter → refused (semverCmp NaN !== 1).
d = decideUpdate(m('bogus', 3), RV, RC, FLOOR);
ok(d.accept === false && d.refuseCode === 'DOWNGRADE_VERSION', 'unparseable version fails closed');

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
