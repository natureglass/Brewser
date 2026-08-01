// Guard against vendored-dist drift: three copies of the endpoint constants
// exist and nothing else asserts they agree —
//   1. engine source   ../brewser-runtime-v8/src/runtime-defaults.ts
//   2. engine dist     ../brewser-runtime-v8/dist/runtime-defaults.js
//   3. shell vendored  runtime/dist/runtime-defaults.js
// Phase-0 finding: (2) and (3) shipped stale telemetry-repo URLs for weeks
// while (1) was already fixed, because `tsc` had not been re-run before
// vendoring. This script fails the build when any key differs.
//
// Invoked by `make build` (after sync-runtime). BREWSER_RUNTIME_DIR is
// forwarded by the Makefile the same way sync-runtime receives it.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = resolve(ROOT, process.env.BREWSER_RUNTIME_DIR || '../brewser-runtime-v8');

const COPIES = [
  ['engine src', join(RUNTIME_DIR, 'src', 'runtime-defaults.ts')],
  ['engine dist', join(RUNTIME_DIR, 'dist', 'runtime-defaults.js')],
  ['shell vendored', join(ROOT, 'runtime', 'dist', 'runtime-defaults.js')],
];

function extractDefaults(label, file) {
  const src = readFileSync(file, 'utf8');
  const block = src.match(/RUNTIME_CONFIG_DEFAULTS[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error(`${label}: RUNTIME_CONFIG_DEFAULTS block not found in ${file}`);
  const pairs = {};
  for (const m of block[1].matchAll(/(\w+):\s*'([^']*)'/g)) pairs[m[1]] = m[2];
  if (Object.keys(pairs).length === 0) throw new Error(`${label}: no key/value pairs parsed`);
  return pairs;
}

const missing = COPIES.filter(([, f]) => !existsSync(f));
if (missing.length) {
  // Consumers without the sibling engine checkout can't compare — same
  // policy as the Makefile's runtime-build skip, but say so out loud.
  console.warn(`[check-endpoint-parity] skipped — missing: ${missing.map(([l]) => l).join(', ')}`);
  process.exit(0);
}

function extractBaseUrl(label, file) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(/PLATFORM_BASE_URL\s*=\s*'([^']+)'/);
  if (!m) throw new Error(`${label}: PLATFORM_BASE_URL not found in ${file}`);
  return m[1];
}

const [ref, ...rest] = COPIES.map(([label, file]) => [label, extractDefaults(label, file)]);
const drift = [];
const allKeys = new Set(COPIES.length && [ref, ...rest].flatMap(([, p]) => Object.keys(p)));
for (const key of allKeys) {
  const values = [ref, ...rest].map(([label, p]) => [label, p[key]]);
  const distinct = new Set(values.map(([, v]) => v));
  if (distinct.size > 1) {
    drift.push(`  ${key}:\n${values.map(([l, v]) => `    ${l}: ${v === undefined ? '(absent)' : v}`).join('\n')}`);
  }
}

// PLATFORM_BASE_URL is the single conceptual source for the platform
// pins (declared in runtime-defaults.ts): assert the base agrees across
// copies AND that each copy's catalogue/stats/versions pin is exactly
// base + fixed suffix. This is what lets the pins stay greppable
// literals without ever being two sources of truth.
const bases = COPIES.map(([label, file]) => [label, extractBaseUrl(label, file)]);
if (new Set(bases.map(([, b]) => b)).size > 1) {
  drift.push(`  PLATFORM_BASE_URL:\n${bases.map(([l, b]) => `    ${l}: ${b}`).join('\n')}`);
}
// `versions` is intentionally NOT here: versions.json moved to the
// brewser-apps-staging repo (my.brewser.tech), so it is no longer
// PLATFORM_BASE_URL + suffix. It is still byte-compared across the src/dist/
// vendored copies by the generic drift loop above — just not asserted as a
// base derivation.
const DERIVED = { catalogue: '/catalogue.json', stats: '/stats.json' };
for (const [label, pairs] of [ref, ...rest]) {
  const base = bases.find(([l]) => l === label)?.[1];
  for (const [key, suffix] of Object.entries(DERIVED)) {
    if (pairs[key] !== undefined && pairs[key] !== `${base}${suffix}`) {
      drift.push(`  ${key} (${label}): ${pairs[key]} != PLATFORM_BASE_URL + ${suffix}`);
    }
  }
}

if (drift.length) {
  console.error('[check-endpoint-parity] DRIFT between endpoint-constant copies:\n' + drift.join('\n'));
  console.error('Fix: rebuild the engine and re-vendor (`make sync-runtime` runs both).');
  process.exit(1);
}
console.log(`[check-endpoint-parity] OK — ${allKeys.size} keys + PLATFORM_BASE_URL pins agree across ${COPIES.length} copies`);
