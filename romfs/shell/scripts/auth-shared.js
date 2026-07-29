// Shared auth helpers — loaded before each `<provider>-auth.js` and by
// `login-picker.js`. Exposes a small surface on `globalThis` that the
// per-provider scripts and the picker use to coordinate "one active
// session at a time" on disk.
//
// On-disk model:
//   - `sdmc:/switch/brewser/shell/auth/<provider>-auth.json` — token
//     + cached user info + avatar paths (per-provider; owned by that
//     provider's auth.js).
//   - `sdmc:/switch/brewser/shell/auth/<provider>-avatar.<ext>` +
//     `<provider>-avatar_64x64.<ext>` — cached avatar bitmaps.
//   - `sdmc:/switch/brewser/shell/auth/active.json` — pointer file
//     `{"provider":"<name>"}` identifying the single active session
//     (this module).
//   - `sdmc:/switch/brewser/logs/<provider>-auth.log` — diagnostic log
//     that captures fetch URLs + response bodies (including tokens) and
//     therefore counts as "login-flow data" that has to be wiped on
//     full logout.
//
// Switch.writeFileSync(path, empty Uint8Array) is the "delete" the
// runtime exposes — there's no unlinkSync. An empty file is
// indistinguishable from "missing" to every reader in the auth flow:
// each `loadStoredRecord` / `fileExists` probe checks byteLength > 0
// before treating the file as populated.

