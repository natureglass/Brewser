// "Fetch my Apps" button wiring for apps.html.
//
// The button ships hidden (`.apps-fetch-mine--hidden`). This script reveals
// it ONLY when a Brewser account is signed in, then on tap:
//   1. fetches the signed-in user's OWN apps from WordPress with their Bearer
//      session token (Authorization: Bearer <record.token>),
//   2. validates the response through the platform client (never persists a
//      document the runtime can't read),
//   3. writes it to `configs/my-catalogue.json`, and
//   4. reloads the page so the resource loader re-renders apps.html WITH the
//      "My Apps" tab (which it renders from that file).
//
// Loaded AFTER auth-shared.js so `globalThis.__swbAuth` exists. Node lookups
// use `document.querySelector('.class')` (the document shim's class-selector
// branch) — LiveElement has no querySelector.
(function () {
  'use strict';

  var btn = document.querySelector('.apps-fetch-mine');
  if (!btn) {
    console.debug('[my-apps] init aborted; .apps-fetch-mine not found');
    return;
  }

  // Same on-disk root as updates-modal.js. The resource loader reads
  // configs/my-catalogue.json when rendering the "My Apps" tab + label.
  var APP_ROOT = 'sdmc:/switch/brewser/';
  var MY_CATALOGUE_PATH = APP_ROOT + 'configs/my-catalogue.json';

  // The active session's WordPress Bearer token, or '' when signed out.
  // `record.token` is the HS256 envelope minted by /auth/device-mint and
  // persisted by google-auth.js.
  function currentToken() {
    if (!globalThis.__swbAuth || typeof globalThis.__swbAuth.readActiveSession !== 'function') return '';
    var session = globalThis.__swbAuth.readActiveSession();
    if (!session || !session.record) return '';
    var t = session.record.token;
    return (typeof t === 'string' && t.length > 0) ? t : '';
  }

  if (!currentToken()) {
    // Signed out — leave the button hidden. A later sign-in re-renders the
    // page, so this script re-runs and reveals it then.
    console.debug('[my-apps] no active session — button stays hidden');
    return;
  }

  // Reveal the button (class toggle — inline styles aren't used by the shell
  // scripts; visibility is class-driven, same as login-picker's card).
  btn.classList.remove('apps-fetch-mine--hidden');
  if (typeof globalThis.__swbRepaint === 'function') {
    try { globalThis.__swbRepaint(); } catch (_) {}
  }
  console.debug('[my-apps] wired + revealed');

  var inFlight = false;

  function setLabel(text) {
    // textContent mutation repaints the button in place.
    btn.textContent = text;
  }

  async function fetchMine() {
    if (inFlight) return;
    var token = currentToken();
    if (!token) { setLabel('Sign in first'); return; }
    var url = btn.getAttribute('data-my-catalogue-url') || '';
    if (!url) {
      setLabel('No endpoint');
      console.debug('[my-apps] no data-my-catalogue-url configured');
      return;
    }

    inFlight = true;
    setLabel('Fetching…');
    try {
      var response;
      try {
        response = await globalThis.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      } catch (e) {
        setLabel('Network error');
        console.debug('[my-apps] fetch threw: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setLabel('Sign in again');
        console.debug('[my-apps] auth rejected: HTTP ' + response.status);
        return;
      }
      if (!response.ok) {
        setLabel('HTTP ' + response.status);
        return;
      }
      var text;
      try {
        text = await response.text();
      } catch (e) {
        setLabel('Read failed');
        console.debug('[my-apps] body read failed: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      // Validate before persisting — the endpoint emits a catalogue-v2
      // envelope the platform client understands. An Ok outcome is the
      // only one we write; anything else keeps the old file (if any).
      var client = globalThis.__brewserPlatformClient;
      if (client && typeof client.parseCatalogue === 'function') {
        var outcome;
        try {
          outcome = client.parseCatalogue(text);
        } catch (e) {
          setLabel('Parse error');
          console.debug('[my-apps] parseCatalogue threw: ' + (e && e.message ? e.message : String(e)));
          return;
        }
        if (!outcome || outcome.kind !== 'Ok') {
          setLabel('Bad response');
          console.debug('[my-apps] my-catalogue rejected: ' + (outcome ? outcome.kind : 'no outcome'));
          return;
        }
      }
      try {
        Switch.writeFileSync(MY_CATALOGUE_PATH, text);
      } catch (e) {
        setLabel('Write failed');
        console.debug('[my-apps] write failed: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      // Reload so the resource loader re-renders apps.html WITH the "My Apps"
      // tab (it reads the file we just wrote). __swbReload re-runs the full
      // load pipeline including server-tag expansion.
      setLabel('Loaded — reloading…');
      if (typeof globalThis.__swbReload === 'function') {
        try {
          await globalThis.__swbReload();
          return; // page is being replaced; nothing else to do
        } catch (e) {
          console.debug('[my-apps] reload failed: ' + (e && e.message ? e.message : String(e)));
        }
      }
      // Fallback when no reload primitive is available.
      setLabel('Loaded — reopen Apps');
    } finally {
      inFlight = false;
    }
  }

  btn.addEventListener('click', function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    void fetchMine();
  });
})();
