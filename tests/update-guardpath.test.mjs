// Host-side safety-kernel test for the self-updater's guardPath (Phase 1).
//
// paths.ts is dependency-free (pure TS, no runtime imports), so it's bundled
// on the fly with the project's esbuild and imported — the test exercises the
// EXACT code that ships in the NRO. This is the inverted guard: the updater may
// swap `brewser.nro` + a fixed staging surface, and must NEVER touch the
// user-data subtrees under sdmc:/switch/brewser/. Mirrors the rig's
// guardpath.test.ts (which proved the same kernel in the opposite polarity).
//
// MUST pass before any hardware run.
//
// Run: node tests/update-guardpath.test.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'update-guardpath-'));
const outFile = join(outDir, 'paths.mjs');
execFileSync('node', [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  join(ROOT, 'src', 'update', 'paths.ts'),
  '--bundle', '--format=esm', `--outfile=${outFile}`,
], { stdio: 'pipe' });

const { guardPath, guardCurrentJson, GuardPathError } = await import(pathToFileURL(outFile).href);

let failures = 0;
let passes = 0;

/** Assert guardPath(input) returns the input unchanged (allowed). */
function allow(input, label) {
  try {
    const got = guardPath(input);
    if (got === input) {
      passes++;
      console.log(`pass  ALLOW  ${label}  (${input})`);
    } else {
      failures++;
      console.error(`FAIL  ALLOW  ${label}  guardPath returned ${JSON.stringify(got)} != input`);
    }
  } catch (err) {
    failures++;
    console.error(`FAIL  ALLOW  ${label}  threw ${err && err.message ? err.message : String(err)}`);
  }
}

/** Assert guardPath(input) throws GuardPathError (denied). */
function deny(input, label) {
  try {
    guardPath(input);
    failures++;
    console.error(`FAIL  DENY   ${label}  guardPath ACCEPTED ${JSON.stringify(input)} (must reject)`);
  } catch (err) {
    if (err instanceof GuardPathError) {
      passes++;
      console.log(`pass  DENY   ${label}  (${JSON.stringify(input)})`);
    } else {
      failures++;
      console.error(`FAIL  DENY   ${label}  threw wrong type: ${err && err.message ? err.message : String(err)}`);
    }
  }
}

/** Assert guardCurrentJson(input) allows / denies. */
function allowCurrent(input, label) {
  try {
    const got = guardCurrentJson(input);
    if (got === input) { passes++; console.log(`pass  ALLOW  current: ${label}`); }
    else { failures++; console.error(`FAIL  ALLOW  current: ${label}  returned ${JSON.stringify(got)}`); }
  } catch (err) {
    failures++;
    console.error(`FAIL  ALLOW  current: ${label}  threw ${err && err.message ? err.message : String(err)}`);
  }
}
function denyCurrent(input, label) {
  try {
    guardCurrentJson(input);
    failures++;
    console.error(`FAIL  DENY   current: ${label}  ACCEPTED ${JSON.stringify(input)}`);
  } catch (err) {
    if (err instanceof GuardPathError) { passes++; console.log(`pass  DENY   current: ${label}`); }
    else { failures++; console.error(`FAIL  DENY   current: ${label}  wrong error type`); }
  }
}

// ── ALLOWED: the updater's mutation surface ────────────────────────────────
allow('sdmc:/switch/brewser.nro', 'installed NRO (swap target)');
allow('sdmc:/switch/brewser-update.nro', 'recovery alias');
allow('sdmc:/switch/brewser-previous.nro', 'previous / last-known-good');
allow('sdmc:/switch/.brewser.new', 'same-dir swap temp');
allow('sdmc:/switch/brewser/update', 'staging dir itself (mkdir target)');
allow('sdmc:/switch/brewser/update/payload.part', 'download part');
allow('sdmc:/switch/brewser/update/payload.staged', 'staged payload');
allow('sdmc:/switch/brewser/update/prev.bin', 'transient prev.bin');
allow('sdmc:/switch/brewser/update/journal.json', 'journal');
allow('sdmc:/switch/brewser/update/journal.json.tmp', 'journal tmp');
allow('sdmc:/switch/brewser/update/anti-rollback.json', 'anti-rollback high-water');
allow('sdmc:/switch/brewser/update/sub/dir/deep.bin', 'deeply nested under update/');
// Case-insensitivity (FAT) + backslash normalization must not change the verdict.
allow('SDMC:/Switch/Brewser.NRO', 'uppercase scheme + mixed case NRO');
allow('sdmc:\\switch\\brewser.nro', 'backslash separators');
allow('sdmc:/switch/brewser/update//payload.part', 'duplicate slash collapses');

