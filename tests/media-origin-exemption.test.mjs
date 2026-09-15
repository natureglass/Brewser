// Regression test for the media exemption from `allowed_origins`
// (brewser-runtime/src/permissions/browser-permission-policy.ts +
// permissions/media-grants.ts). Both are bundled on the fly and imported, so
// the test exercises the shipped source rather than a hand-copy.
//
// The rule under test: `allowed_origins` restricts PROGRAMMATIC egress
// (fetch / XHR / WebSocket). Declarative media element loads (<img>,
// <audio>, <video>, <source>) skip the allowlist but still require the
// `network` / `local_network` permission and still obey the device-owner
// Settings gate.
//
// The invariants that matter, and why:
//
//   - a media load reaches an UNDECLARED origin (the whole point: HLS edges,
//     IPTV broadcaster hosts and user-typed servers can't be enumerated at
//     publish time)
//   - a media load is still DENIED without a network permission (this is the
//     <video src="https://evil/?d=..."> egress hole; the exemption must not
//     reopen it)
//   - a media load is still DENIED when the owner's Settings gate is off
//   - `local_network` does NOT become full `network` for media
//   - a non-media fetch to an undeclared origin is still denied (the
//     exemption must not leak into the default path)
//
// Run: node tests/media-origin-exemption.test.mjs

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RT = join(ROOT, '..', 'brewser-runtime', 'src', 'permissions');
const outDir = mkdtempSync(join(tmpdir(), 'mediaexempt-'));

function bundle(srcRelative, outName) {
  const outFile = join(outDir, outName);
  execFileSync('node', [
    join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    join(RT, srcRelative),
    '--bundle', '--format=esm', `--outfile=${outFile}`,
  ], { stdio: 'pipe' });
  return pathToFileURL(outFile).href;
}

const { BrowserPermissionPolicy } = await import(
  bundle('browser-permission-policy.ts', 'policy.mjs')
);
const { grantMediaUrl, networkRequestKindFor, clearMediaGrants, mediaGrantCount } = await import(
  bundle('media-grants.ts', 'grants.mjs')
);
const {
  setOriginPromptHandler, resolveNetworkAccess, clearOriginPromptSession,
} = await import(bundle('origin-prompt.ts', 'prompt.mjs'));
const { markPlatformRequest, isPlatformRequest } = await import(
  bundle('platform-requests.ts', 'platform.mjs')
);

let failures = 0;
function check(label, got, expected) {
  if (got === expected) {
    console.log(`pass  ${label} -> ${got}`);
  } else {
    failures++;
    console.error(`FAIL  ${label} -> ${got} (expected ${expected})`);
  }
}

// An app scoped exactly like Stream Cast: declares its API hosts, streams
// from CDN edges it never listed.
function appPolicy(perms, origins, opts = {}) {
  const p = new BrowserPermissionPolicy(opts);
  p.setManifestPermissions('com.test.app', perms, 'sdmc:/switch/brewser/apps/test/', origins);
  return p;
}

// =========================================================================
// 1. The exemption itself
// =========================================================================
{
  const p = appPolicy(['network'], ['https://gql.twitch.tv', 'https://usher.ttvnw.net']);

  // Declared origin: allowed either way.
  check('declared  fetch gql.twitch.tv', p.allowNetworkURL('https://gql.twitch.tv/gql'), true);
  check('declared  media gql.twitch.tv', p.allowNetworkURL('https://gql.twitch.tv/gql', 'media'), true);

  // Undeclared CDN edge — the case the whole change exists for. A Twitch HLS
  // variant resolves to a different node by region and by hour.
  const edge = 'https://video-weaver.lhr03.hls.ttvnw.net/v1/playlist/abc.m3u8';
  check('undeclared fetch hls edge', p.allowNetworkURL(edge), false);
  check('undeclared MEDIA hls edge', p.allowNetworkURL(edge, 'media'), true);

  // Free TV: an IPTV broadcaster host in an arbitrary country.
  const iptv = 'https://live.some-broadcaster.example/hls/ch1.m3u8';
  check('undeclared fetch iptv', p.allowNetworkURL(iptv), false);
  check('undeclared MEDIA iptv', p.allowNetworkURL(iptv, 'media'), true);

  // Free TV channel logo — an <img> from a host named by the playlist.
  const logo = 'https://logos.example.org/ch1.png';
  check('undeclared fetch logo', p.allowNetworkURL(logo), false);
  check('undeclared MEDIA logo', p.allowNetworkURL(logo, 'media'), true);

  // Default kind must be 'default' when omitted — the historical behaviour.
  check('omitted kind == default', p.allowNetworkURL(edge), false);
}

