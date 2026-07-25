// Regression test for the auth-log token redaction (Phase 0 / D9).
//
// Extracts the redaction block VERBATIM from each shipped romfs script and
// exercises it — so the test fails if the shipped patterns regress, not a
// copy. The critical case is the TWO-SEGMENT Brewser session token
// (base64url(payloadJson) "." base64url(hmac) — brewser-auth contract):
// a strict three-group JWT pattern would NOT match it, and that token
// carries save/leaderboard/rating write access for 30 days.
//
// Run: node tests/redact-tokens.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractRedactor(file) {
  const src = readFileSync(join(ROOT, 'romfs', 'shell', 'scripts', file), 'utf8');
  const start = src.indexOf('var REDACT_FIELD_RE');
  const end = src.indexOf('function log(');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`${file}: redaction block not found — did log() move?`);
  }
  const block = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${block}; return redactTokens;`)();
}

// A realistic two-segment Brewser token: base64url JSON payload + 43-char sig.
const payload = Buffer.from(
  JSON.stringify({ sub: '109392', name: 'Alex', iat: 1753300000, exp: 1755892000, v: 1 }),
).toString('base64url');
const brewserToken = `${payload}.mfQ4x_0hK9dLwWnB2pR7cV5tY8uZ3aE6gJ1iN0oS4kA`;

const threeSegJwt =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEyMzQ1In0.eyJzdWIiOiIxMTEyMjIzMzMiLCJhdWQiOiJ4In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';

const cases = [
  // [label, input, mustNotContain[], mustContain[]]
  ['bare two-segment Brewser token',
    `mint OK token=${brewserToken}`,
    [brewserToken, payload], ['<redacted:jwt:']],
  ['Brewser token in JSON field',
    `device-mint status=200 body={"token":"${brewserToken}","user":{"sub":"109392"}}`,
    [brewserToken], ['"token":"<redacted:']],
  ['three-segment JWT in id_token field',
    `poll body={"access_token":"ya29.a0AfB_byDEADBEEF-xyz123","expires_in":3599,"id_token":"${threeSegJwt}"}`,
    [threeSegJwt, 'ya29.a0AfB_byDEADBEEF-xyz123'], ['"access_token":"<redacted:', '"id_token":"<redacted:']],
  ['refresh_token field',
    `body={"refresh_token":"1//0eXyZaBcDeFgHiJkLmNoP"}`,
    ['1//0eXyZaBcDeFgHiJkLmNoP'], ['"refresh_token":"<redacted:']],
  ['benign line untouched',
    'device response — user_code=ABCD-EFGH url=https://www.google.com/device',
    [], ['user_code=ABCD-EFGH', 'https://www.google.com/device']],
];

// Negative cases: ordinary dotted identifiers must survive the JWT
// pattern byte-identical. An optional third segment would match ANY
// dotted string unless segments carry minimum lengths and the eyJ
// anchor — these prove the shipped pattern has both.
const mustSurvive = [
  'index.html',
  'play.brewser.tech',
  'manifest.json',
  'com.natureglass.midilab',
  'fetch https://play.brewser.tech/apps/com.natureglass.midilab/manifest.json -> 200',
  'entry=index.html logo=assets/appbanner.jpg id=com.natureglass.sensorsplayground',
];

let failures = 0;
for (const file of ['google-auth.js', 'microsoft-auth.js']) {
  const redact = extractRedactor(file);
  for (const [label, input, absent, present] of cases) {
    const out = redact(input);
    const bad =
      absent.filter((s) => out.includes(s)).map((s) => `leaked: ${s.slice(0, 40)}…`)
        .concat(present.filter((s) => !out.includes(s)).map((s) => `missing: ${s}`));
    if (bad.length) {
      failures++;
      console.error(`FAIL [${file}] ${label}\n  in:  ${input.slice(0, 100)}\n  out: ${out.slice(0, 100)}\n  ${bad.join('\n  ')}`);
    } else {
      console.log(`pass [${file}] ${label}`);
    }
  }
  // The benign case must also be byte-identical (redaction never rewrites clean lines).
  const benign = cases[4][1];
  if (redact(benign) !== benign) {
    failures++;
    console.error(`FAIL [${file}] benign line was modified`);
  }
  for (const line of mustSurvive) {
    const out = redact(line);
    if (out === line) {
      console.log(`pass [${file}] survives: ${line.slice(0, 60)}`);
    } else {
      failures++;
      console.error(`FAIL [${file}] identifier mangled\n  in:  ${line}\n  out: ${out}`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall redaction cases pass');
