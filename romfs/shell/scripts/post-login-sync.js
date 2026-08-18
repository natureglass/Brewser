// Post-login auto-sync dialog.
//
// Runs the shared per-user catalogue sync (My Apps + Favorites + Achievements)
// immediately after a FRESH sign-in, behind a loading dialog styled like the
// Check-for-Updates modal, so the "My Apps" tab (and the account-page
// Favorites / Achievements links) are ready without the user having to open
// the Apps page and press Check for Updates. Check for Updates then becomes a
// pure "refresh my list later" action rather than the only way to reveal it.
//
// Triggered by each provider's `*-auth.js` on the fresh-login success path
// ONLY (never on silent re-verify) via `globalThis.__brewserPostLoginSync.run()`.
// That path is also where `setActiveProvider()` wipes the per-user caches, so
// this re-populates exactly what login just cleared.
//
// The fetch / validate / write lives in `user-sync.js`
// (`globalThis.__brewserUserSync`); this file only drives the dialog and reads
// the endpoint URLs off the overlay's `data-*` attributes (server-expanded from
// `<browser-config-*/>`). Visibility flips via `.app-modal-overlay--open` +
// `.updates-modal-card--loading` (the SAME classes Check-for-Updates uses), so
// it inherits every theme's styling with no CSS additions. Class flips (never
// `style.display`) so the live-DOM paint cache actually erases the closed modal
// — see the reasoning in updates-modal.js / missing-app-modal.js.
(function () {
  'use strict';

  // Looked up by explicit id — LiveElement has no querySelector.
  var overlay   = document.getElementById('postlogin-sync-overlay');
  var card      = document.getElementById('postlogin-sync-card');
  var titleEl   = document.getElementById('postlogin-sync-title');
  var statusEl  = document.getElementById('postlogin-sync-status');
  var summaryEl = document.getElementById('postlogin-sync-summary');
  var errorEl   = document.getElementById('postlogin-sync-error');
  var gotoBtn   = document.getElementById('postlogin-sync-goto');
  var closeBtn  = document.getElementById('postlogin-sync-close');

  var open = false;
  var running = false;

  function show() { if (overlay) { overlay.classList.add('app-modal-overlay--open'); open = true; } }
  function close() {
    if (!overlay) return;
    overlay.classList.remove('app-modal-overlay--open');
    open = false;
  }
  function setLoading() {
    if (!card) return;
    card.classList.add('updates-modal-card--loading');
    card.classList.remove('updates-modal-card--error');
  }
  function setDone() { if (card) card.classList.remove('updates-modal-card--loading'); }

  // Read a server-expanded endpoint URL off the overlay.
  function attr(name) { return overlay ? (overlay.getAttribute(name) || '') : ''; }

  // Run the three per-user fetches in parallel via the shared module. Returns a
  // small outcome object; never throws (each sync swallows its own errors).
  async function doSync() {
    var sync = globalThis.__brewserUserSync;
    if (!sync || typeof sync.syncMyCatalogue !== 'function') {
      return { ok: false, reason: 'nosync' };
    }
    if (typeof sync.readAuthToken !== 'function' || !sync.readAuthToken()) {
      return { ok: false, reason: 'signedout' };
    }
    var results = await Promise.all([
      sync.syncMyCatalogue(attr('data-my-catalogue-url')),
      sync.syncFavorites(attr('data-favorites-url')),
      sync.syncAchievements(attr('data-achievements-url')),
    ]);
    return { ok: true, myApps: !!results[0], favorites: !!results[1], achievements: !!results[2] };
  }

  async function run() {
    if (running) return;
    running = true;
    // Defensive: this script is only loaded on pages that carry the dialog
    // markup, but if it's ever absent, still run the sync silently so the
    // caches populate.
    if (!overlay || !card) {
      try { await doSync(); } catch (_) {}
      running = false;
      return;
    }

    // Reset to a clean loading state each run.
    if (titleEl)   titleEl.textContent = 'Loading your apps…';
    if (statusEl)  statusEl.textContent = '';
    if (summaryEl) summaryEl.textContent = '';
    if (errorEl)   errorEl.textContent = '';
    if (gotoBtn)   gotoBtn.classList.remove('postlogin-hidden');
    setLoading();
    show();

    // Defer one microtask so the loading bar paints before the fetch blocks
    // the thread (mirrors updates-modal.js's open()).
    await Promise.resolve();

    var result;
    try { result = await doSync(); }
    catch (e) { result = { ok: false, reason: 'threw' }; }

    setDone();
    if (titleEl) titleEl.textContent = 'My Apps';

    if (result.ok && result.myApps) {
      if (statusEl) statusEl.textContent = 'Your apps are ready.';
      var extra = [];
      if (result.favorites)    extra.push('Favorites');
      if (result.achievements) extra.push('Achievements');
      if (summaryEl) {
        summaryEl.textContent = 'My Apps synced'
          + (extra.length ? ' — also refreshed ' + extra.join(' & ') : '') + '.';
      }
      if (gotoBtn) gotoBtn.classList.remove('postlogin-hidden');
    } else if (result.ok) {
      // Signed in, but the endpoint returned no owned apps (a fresh account, or
      // all apps rejected/failed server-side). Nothing to jump to.
      if (statusEl)  statusEl.textContent = 'Signed in.';
      if (summaryEl) summaryEl.textContent = 'You have no published, staged, or unpublished apps yet.';
      if (gotoBtn)   gotoBtn.classList.add('postlogin-hidden');
    } else {
      // Fetch failed (offline, endpoint error). Not fatal — the login itself
      // succeeded; the user can retry from Check for Updates later.
      if (card) card.classList.add('updates-modal-card--error');
      if (statusEl) statusEl.textContent = 'Couldn’t load your apps right now.';
      if (errorEl)  errorEl.textContent = 'You can retry any time from “Check for Updates” on the Apps page.';
      if (gotoBtn)  gotoBtn.classList.add('postlogin-hidden');
    }
    running = false;
  }

  // Close button dismisses back to the account success card. "View My Apps" is
  // an <a href="brewser://home/"> — the shell handles its navigation, so it
  // needs no JS. Backdrop tap also closes. These are element-scoped listeners
  // only (no window-level input hooks) so the login page's B / L button
  // behaviour is unchanged while the dialog is closed.
  if (closeBtn) {
    closeBtn.addEventListener('click', function (e) {
      close();
      if (e && e.stopPropagation) e.stopPropagation();
    });
  }
  if (overlay) {
    overlay.addEventListener('click', function (e) {
      if (e && e.target === overlay) close();
    });
  }

  globalThis.__brewserPostLoginSync = { run: run };
  console.debug('[post-login-sync] ready (dialog=' + (!!overlay) + ')');
})();