// =========================================================================
// 2. The exemption must NOT reopen the no-permission egress hole
// =========================================================================
{
  // No network permission at all. This is the <video src="https://evil/?d=">
  // exfiltration case that live-video.ts's gate was added to close.
  const p = appPolicy(['storage'], []);
  check('no-perm  fetch denied', p.allowNetworkURL('https://evil.example/?d=secret'), false);
  check('no-perm  MEDIA denied', p.allowNetworkURL('https://evil.example/?d=secret', 'media'), false);
  check('no-perm  media m3u8 denied', p.allowNetworkURL('https://evil.example/x.m3u8', 'media'), false);
}

// =========================================================================
// 3. The device-owner Settings gate still wins over everything
// =========================================================================
{
  const p = appPolicy(['network'], [], { allowNetwork: false });
  check('settings-off fetch denied', p.allowNetworkURL('https://example.com/'), false);
  check('settings-off MEDIA denied', p.allowNetworkURL('https://example.com/v.mp4', 'media'), false);
}

// =========================================================================
// 4. `local_network` does not become full `network` for media
// =========================================================================
{
  // The Jellyfin shape: LAN-only, user-supplied server, empty allowlist.
  const p = appPolicy(['local_network', 'storage'], []);
  check('lan  media LAN stream', p.allowNetworkURL('http://192.168.1.64:8096/Videos/1/stream', 'media'), true);
  check('lan  media PUBLIC denied', p.allowNetworkURL('https://cdn.example.com/v.mp4', 'media'), false);
  check('lan  fetch PUBLIC denied', p.allowNetworkURL('https://cdn.example.com/api', 'default'), false);

  // ...and with a declared allowlist, LAN media still skips it.
  const q = appPolicy(['local_network'], ['http://192.168.1.10']);
  check('lan+list media other LAN host', q.allowNetworkURL('http://192.168.1.64:8096/s.mkv', 'media'), true);
  check('lan+list fetch other LAN host', q.allowNetworkURL('http://192.168.1.64:8096/api'), false);
}

// =========================================================================
// 5. Non-network schemes are unaffected by the exemption
// =========================================================================
{
  const p = appPolicy(['network'], ['https://declared.example']);
  // blob:/data: were always allowed; ftp: was always denied. Neither should
  // change shape because a kind argument now exists.
  check('blob  media', p.allowNetworkURL('blob:abc-123', 'media'), true);
  check('data  media', p.allowNetworkURL('data:image/png;base64,AAAA', 'media'), true);
  check('ftp   media denied', p.allowNetworkURL('ftp://undeclared.example/x.mp4', 'media'), false);
  // WebSocket folds onto http(s) and is gated as 'default' by the socket
  // itself — but confirm an undeclared ws origin is denied on the default
  // path, since that is the guarantee the WS call site relies on.
  check('wss   undeclared denied', p.allowNetworkURL('wss://undeclared.example/socket'), false);
  check('wss   declared allowed', p.allowNetworkURL('wss://declared.example/socket'), true);
}

// =========================================================================
// 5b. The radio-app shape: a declared directory API, undeclared stream hosts
// =========================================================================
{
  // A station directory is one known host. The station streams themselves
  // are thousands of Icecast/Shoutcast endpoints the app cannot enumerate —
  // exactly the case the exemption exists for. Before it, this app had to
  // declare an EMPTY allowlist and lose the check on its API call too.
  const p = appPolicy(['network'], ['https://de1.api.radio-browser.info']);

  check('radio api fetch',
    p.allowNetworkURL('https://de1.api.radio-browser.info/json/stations/topvote/100'), true);

  for (const stream of [
    'http://ice1.somafm.com/groovesalad-128-mp3',   // plain-HTTP Icecast
    'https://stream.example.fm:8000/live.aac',      // non-default port
    'https://radio.example.co.uk/hls/live.m3u8',    // HLS radio bouquet
  ]) {
    check(`radio MEDIA ${stream}`, p.allowNetworkURL(stream, 'media'), true);
    check(`radio fetch ${stream}`, p.allowNetworkURL(stream), false);
  }

  // Station artwork / logos from the directory's CDN — <img>, so exempt.
  check('radio logo MEDIA', p.allowNetworkURL('https://cdn.example.fm/logos/soma.png', 'media'), true);

  // But the app still can't quietly POST listening history somewhere new.
  check('radio undeclared POST denied',
    p.allowNetworkURL('https://analytics.example/collect?u=listener'), false);
}

