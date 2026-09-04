// Boot-time "new version available" check + toast.
//
// On the shell's boot landing (home.html) this fires ONCE per process: if the
// device is online, it does the single fastest fetch possible — the tiny
// per-build version snapshot `romfs/configs/current.json` on the release
// branch — and semver-compares its `brewser` field against the installed
// baseline on disk (`sdmc:/switch/brewser/configs/current.json`, the immutable
// "I shipped with these bits" copy the seed walker mirrors from romfs:/). If a
// STRICTLY-NEWER Brewser is published, a small clickable pill slides up at the
// bottom of the screen reading "There is a new version available vX.X.X",
// auto-hides after 3 s, and — when tapped — fires the EXACT same action as the
// "Check for Updates" toolbar button (globalThis.__brewserOpenUpdatesModal from
// updates-modal.js), which runs the full sweep and surfaces the yellow
// "Update Brewser vX.X.X" button.
//
// This is deliberately NOT the heavy `runCheck()` the button runs (catalogue +
// stats + downloads + ratings + my-apps + favorites + achievements + versions):
// the boot path pulls ONE ~60-byte JSON and compares one field, so it can't
// perceptibly slow boot. Everything is best-effort — every failure path leaves
// the shell exactly as it was (no toast, no error surfaced), so an offline boot
// (e.g. Citron, which has no network) is silent.
//
// Visibility flips via classList (`boot-update-toast--show`), NOT
// `style.display`: a direct field write on a LiveElement doesn't invalidate the
// live-DOM paint cache, so the closed toast would leave stale pixels — the same
// reason the sibling modals use classList. The version text is written with a
// fresh innerHTML/textContent stamp (cache-safe new nodes) before the reveal.

