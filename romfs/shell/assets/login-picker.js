// Sign-in picker. Drives shell/login.html. For each provider, probes
// `sdmc:/switch/brewser/shell/auth/<provider>-auth.json` at boot and
// stamps the tile with the saved display name + avatar thumb when a
// valid record is present. Stays silent (placeholder + "Not signed in"
// status) when the file is missing, empty, or the record lacks an `id`.
//
// Tapping any tile navigates to that provider's login page; the
// provider page's own boot script runs `trySilentVerify` against its
// stored token, so a still-valid login lands directly on the success
// stage without prompting the user.
//
// Provider config drives both the file path scheme (each provider
// writes its own `<name>-auth.json` next to the avatar bitmaps) AND
// the picker's per-tile DOM ids; adding a fifth provider is a single
// PROVIDERS entry + tile markup in login.html.

(function () {
  'use strict';

  var AUTH_DIR = 'sdmc:/switch/brewser/shell/auth/';

  // Each provider exposes the same on-disk shape (see github-auth.js's
  // `record` for the canonical fields):
  //   id, login, email, name, avatar_url, avatar_local_thumb_path
  // `name` is the picker's preferred display string; `login` / `email`
  // fall back when `name` is empty (anonymous-ish accounts).
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
    if (!rec) return '';
    if (typeof rec.name  === 'string' && rec.name.length  > 0) return rec.name;
    if (typeof rec.login === 'string' && rec.login.length > 0) return rec.login;
    if (typeof rec.email === 'string' && rec.email.length > 0) return rec.email;
    return '';
  }

  function applyProviderTile(provider) {
    var statusEl      = document.getElementById('signin-status-' + provider.key);
    var avatarEl      = document.getElementById('signin-avatar-' + provider.key);
    var placeholderEl = document.getElementById('signin-placeholder-' + provider.key);
    if (!statusEl) return;
    var rec = readJson(AUTH_DIR + provider.file);
    var hasId = rec && typeof rec.id === 'string' && rec.id.length > 0;
    if (!hasId) {
      statusEl.textContent = 'Not signed in';
      statusEl.classList.remove('signin-status-in');
      return;
    }
    var name = displayNameFromRecord(rec);
    statusEl.textContent = name ? 'Signed in as ' + name : 'Signed in';
    statusEl.classList.add('signin-status-in');
    // Thumb preferred; full-size avatar is the fallback. Both live next
    // to <provider>-auth.json; we test each path before assigning so a
    // stale record (file deleted, format changed) doesn't blank the
    // tile's placeholder by setting an unloadable src.
    if (avatarEl) {
      var thumbPath = typeof rec.avatar_local_thumb_path === 'string' ? rec.avatar_local_thumb_path : '';
      var fullPath  = typeof rec.avatar_local_path === 'string' ? rec.avatar_local_path : '';
      var src = '';
      if (thumbPath && fileExists(thumbPath)) src = thumbPath;
      else if (fullPath && fileExists(fullPath)) src = fullPath;
      if (src) {
        avatarEl.src = src;
        avatarEl.removeAttribute('hidden');
        if (placeholderEl) placeholderEl.setAttribute('hidden', '');
      }
    }
  }

  function boot() {
    for (var i = 0; i < PROVIDERS.length; i++) applyProviderTile(PROVIDERS[i]);
  }

  boot();
})();