// ── DENIED: user data (the whole point of the inversion) ───────────────────
deny('sdmc:/switch/brewser/configs/config.json', 'user config');
deny('sdmc:/switch/brewser/configs/current.json', 'current.json NOT via guardPath');
deny('sdmc:/switch/brewser/configs/catalogue.json', 'catalogue');
deny('sdmc:/switch/brewser/apps/com.x.y/index.html', 'installed app file');
deny('sdmc:/switch/brewser/apps/com.x.y/manifest.json', 'app manifest');
deny('sdmc:/switch/brewser/shell/home.html', 'seeded shell page');
deny('sdmc:/switch/brewser/shell/auth/session.json', 'auth session');
deny('sdmc:/switch/brewser/shell/scripts/updates-modal.js', 'shell script');
deny('sdmc:/switch/brewser/themes/dark.css', 'user-customizable theme');
deny('sdmc:/switch/brewser/themes/toolbars/default.json', 'theme registry');
deny('sdmc:/switch/brewser/logs/run.ndjson', 'log file');
deny('sdmc:/switch/brewser/assets/icon.png', 'per-profile asset');
deny('sdmc:/switch/brewser/seed-fingerprint', 'profile fingerprint marker (not in allow-list)');

// ── DENIED: data root, sibling collisions, other NROs ──────────────────────
deny('sdmc:/switch/brewser/', 'data root itself (trailing slash)');
deny('sdmc:/switch/brewser', 'data root path (no slash) — not the NRO');
deny('sdmc:/switch/brewser/updateX/foo', 'prefix-collision sibling of update/');
deny('sdmc:/switch/brewser/update-old/x', 'another prefix-collision sibling');
deny('sdmc:/switch/brewser.nro.bak', 'NRO with extra suffix');
deny('sdmc:/switch/brewser-update.nro.bak', 'recovery alias with extra suffix');
deny('sdmc:/switch/brewser-updater.nro', 'near-name sibling of the alias');
deny('sdmc:/switch/hbmenu.nro', 'a different homebrew NRO');
deny('sdmc:/switch/atmosphere/reboot_payload.bin', 'unrelated system tree');

// ── DENIED: traversal, schemes, malformed ──────────────────────────────────
deny('sdmc:/switch/brewser/update/../configs/config.json', "'..' escapes to configs");
deny('sdmc:/switch/brewser/update/./payload.part', "'.' segment");
deny('sdmc:/switch/../switch/brewser.nro', "'..' anywhere");
deny('romfs:/switch/brewser.nro', 'romfs: scheme');
deny('file:/switch/brewser.nro', 'file: scheme');
deny('switch/brewser.nro', 'relative (no scheme)');
deny('/switch/brewser.nro', 'absolute-no-scheme');
deny('', 'empty string');
deny('sdmc:/', 'bare sdmc root');
deny('sdmc:/switch/', 'switch dir');

// ── guardCurrentJson: the ONE exceptional write ────────────────────────────
allowCurrent('sdmc:/switch/brewser/configs/current.json', 'exact current.json');
allowCurrent('SDMC:/switch/brewser/CONFIGS/Current.json', 'case-insensitive current.json');
denyCurrent('sdmc:/switch/brewser/configs/config.json', 'a sibling config');
denyCurrent('sdmc:/switch/brewser.nro', 'the NRO is not current.json');
denyCurrent('sdmc:/switch/brewser/configs/current.json.bak', 'current.json with suffix');
denyCurrent('', 'empty');

rmSync(outDir, { recursive: true, force: true });

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