(function () {
  'use strict';

  // Run once per process. `home.html` is re-run on every `__swbReload` (e.g.
  // after a Check-for-Updates close), and it is the app's Home page, so without
  // this guard the poll + toast would re-fire on every home navigation. The
  // spec is "on app launch … poll only once".
  if (globalThis.__brewserBootUpdateChecked) return;
  globalThis.__brewserBootUpdateChecked = true;

  // The per-build version snapshot on the release branch. This is the file
  // `scripts/collect_current.py` regenerates and commits into romfs on every
  // build, so it is the authoritative "latest published Brewser" signal and is
  // guaranteed to exist (it ships inside the repo). `refs/heads/main` is the
  // fully-qualified ref form; raw.githubusercontent.com serves it identically
  // to the bare `main` form the self-updater uses.
  var BOOT_VERSION_URL = 'https://raw.githubusercontent.com/natureglass/Brewser/refs/heads/main/romfs/configs/current.json';
  // The installed baseline — same path + invariant the Check-for-Updates flow
  // compares against (never overwritten except by the self-update apply, which
  // stamps it to the freshly-installed version so this check reads equal again).
  var CURRENT_PATH = 'sdmc:/switch/brewser/configs/current.json';

  // Single-fetch network deadline. Mirrors updates-modal.js: on hardware
  // abort() does not reliably interrupt a stuck connect, so the timer is the
  // real guarantee. A tiny file over one CDN hop settles well within this.
  var FETCH_TIMEOUT_MS = 12000;
  // How long to wait for the boot network probe to conclude before deciding.
  // The probe (browser-shell.ts) starts at boot and resolves fast when online;
  // an offline verdict can take up to ~15 s (HTTPS + HTTP + romfs, 5 s each),
  // so we wait a bounded window and, if still inconclusive, attempt the fetch
  // anyway (the fetch's own timeout is the backstop).
  var PROBE_WAIT_MS = 8000;
  var PROBE_POLL_MS = 400;
  // How long the toast stays before auto-hiding, per spec.
  var TOAST_MS = 8000;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // fetch() raced against an independent deadline (same shape as
  // updates-modal.js's fetchWithTimeout). Rejects with a timeout Error when the
  // deadline wins; the caller's try/catch treats it like any network failure.
  function fetchWithTimeout(url) {
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('Request timed out after ' + FETCH_TIMEOUT_MS + 'ms: ' + url));
      }, FETCH_TIMEOUT_MS);
    });
    return Promise.race([globalThis.fetch(url), timeout]).finally(function () {
      if (timer !== null) clearTimeout(timer);
    });
  }

  // Real internet reachability from the engine's cached probe. `overallReachable`
  // is NOT usable here: the probe's final fallback is a `romfs:/main.js` read
  // that always succeeds, so `overallReachable` is true even offline. Mirror
  // `readInternetReachable` in browser-shell.ts instead — only an http(s)
  // attempt that came back reachable counts.
  //   true  → at least one http(s) probe reached the internet
  //   false → http(s) probes ran and all failed (offline / TLS blocked)
  //   null  → no probe has landed yet (race with boot)
  function httpReachable() {
    var probe = globalThis.__browserNetworkStatus;
    if (!probe || !Array.isArray(probe.attempts)) return null;
    var sawHttp = false;
    for (var i = 0; i < probe.attempts.length; i++) {
      var a = probe.attempts[i];
      if (!a || typeof a.url !== 'string') continue;
      if (/^https?:\/\//i.test(a.url)) {
        sawHttp = true;
        if (a.reachable) return true;
      }
    }
    return sawHttp ? false : null;
  }

  // Wait (bounded) for the probe to give a definitive verdict.
  //   true  → online, go
  //   false → definitively offline, skip
  //   null  → still inconclusive after PROBE_WAIT_MS → let the fetch decide
  async function waitForNetwork() {
    var waited = 0;
    for (;;) {
      var r = httpReachable();
      if (r === true || r === false) return r;
      if (waited >= PROBE_WAIT_MS) return null;
      await sleep(PROBE_POLL_MS);
      waited += PROBE_POLL_MS;
    }
  }

  // Dotted-numeric "is a strictly greater than b" — a plain-JS mirror of
  // `semverGreater` in updates-modal.js (which itself mirrors semverCmp in
  // src/update/decide.ts; page scripts can't import the bundle). Pre-release
  // (`-beta`) / build (`+meta`) suffixes are stripped — release NRO versions
  // are clean x.y.z. Any unparseable segment fails closed to false (no toast)
  // rather than risking a false "new version".
  function semverGreater(a, b) {
    var core = function (s) { return String(s).split('+')[0].split('-')[0]; };
    var pa = core(a).split('.');
    var pb = core(b).split('.');
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = parseInt(pa[i] != null ? pa[i] : '0', 10);
      var y = parseInt(pb[i] != null ? pb[i] : '0', 10);
      if (isNaN(x) || isNaN(y)) return false;
      if (x !== y) return x > y;
    }
    return false;
  }

  // Installed `brewser` version from the on-disk baseline. Switch.readFileSync
  // returns null (not throw) on a missing file; a missing/corrupt baseline
  // means we have nothing to compare against → return '' so the caller skips
  // (better than asserting an upgrade we can't verify).
  function readInstalledBrewserVersion() {
    var data = null;
    try { data = Switch.readFileSync(CURRENT_PATH); }
    catch (_) { data = null; }
    if (!data) return '';
    try {
      var parsed = JSON.parse(new TextDecoder().decode(data));
      return (parsed && typeof parsed.brewser === 'string') ? parsed.brewser : '';
    } catch (_) { return ''; }
  }

  // --- Toast ---------------------------------------------------------------
  var toastTimer = null;
  function els() {
    return {
      toast: document.getElementById('boot-update-toast'),
      text: document.getElementById('boot-update-toast-text'),
    };
  }

  // Force a full host-page offscreen rebuild after a class flip. A classList
  // change on a HOST-PAGE element (unlike a <browser-modal> layer element)
  // clears the cascade cache but leaves the baked offscreen as-is for
  // currently-visible content, so the show/hide wouldn't actually paint until
  // the next layout-shifting input. updates-modal.js hit + documents this exact
  // trap and fixes it the same way. Cosmetic-only (no re-navigation).
  function repaint() {
    if (typeof globalThis.__swbRepaint === 'function') {
      try { globalThis.__swbRepaint(); }
      catch (err) { console.debug('[boot-update-check] __swbRepaint failed: ' + (err && err.message ? err.message : String(err))); }
    }
  }

  function hideToast() {
    if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
    var toast = els().toast;
    if (!toast) return;
    toast.classList.remove('boot-update-toast--show');
    repaint();
  }

  function showToast(version) {
    var e = els();
    if (!e.toast || !e.text) {
      console.debug('[boot-update-check] toast markup missing; skipping toast');
      return;
    }
    // Fresh text stamp (cache-safe new node) then class-reveal + forced
    // offscreen rebuild so the pill actually paints this frame.
    e.text.textContent = 'There is a new version available v' + version;
    e.toast.classList.add('boot-update-toast--show');
    repaint();
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      hideToast();
    }, TOAST_MS);
  }

  // Wire the tap → same action as the "Check for Updates" button. Done once at
  // load (the element is static in home.html); the handler is inert until the
  // toast is actually shown. stopPropagation so the tap doesn't also fall
  // through to the grid behind the pill.
  (function wireToastClick() {
    var toast = els().toast;
    if (!toast) return;
    toast.addEventListener('click', function (e) {
      hideToast();
      if (typeof globalThis.__brewserOpenUpdatesModal === 'function') {
        globalThis.__brewserOpenUpdatesModal();
      }
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
    });
  })();

  // --- Check ---------------------------------------------------------------
  async function run() {
    // Gate on real internet. Definitively offline → skip entirely (no wasted
    // fetch, no toast). Online or inconclusive → proceed (the fetch's timeout
    // is the backstop for the inconclusive case).
    var net;
    try { net = await waitForNetwork(); }
    catch (_) { net = null; }
    if (net === false) {
      console.debug('[boot-update-check] offline; skipping version poll');
      return;
    }

    var installed = readInstalledBrewserVersion();
    if (!installed) {
      console.debug('[boot-update-check] no installed baseline; skipping');
      return;
    }

    var text;
    try {
      var resp = await fetchWithTimeout(BOOT_VERSION_URL);
      if (!resp || !resp.ok) {
        console.debug('[boot-update-check] version HTTP ' + (resp ? resp.status : '(no response)'));
        return;
      }
      text = await resp.text();
    } catch (err) {
      console.debug('[boot-update-check] version fetch failed: ' + (err && err.message ? err.message : String(err)));
      return;
    }

    var latest;
    try {
      var parsed = JSON.parse(text);
      latest = (parsed && typeof parsed.brewser === 'string') ? parsed.brewser : '';
    } catch (err) {
      console.debug('[boot-update-check] version JSON invalid: ' + (err && err.message ? err.message : String(err)));
      return;
    }
    if (!latest) {
      console.debug('[boot-update-check] published brewser version missing');
      return;
    }

    if (semverGreater(latest, installed)) {
      console.debug('[boot-update-check] newer Brewser: installed=' + installed + ' latest=' + latest);
      showToast(latest);
    } else {
      console.debug('[boot-update-check] up to date (installed=' + installed + ' latest=' + latest + ')');
    }
  }

  // Kick off without blocking boot. Everything inside is async + best-effort;
  // nothing here can throw into the page.
  Promise.resolve().then(run).catch(function (err) {
    console.debug('[boot-update-check] run error: ' + (err && err.message ? err.message : String(err)));
  });

  console.debug('[boot-update-check] wired');
})();
