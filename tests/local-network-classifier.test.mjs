// Regression test for the `local_network` permission's LAN classifier
// (brewser-runtime/src/resources/path-utils.ts). path-utils.ts is
// dependency-free, so it's esbuild-bundled on the fly and imported — the
// test exercises the shipped source, not a hand-copy.
//
// Covers `isLocalNetworkUrl` (the gate's real entry point, URL string in)
// and `isLocalNetworkHost` (the bare-hostname taxonomy). The invariant that
// matters for the gate: a hand-typed LAN server like http://192.168.1.64:8096
// classifies LOCAL, and anything on the public internet classifies NON-local
// so `local_network` can never stand in for full `network`.
//
// Run: node tests/local-network-classifier.test.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '..', 'brewser-runtime', 'src', 'resources', 'path-utils.ts');
const outDir = mkdtempSync(join(tmpdir(), 'lanclass-'));
const outFile = join(outDir, 'path-utils.mjs');
execFileSync('node', [
  join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  SRC,
  '--bundle', '--format=esm', `--outfile=${outFile}`,
], { stdio: 'pipe' });

const { isLocalNetworkUrl, isLocalNetworkHost } = await import(pathToFileURL(outFile).href);

let failures = 0;
function check(label, got, expected) {
  if (got === expected) {
    console.log(`pass  ${label} -> ${got}`);
  } else {
    failures++;
    console.error(`FAIL  ${label} -> ${got} (expected ${expected})`);
  }
}

// --- isLocalNetworkUrl: full URL in (the gate's real input) --------------
const urlLocal = [
  'http://192.168.1.64:8096',                 // the Jellyfin case
  'http://192.168.1.64:8096/System/Info/Public',
  'https://192.168.0.1/',
  'http://10.0.0.5:32400/web',                // Plex on 10/8
  'http://172.16.4.4/',                       // 172.16/12 low edge
  'http://172.31.255.255/',                   // 172.16/12 high edge
  'http://127.0.0.1:8096/',                   // loopback
  'http://localhost:8096/',
  'http://169.254.10.10/',                    // link-local
  'http://jellyfin:8096/',                    // single-label host
  'http://nas.local/',                        // mDNS
  'http://server.home.arpa/',
  'http://box.internal/',
  'http://media.lan:8096/',
  'http://[::1]:8096/',                       // IPv6 loopback
  'http://[fd00::1]/',                        // IPv6 unique-local
  'http://[fe80::1]/',                        // IPv6 link-local
];
for (const u of urlLocal) check(`url local   ${u}`, isLocalNetworkUrl(u), true);

const urlPublic = [
  'http://jellyfin.example.com:8096/',        // public FQDN
  'https://example.com/',
  'http://8.8.8.8/',                          // public IPv4
  'http://172.15.0.1/',                       // just below 172.16/12
  'http://172.32.0.1/',                       // just above 172.16/12
  'http://192.169.0.1/',                      // not 192.168
  'http://169.253.0.1/',                      // not 169.254
  'https://demo.jellyfin.org/',
  'http://[2001:4860:4860::8888]/',           // public IPv6 (Google DNS)
  'not a url',                                 // unparseable → false
];
// NOTE: scheme gating (http/https only) is enforced in
// BrowserPermissionPolicy.allowNetworkURL BEFORE this classifier runs, so a
// LAN host under a non-http scheme (ftp://192.168.1.64) is rejected there,
// not here — this function classifies the host, not the scheme.
for (const u of urlPublic) check(`url public  ${u}`, isLocalNetworkUrl(u), false);

// --- isLocalNetworkHost: bare hostname taxonomy --------------------------
const hostLocal = ['192.168.1.1', '10.1.2.3', '127.0.0.1', 'localhost', 'jellyfin', 'foo.local', 'foo.local.', '[::1]', '[fdff::9]'];
for (const h of hostLocal) check(`host local  ${h}`, isLocalNetworkHost(h), true);

const hostPublic = ['example.com', '8.8.8.8', '256.1.1.1', '', 'sub.example.org', '[2001:db8::1]'];
for (const h of hostPublic) check(`host public ${h}`, isLocalNetworkHost(h), false);

rmSync(outDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall local-network classifier cases pass');
