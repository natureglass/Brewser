// Shared per-user catalogue sync for a signed-in Brewser account.
//
// SINGLE SOURCE OF TRUTH for fetching the WordPress per-user documents —
// "My Apps" (my-catalogue), Favorites, and earned Achievements — with the
// active session's Bearer token, validating them, and writing them under
// `configs/`. Consumed by BOTH the Check-for-Updates modal (updates-modal.js,
// home.html) AND the post-login auto-sync (post-login-sync.js, the account
// login pages), so the fetch / validate / write rules live in exactly one
// place and can never drift between the two callers.
//
// Every function is best-effort: signed out, missing URL, auth failure, bad
// response, or write error returns `false` and leaves any existing file
// untouched — nothing throws. Exposed as `globalThis.__brewserUserSync`.
//
// The endpoint URLs are passed IN by the caller (read from server-expanded
// `<browser-config-*/>` data attributes) so this module stays DOM-agnostic.
(function () {
  'use strict';

  // `sdmc:/switch/brewser/` on real hardware — matches BREWSER_APP_ROOT and the
  // paths every other shell script writes (see updates-modal.js).
  var APP_ROOT = 'sdmc:/switch/brewser/';
  var MY_CATALOGUE_PATH = APP_ROOT + 'configs/my-catalogue.json';
  var FAVORITES_PATH    = APP_ROOT + 'configs/favorites.json';
  var ACHIEVEMENTS_PATH = APP_ROOT + 'configs/my-achievements.json';

  // Bearer token from the single active session (auth-shared.js). Returns ''
  // when signed out (no active provider / no populated record).
  function readAuthToken() {
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.readActiveSession === 'function') {
      var session = globalThis.__swbAuth.readActiveSession();
      if (session && session.record && typeof session.record.token === 'string') {
        return session.record.token;
      }
    }
    return '';
  }

  // Shared authed GET → response text. Returns null on any skip / failure
  // (missing URL, signed out, network throw, non-2xx, body read error).
  async function fetchAuthedText(url, label) {
    if (!url) return null;
    var token = readAuthToken();
    if (!token) return null; // signed out — nothing to fetch
    var response;
    try {
      response = await globalThis.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    } catch (e) {
      console.debug('[user-sync] ' + label + ' fetch threw: ' + (e && e.message ? e.message : String(e)));
      return null;
    }
    if (!response.ok) {
      console.debug('[user-sync] ' + label + ' HTTP ' + response.status);
      return null;
    }
    try { return await response.text(); }
    catch (e) { console.debug('[user-sync] ' + label + ' body read failed'); return null; }
  }

  // Validate a catalogue-v2 document through the platform client — never write
  // one the runtime can't read (same rule the catalogue itself follows). When
  // no platform client is available (a page without the shell bridge), skip
  // validation rather than block the write; on every console the bridge is
  // installed at boot, so this fallback is defensive only.
  function catalogueValid(text) {
    var client = globalThis.__brewserPlatformClient;
    if (!client || typeof client.parseCatalogue !== 'function') return true;
    var outcome;
    try { outcome = client.parseCatalogue(text); }
    catch (e) { console.debug('[user-sync] parseCatalogue threw'); return false; }
    if (!outcome || outcome.kind !== 'Ok') {
      console.debug('[user-sync] catalogue rejected: ' + (outcome ? outcome.kind : 'no outcome'));
      return false;
    }
    return true;
  }

  // "My Apps" — the per-user catalogue-v2 document (the user's own published /
  // staged / unpublished apps). Validated then written to my-catalogue.json.
  async function syncMyCatalogue(url) {
    var text = await fetchAuthedText(url, 'my-catalogue');
    if (text === null) return false;
    if (!catalogueValid(text)) return false;
    try { Switch.writeFileSync(MY_CATALOGUE_PATH, text); }
    catch (e) { console.debug('[user-sync] my-catalogue write failed: ' + (e && e.message ? e.message : String(e))); return false; }
    return true;
  }

  // Favorites — also a catalogue-v2 document (published apps the user starred),
  // same validation path as My Apps, written to favorites.json.
  async function syncFavorites(url) {
    var text = await fetchAuthedText(url, 'favorites');
    if (text === null) return false;
    if (!catalogueValid(text)) return false;
    try { Switch.writeFileSync(FAVORITES_PATH, text); }
    catch (e) { console.debug('[user-sync] favorites write failed: ' + (e && e.message ? e.message : String(e))); return false; }
    return true;
  }

  // Earned Achievements — a small custom document
  // ({ version, generated, achievements: [...] }), NOT catalogue-v2, so it's
  // validated as JSON carrying an `achievements` array (a stray HTML 200 or a
  // shape drift can't replace a good file). Written to my-achievements.json —
  // NOT achievements.json (that's the bundled 38-achievement CRITERIA
  // catalogue, which must not be clobbered).
  async function syncAchievements(url) {
    var text = await fetchAuthedText(url, 'achievements');
    if (text === null) return false;
    try {
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.achievements)) {
        console.debug('[user-sync] achievements body missing achievements array; refusing write');
        return false;
      }
    } catch (e) {
      console.debug('[user-sync] achievements is not valid JSON; refusing write: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
    try { Switch.writeFileSync(ACHIEVEMENTS_PATH, text); }
    catch (e) { console.debug('[user-sync] achievements write failed: ' + (e && e.message ? e.message : String(e))); return false; }
    return true;
  }

  globalThis.__brewserUserSync = {
    readAuthToken: readAuthToken,
    syncMyCatalogue: syncMyCatalogue,
    syncFavorites: syncFavorites,
    syncAchievements: syncAchievements,
  };
  console.debug('[user-sync] ready');
})();