// =========================================================================
// 6. Shell pages (grant-all) are unchanged
// =========================================================================
{
  const p = new BrowserPermissionPolicy();
  p.setManifestPermissions(null, null, null, null);
  check('shell fetch', p.allowNetworkURL('https://anything.example/'), true);
  check('shell media', p.allowNetworkURL('https://anything.example/v.mp4', 'media'), true);
}

// =========================================================================
// 7. The grant registry that carries <img> loads to the loaders
// =========================================================================
{
  clearMediaGrants();
  const url = 'https://logos.example.org/ch1.png';
  check('ungranted kind', networkRequestKindFor(url), 'default');
  grantMediaUrl(url);
  check('granted kind', networkRequestKindFor(url), 'media');

  // A grant is exact — a different path on the same host is not covered, so
  // one image load can't blanket-authorise an origin.
  check('sibling path not granted',
    networkRequestKindFor('https://logos.example.org/other.png'), 'default');

  // Non-network URLs are dropped rather than recorded: app assets resolve to
  // brewser:// and are served by a local loader that never sees this gate.
  const before = mediaGrantCount();
  grantMediaUrl('brewser://apps/test/assets/logo.png');
  grantMediaUrl('sdmc:/switch/brewser/x.png');
  grantMediaUrl('');
  check('non-network not recorded', mediaGrantCount(), before);

  // Cleared on navigation, so one app's grants never outlive it.
  clearMediaGrants();
  check('cleared kind', networkRequestKindFor(url), 'default');
  check('cleared count', mediaGrantCount(), 0);
}

// =========================================================================
// 8. Grant set stays bounded (a long catalogue scroll must not grow it)
// =========================================================================
{
  clearMediaGrants();
  for (let i = 0; i < 700; i++) grantMediaUrl(`https://cdn.example.com/img/${i}.png`);
  check('bounded <= 512', mediaGrantCount() <= 512, true);
  // FIFO: the newest survive, the oldest are evicted.
  check('newest retained', networkRequestKindFor('https://cdn.example.com/img/699.png'), 'media');
  check('oldest evicted', networkRequestKindFor('https://cdn.example.com/img/0.png'), 'default');

  // Re-granting an existing URL refreshes its position rather than leaving it
  // to age out — a logo re-loaded on every scroll must not be evicted ahead
  // of one seen once.
  clearMediaGrants();
  const sticky = 'https://cdn.example.com/sticky.png';
  grantMediaUrl(sticky);
  for (let i = 0; i < 400; i++) grantMediaUrl(`https://cdn.example.com/a/${i}.png`);
  grantMediaUrl(sticky);
  for (let i = 0; i < 400; i++) grantMediaUrl(`https://cdn.example.com/b/${i}.png`);
  check('re-granted survives', networkRequestKindFor(sticky), 'media');
}

// =========================================================================
// 9. user_origins — the user-granted-origin opt-in
// =========================================================================
{
  // Opting in must NOT change anything for apps that didn't.
  const legacy = appPolicy(['network'], []);          // empty list, no flag
  check('legacy empty list still unrestricted',
    legacy.networkURLDecision('https://anywhere.example/x'), 'allow');

  const listed = appPolicy(['network'], ['https://api.example.com']);
  check('no-flag undeclared still denies',
    listed.networkURLDecision('https://other.example/x'), 'deny');

  // The Jellyfin shape, opted in: empty list stops meaning "unrestricted".
  const p = new BrowserPermissionPolicy();
  p.setManifestPermissions(
    'com.test.jf', ['local_network', 'storage'],
    'sdmc:/switch/brewser/apps/jf/', [], true,
  );
  check('user_origins LAN undeclared -> prompt',
    p.networkURLDecision('http://192.168.1.64:8096/System/Info'), 'prompt');
  // ...which is TIGHTER than the empty-list default it replaces.
  check('user_origins sync gate fails closed',
    p.allowNetworkURL('http://192.168.1.64:8096/System/Info'), false);
  // local_network is still LAN-only for an opted-in app.
  check('user_origins public still denied (local_network)',
    p.networkURLDecision('https://evil.example/x'), 'deny');

  // Media NEVER prompts — the user's explicit requirement. A stream must not
  // stop mid-playback to ask about a CDN edge it rolled onto.
  check('user_origins MEDIA never prompts',
    p.networkURLDecision('http://192.168.1.64:8096/Videos/1/stream', 'media'), 'allow');

  // Granting one origin doesn't grant its neighbours.
  p.addGrantedOrigin('http://192.168.1.64:8096');
  check('granted origin allowed',
    p.networkURLDecision('http://192.168.1.64:8096/System/Info'), 'allow');
  check('granted origin covers other paths',
    p.networkURLDecision('http://192.168.1.64:8096/Users/1/Items'), 'allow');
  check('different port NOT granted',
    p.networkURLDecision('http://192.168.1.64:9999/x'), 'prompt');
  check('different host NOT granted',
    p.networkURLDecision('http://192.168.1.65:8096/x'), 'prompt');

  // Re-scoping (navigation / next app) drops grants.
  p.setManifestPermissions(
    'com.test.jf', ['local_network'], 'sdmc:/switch/brewser/apps/jf/', [], true,
  );
  check('grants cleared on re-scope',
    p.networkURLDecision('http://192.168.1.64:8096/x'), 'prompt');

  // Shell pages never prompt, flag or not.
  const shell = new BrowserPermissionPolicy();
  shell.setManifestPermissions(null, null, null, null, true);
  check('shell page never prompts',
    shell.networkURLDecision('https://anywhere.example/'), 'allow');

  // The device-owner gate still wins over an opted-in app.
  const off = new BrowserPermissionPolicy({ allowNetwork: false });
  off.setManifestPermissions('com.test.jf', ['network'], null, [], true);
  check('settings-off beats user_origins',
    off.networkURLDecision('https://example.com/'), 'deny');
}

