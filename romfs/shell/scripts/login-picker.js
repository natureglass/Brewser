// Sign-in picker. Drives shell/login.html.
//
// Two visible states, switched on boot:
//   - LOGGED OUT: read `active.json`, find no active session → hide the
//     "Currently logged in" card, leave the grid tiles tappable, stamp
//     "Not signed in" on each tile's status row.
//   - LOGGED IN:  read `active.json`, find a matching provider record
//     → populate the card (service name, avatar, username), reveal it,
//     dim every grid tile + swallow its tap so the user can't start a
//     second login until they log out of the current one.
//
// "Log out" on the card runs the nuclear wipe from auth-shared.js
// (`__swbAuth.wipeAll`) — overwrites every per-provider auth.json,
// every avatar variant, every per-provider log file, and the
// active-session pointer with empty bytes. Nothing the login flow
// ever writes should remain non-empty under sdmc:/switch/brewser/
// after that returns.

(function () {
  'use strict';

  var AUTH_DIR = 'sdmc:/switch/brewser/shell/auth/';

  // Per-tile DOM ids + the per-provider `auth/<file>` paths used for
  // the "previously signed in?" status row (logged-out state only).
  // The active-session card uses `__swbAuth.readActiveSession` directly
  // and doesn't need this table.
  var PROVIDERS = [
    { key: 'github',    file: 'github-auth.json'    },
    { key: 'microsoft', file: 'microsoft-auth.json' },
    { key: 'google',    file: 'google-auth.json'    },
    { key: 'twitch',    file: 'twitch-auth.json'    },
  ];

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
    } catch (_) {
      return null;
    }
  }

  function fileExists(path) {
    if (!path) return false;
    if (typeof Switch === 'undefined' || !Switch) return false;
    try {
      var probe = Switch.readFileSync(path);
      return !!(probe && probe.byteLength > 0);
    } catch (_) { return false; }
  }

  function displayNameFromRecord(rec) {
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.displayNameFromRecord === 'function') {
      return globalThis.__swbAuth.displayNameFromRecord(rec);
    }
    if (!rec) return '';
    if (typeof rec.name  === 'string' && rec.name.length  > 0) return rec.name;
    if (typeof rec.login === 'string' && rec.login.length > 0) return rec.login;
    if (typeof rec.email === 'string' && rec.email.length > 0) return rec.email;
    return '';
  }

  function providerLabel(name) {
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.providerLabel === 'function') {
      return globalThis.__swbAuth.providerLabel(name);
    }
    return name || '';
  }

  // ------------------------------------------------------------------
  // Logged-out state: per-tile "Not signed in" stamp. Reset every tile
  // regardless of any stale provider record on disk — once the picker
  // enforces one-at-a-time via `active.json`, a non-active provider's
  // tile should never advertise itself as signed-in.
  // ------------------------------------------------------------------
  function resetTileToSignedOut(provider) {
    var statusEl = document.getElementById('signin-status-' + provider.key);
    if (!statusEl) return;
    statusEl.textContent = 'Not signed in';
    statusEl.classList.remove('signin-status-in');
  }

  // ------------------------------------------------------------------
  // Disabled-tile mode: while a session is active, every grid tile is
  // visually muted AND its underlying <a href> tap is swallowed. We
  // attach the click listener with `capture: true` so we intercept
  // BEFORE the navigation handler installed by the live-overlay
  // engine's <a> walker — preventDefault + stopPropagation drops the
  // tap before it ever becomes a nav intent.
  // ------------------------------------------------------------------
  var disabledHandlerAttached = false;
  function tileClickSwallower(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  }
  function setTilesDisabled(disabled) {
    for (var i = 0; i < PROVIDERS.length; i++) {
      var tile = document.getElementById('signin-tile-' + PROVIDERS[i].key);
      if (!tile) continue;
      if (disabled) tile.classList.add('signin-tile--disabled');
      else tile.classList.remove('signin-tile--disabled');
      // Capture-phase listener has to be added exactly once per tile;
      // the engine has no `removeEventListener` that can undo a
      // capture-true binding mid-page. We attach unconditionally on
      // first call and key the swallow on the disabled CSS class so a
      // future logout (re-enable) just re-renders the tile without
      // toggling event wiring.
      if (!disabledHandlerAttached) {
        tile.addEventListener('click', function (e) {
          var target = e && e.currentTarget;
          if (target && target.classList && target.classList.contains('signin-tile--disabled')) {
            tileClickSwallower(e);
          }
        }, true);
      }
    }
    disabledHandlerAttached = true;
  }

  // ------------------------------------------------------------------
  // Populate the "Currently logged in" card from the active provider's
  // record. Avatar prefers the cached thumb (64×64) then falls back to
  // the full bitmap; either avoids the slower CDN re-fetch the login
  // success stage's fallback path does. If neither exists (avatar
  // download failed at login time) the card slot stays empty — same
  // visual the per-tile placeholder uses elsewhere.
  // ------------------------------------------------------------------
  function populateLoggedInCard(provider, rec) {
    var card        = document.getElementById('signin-loggedin-card');
    var avatarImg   = document.getElementById('signin-loggedin-avatar-img');
    var serviceEl   = document.getElementById('signin-loggedin-service');
    var userEl      = document.getElementById('signin-loggedin-user');
    var leadEl      = document.getElementById('signin-lead');
    if (!card) return;
    if (serviceEl) serviceEl.textContent = providerLabel(provider);
    if (userEl) {
      var name = displayNameFromRecord(rec);
      userEl.textContent = name || '(no display name)';
    }
    if (avatarImg) {
      var thumb = typeof rec.avatar_local_thumb_path === 'string' ? rec.avatar_local_thumb_path : '';
      var full  = typeof rec.avatar_local_path       === 'string' ? rec.avatar_local_path       : '';
      var src = '';
      if (thumb && fileExists(thumb)) src = thumb;
      else if (full && fileExists(full)) src = full;
      if (src) avatarImg.src = src;
      else avatarImg.removeAttribute('src');
    }
    // The card starts with `signin-loggedin--hidden` (display: none) in
    // the HTML so it never flashes during boot before the picker
    // decides whether to show it. The live-CSS engine has no built-in
    // `[hidden]` UA rule, so we toggle a class instead of the
    // HTML5 `hidden` attribute (matches the `--hidden` class pattern
    // every other shell page uses, see apps.html app-modal-btn--hidden).
    card.classList.remove('signin-loggedin--hidden');
    if (leadEl) {
      leadEl.textContent = 'Log out first to switch to a different service.';
    }
  }

  function hideLoggedInCard() {
    var card = document.getElementById('signin-loggedin-card');
    if (card) card.classList.add('signin-loggedin--hidden');
    var leadEl = document.getElementById('signin-lead');
    if (leadEl) leadEl.textContent = 'Choose a service to sign in with.';
  }

  // ------------------------------------------------------------------
  // Wiring: the Log out button on the active card. Runs the nuclear
  // wipe (every provider's auth.json + every avatar variant + every
  // per-provider log + active.json), then flips the UI back to the
  // logged-out state without a navigation — the user stays on the
  // picker so they can sign into a different service immediately.
  // ------------------------------------------------------------------
  function wireLogout() {
    var btn = document.getElementById('signin-logout-btn');
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      if (globalThis.__swbAuth && typeof globalThis.__swbAuth.wipeAll === 'function') {
        globalThis.__swbAuth.wipeAll();
      }
      hideLoggedInCard();
      setTilesDisabled(false);
      for (var i = 0; i < PROVIDERS.length; i++) resetTileToSignedOut(PROVIDERS[i]);
      // Toolbar avatar can't refresh until the next renderChrome (we
      // don't have a sync handle here). Easiest nudge: navigate back to
      // home, which forces a renderChrome with the now-empty session
      // state. Skipping it leaves the stale provider avatar on the
      // toolbar until the user does anything else navigation-y.
      if (typeof globalThis.__swbRepaint === 'function') {
        try { globalThis.__swbRepaint(); } catch (_) {}
      }
    });
  }

  // ------------------------------------------------------------------
  // Boot. Two-pass:
  //   1. Reset every tile status to "Not signed in" so a stale
  //      per-provider auth.json (one that wasn't fully wiped by some
  //      earlier code path) doesn't accidentally read as active.
  //   2. Read `active.json` via the shared helper. If it names a
  //      provider AND that provider's auth.json holds a valid record,
  //      flip into logged-in mode. Otherwise stay in the logged-out
  //      grid.
  // ------------------------------------------------------------------
  function boot() {
    for (var i = 0; i < PROVIDERS.length; i++) resetTileToSignedOut(PROVIDERS[i]);
    wireLogout();
    var session = null;
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.readActiveSession === 'function') {
      session = globalThis.__swbAuth.readActiveSession();
    }
    if (session && session.provider && session.record) {
      populateLoggedInCard(session.provider, session.record);
      setTilesDisabled(true);
    } else {
      hideLoggedInCard();
      setTilesDisabled(false);
    }
  }

  boot();
})();