(function () {
  'use strict';

  var AUTH_DIR    = 'sdmc:/switch/brewser/shell/auth/';
  var ACTIVE_PATH = AUTH_DIR + 'active.json';
  var LOG_DIR     = 'sdmc:/switch/brewser/logs/';
  // Per-user "My Apps" cache (written by my-apps.js). Tied to a specific
  // signed-in user's token, so it is cleared on every login + logout below
  // and must never survive one session into another.
  var MY_CATALOGUE_PATH = 'sdmc:/switch/brewser/configs/my-catalogue.json';

  var PROVIDERS = ['google', 'microsoft'];

  // Every avatar extension that may have ever been written by any
  // provider. The actual on-disk extension is whatever
  // Content-Type/magic-bytes returned at download time; on wipe we
  // overwrite ALL of them so a format change between login sessions
  // can't leave a stale bitmap behind.
  var AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

  function authJsonPath(provider) {
    return AUTH_DIR + provider + '-auth.json';
  }
  function avatarPaths(provider) {
    var out = [];
    for (var i = 0; i < AVATAR_EXTS.length; i++) {
      var e = AVATAR_EXTS[i];
      out.push(AUTH_DIR + provider + '-avatar.'        + e);
      out.push(AUTH_DIR + provider + '-avatar_64x64.'  + e);
    }
    return out;
  }
  function logPath(provider) {
    return LOG_DIR + provider + '-auth.log';
  }

  function safeWriteEmpty(path) {
    if (!path) return;
    if (typeof Switch === 'undefined' || !Switch) return;
    try { Switch.writeFileSync(path, new Uint8Array(0)); } catch (_) {}
  }

  /** Clear the cached per-user "My Apps" document. Empty bytes read as
   * "missing" to loadMyAppsTab, so the My Apps tab disappears. Called on
   * login (a new user must not inherit the previous user's apps) and on
   * every logout path. */
  function clearMyCatalogue() {
    safeWriteEmpty(MY_CATALOGUE_PATH);
  }

  function readJson(path) {
    if (typeof Switch === 'undefined' || !Switch) return null;
    try {
      var raw = Switch.readFileSync(path);
      if (!raw || raw.byteLength === 0) return null;
      var text = new TextDecoder().decode(raw);
      if (!text.trim()) return null;
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (_) { return null; }
  }

  /** Read `auth/active.json` and return the named provider, or '' if
   * the file is missing/empty/malformed/names an unknown provider. */
  function readActiveProvider() {
    var rec = readJson(ACTIVE_PATH);
    if (!rec) return '';
    var p = typeof rec.provider === 'string' ? rec.provider : '';
    return PROVIDERS.indexOf(p) >= 0 ? p : '';
  }

  /** Read `auth/<provider>-auth.json`; returns the parsed record or
   * `null` for missing / empty / no-id. Same shape every provider
   * persists (id, login, email, name, avatar_url, avatar_local_path,
   * avatar_local_thumb_path, plus tokens and timestamps). */
  function readProviderRecord(provider) {
    if (!provider) return null;
    var rec = readJson(authJsonPath(provider));
    if (!rec) return null;
    if (typeof rec.id !== 'string' || rec.id.length === 0) return null;
    return rec;
  }

  /** Returns `{ provider, record }` when both `active.json` names a
   * provider AND that provider's `<provider>-auth.json` holds a valid
   * record. `null` otherwise (no active session). Callers should treat
   * `null` as "show the picker grid, hide the logged-in card." */
  function readActiveSession() {
    var provider = readActiveProvider();
    if (!provider) return null;
    var record = readProviderRecord(provider);
    if (!record) return null;
    return { provider: provider, record: record };
  }

  /** Write `auth/active.json` so this provider becomes the single
   * active session. Each per-provider auth.js calls this from
   * `showSuccess` after persisting + downloading the avatar. */
  function setActiveProvider(provider) {
    if (PROVIDERS.indexOf(provider) < 0) return;
    if (typeof Switch === 'undefined' || !Switch) return;
    try { Switch.mkdirSync(AUTH_DIR); } catch (_) {}
    try {
      Switch.writeFileSync(
        ACTIVE_PATH,
        JSON.stringify({ provider: provider, saved_at: Date.now() }, null, 2),
      );
    } catch (_) {}
    // A fresh login must not inherit a prior user's cached My Apps.
    clearMyCatalogue();
  }

  /** Overwrite `auth/active.json` with empty bytes. Per-page logout
   * buttons call this so the "one active at a time" invariant holds
   * even when the user logs out from a provider page instead of the
   * central login dashboard. */
  function clearActiveProvider() {
    safeWriteEmpty(ACTIVE_PATH);
    clearMyCatalogue();
  }

  /** Wipe every artifact the login flow may have ever written for a
   * single provider: its auth.json, every cached avatar variant, and
   * its log file. */
  function wipeProvider(provider) {
    if (PROVIDERS.indexOf(provider) < 0) return;
    safeWriteEmpty(authJsonPath(provider));
    var avs = avatarPaths(provider);
    for (var i = 0; i < avs.length; i++) safeWriteEmpty(avs[i]);
    safeWriteEmpty(logPath(provider));
  }

  /** Nuclear logout. Iterates every known provider plus `active.json`.
   * Used by login.html's central "Log out" button — after this returns,
   * nothing the login flow ever wrote should remain non-empty on disk. */
  function wipeAll() {
    for (var i = 0; i < PROVIDERS.length; i++) wipeProvider(PROVIDERS[i]);
    clearActiveProvider();
  }

  /** Wipe every provider EXCEPT the named one. Each per-provider
   * `showSuccess` calls this to enforce the "one service login at a
   * time" invariant when a fresh login lands on top of a prior session. */
  function wipeOthers(keepProvider) {
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i] !== keepProvider) wipeProvider(PROVIDERS[i]);
    }
  }

  /** Best display string for a record: `name` first, then `login`
   * (Microsoft userPrincipalName), then `email`. Returns '' when none
   * of those fields carry a non-empty string — callers usually
   * substitute a "(no display name)" placeholder. */
  function displayNameFromRecord(rec) {
    if (!rec) return '';
    if (typeof rec.name  === 'string' && rec.name.length  > 0) return rec.name;
    if (typeof rec.login === 'string' && rec.login.length > 0) return rec.login;
    if (typeof rec.email === 'string' && rec.email.length > 0) return rec.email;
    return '';
  }

  /** Human-readable provider name for UI labels ("Google", "Microsoft").
   * Defensive fallback returns the raw string. */
  function providerLabel(provider) {
    switch (provider) {
      case 'google':    return 'Google';
      case 'microsoft': return 'Microsoft';
      default:          return provider || '';
    }
  }

  globalThis.__swbAuth = {
    PROVIDERS: PROVIDERS.slice(),
    readActiveSession: readActiveSession,
    readActiveProvider: readActiveProvider,
    readProviderRecord: readProviderRecord,
    setActiveProvider: setActiveProvider,
    clearActiveProvider: clearActiveProvider,
    wipeProvider: wipeProvider,
    wipeAll: wipeAll,
    wipeOthers: wipeOthers,
    displayNameFromRecord: displayNameFromRecord,
    providerLabel: providerLabel,
  };
})();