// =========================================================================
// 10. First-party *.brewser.io is never gated (and never prompts)
// =========================================================================
{
  // An opted-in app must not be asked to approve Brewser's own relay before
  // it can save a score — platform infrastructure is not app egress.
  const p = new BrowserPermissionPolicy();
  p.setManifestPermissions('com.test.mp', ['network'], null, [], true);
  for (const u of [
    'https://brewser.io/api/saves',
    'https://play.brewser.io/apps/x/',
    'wss://ws.brewser.io/?app=com.test.mp&room=1',
  ]) {
    check(`first-party ${u}`, p.networkURLDecision(u), 'allow');
  }

  // Also exempt for an app with a strict declared list (artistemultiplayerpaint
  // shape: multiplayer relay without declaring it).
  const q = appPolicy(['network'], ['https://api.example.com']);
  check('first-party wss with strict list',
    q.networkURLDecision('wss://ws.brewser.io/?app=x'), 'allow');

  // TLS only — a plaintext lookalike must not mint a first-party origin.
  check('plaintext brewser.io NOT first-party',
    q.networkURLDecision('http://ws.brewser.io/'), 'deny');
  // And a suffix attack must not match.
  check('notbrewser.io NOT first-party',
    q.networkURLDecision('https://notbrewser.io/'), 'deny');
  check('brewser.io.evil.com NOT first-party',
    q.networkURLDecision('https://brewser.io.evil.com/'), 'deny');
}

// =========================================================================
// 11. The async prompt broker
// =========================================================================
{
  const mkPolicy = () => {
    const p = new BrowserPermissionPolicy();
    p.setManifestPermissions('com.test.jf', ['network'], null, [], true);
    return p;
  };
  const LAN = 'http://192.168.1.64:8096/System/Info';

  // Fails closed when no shell UI is registered — an app that opted into
  // user-granted origins gets nothing rather than everything.
  setOriginPromptHandler(null);
  clearOriginPromptSession();
  check('no handler -> deny', await resolveNetworkAccess(mkPolicy(), LAN), false);

  // 'allow' grants, and the answer is remembered for the session so a
  // retrying app can't re-ask.
  let asked = 0;
  clearOriginPromptSession();
  const p1 = mkPolicy();
  setOriginPromptHandler(async () => { asked++; return 'allow'; });
  check('allow -> granted', await resolveNetworkAccess(p1, LAN), true);
  check('allow -> still granted', await resolveNetworkAccess(p1, LAN), true);
  check('asked exactly once', asked, 1);

  // A deny is remembered too — three dialogs for one refusal is worse than
  // the refusal.
  asked = 0;
  clearOriginPromptSession();
  const p2 = mkPolicy();
  setOriginPromptHandler(async () => { asked++; return 'deny'; });
  check('deny -> refused', await resolveNetworkAccess(p2, LAN), false);
  check('deny -> still refused', await resolveNetworkAccess(p2, LAN), false);
  check('deny asked once', asked, 1);

  // Concurrent requests to one origin share a single prompt. A page firing
  // an API call plus two images at a new host must not open three dialogs.
  asked = 0;
  clearOriginPromptSession();
  const p3 = mkPolicy();
  setOriginPromptHandler(async () => {
    asked++;
    await new Promise((r) => setTimeout(r, 10));
    return 'allow';
  });
  const answers = await Promise.all([
    resolveNetworkAccess(p3, 'http://192.168.1.64:8096/a'),
    resolveNetworkAccess(p3, 'http://192.168.1.64:8096/b'),
    resolveNetworkAccess(p3, 'http://192.168.1.64:8096/c'),
  ]);
  check('concurrent all allowed', answers.every(Boolean), true);
  check('concurrent asked once', asked, 1);

  // A throwing handler is a refusal, never an exception to the caller.
  clearOriginPromptSession();
  setOriginPromptHandler(async () => { throw new Error('modal exploded'); });
  check('handler throw -> deny', await resolveNetworkAccess(mkPolicy(), LAN), false);

  // Media bypasses the broker entirely — no handler call at all.
  asked = 0;
  clearOriginPromptSession();
  setOriginPromptHandler(async () => { asked++; return 'deny'; });
  check('media resolves allow',
    await resolveNetworkAccess(mkPolicy(), 'http://192.168.1.64:8096/v.mkv', 'media'), true);
  check('media never asked', asked, 0);

  // A policy with no networkURLDecision (an embedder's own) falls back to
  // the boolean gate and never prompts.
  clearOriginPromptSession();
  const legacyPolicy = {
    allowNetworkURL: () => true,
    currentAppId: () => null,
  };
  check('legacy policy falls back',
    await resolveNetworkAccess(legacyPolicy, 'https://anywhere.example/'), true);

  setOriginPromptHandler(null);
  clearOriginPromptSession();
}

// =========================================================================
// 12. Platform-internal requests (the reachability probe)
// =========================================================================
{
  // The probe re-runs on a timer, so it fires while an app is loaded and was
  // being judged against THAT app's manifest: silently denied on an
  // allowlisted app (the connectivity indicator could flip "offline" purely
  // because an app was open), and a permission dialog for one.one.one.one /
  // example.com on a user_origins app.
  // Exactly the shipped jellyfinclient manifest: network + local_network +
  // storage, empty allowlist, user_origins on. This is the combination that
  // produced the reported dialogs.
  const p = new BrowserPermissionPolicy();
  p.setManifestPermissions(
    'com.test.jf', ['network', 'local_network', 'storage'], null, [], true,
  );

  for (const u of ['https://one.one.one.one/', 'http://example.com/']) {
    check(`probe ${u} default -> prompt`, p.networkURLDecision(u), 'prompt');
    check(`probe ${u} platform -> allow`, p.networkURLDecision(u, 'platform'), 'allow');
  }

  // The other half of the same bug: a LAN-only app made the probe's PUBLIC
  // targets deny outright, so the connectivity indicator could read "offline"
  // purely because such an app was open.
  const lanOnly = appPolicy(['local_network'], []);
  check('lan-only app: probe denied by default',
    lanOnly.networkURLDecision('https://one.one.one.one/'), 'deny');
  check('lan-only app: probe allowed as platform',
    lanOnly.networkURLDecision('https://one.one.one.one/', 'platform'), 'allow');

  // Also outranks a strict allowlist on a non-opted-in app.
  const q = appPolicy(['network'], ['https://api.example.com']);
  check('platform beats strict list',
    q.networkURLDecision('https://one.one.one.one/', 'platform'), 'allow');
  // ...and an app with NO network permission at all: the probe is the
  // shell's, not the app's.
  const noPerm = appPolicy(['storage'], []);
  check('platform beats missing network perm',
    noPerm.networkURLDecision('https://one.one.one.one/', 'platform'), 'allow');

  // But NOT the device-owner Settings gate.
  const off = new BrowserPermissionPolicy({ allowNetwork: false });
  off.setManifestPermissions('com.test.jf', ['network'], null, [], true);
  check('settings-off beats platform',
    off.networkURLDecision('https://one.one.one.one/', 'platform'), 'deny');

  // The marker is object identity, never a header — a page cannot forge it
  // by copying whatever the probe sends.
  const probeInit = markPlatformRequest({ headers: { 'x-brewser-priority': '1' } });
  check('marked init recognised', isPlatformRequest(probeInit), true);
  check('lookalike init NOT recognised',
    isPlatformRequest({ headers: { 'x-brewser-priority': '1' } }), false);
  check('undefined init NOT recognised', isPlatformRequest(undefined), false);
  check('null init NOT recognised', isPlatformRequest(null), false);

  // And a platform request never reaches the prompt broker.
  let asked = 0;
  clearOriginPromptSession();
  setOriginPromptHandler(async () => { asked++; return 'deny'; });
  check('platform resolves allow',
    await resolveNetworkAccess(p, 'https://one.one.one.one/', 'platform'), true);
  check('platform never asked', asked, 0);
  setOriginPromptHandler(null);
  clearOriginPromptSession();
}

rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
