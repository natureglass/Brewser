// Check-for-Updates modal — wired to the `.apps-check-updates` button
// on apps.html. Opens a centered modal that shows a pulsing loading
// bar while a real http(s) fetch of the configured catalog URL is in
// flight, then either:
//   - Success: rewrites `sdmc:/switch/brewser/catalogue.json` with the
//     fetched bytes, then produces the modal's two lists from TWO
//     DISTINCT diffs:
//       * "New apps"  = the store DELTA — listings whose id is in the
//         freshly-downloaded catalogue but was NOT in the copy that was
//         on disk a moment ago (captured in memory before the overwrite).
//         This is "what's new in the store since your last check", NOT
//         "every app you haven't installed" — the latter never changes
//         between checks and was the source of the stale "always new"
//         list. See `diffNewInCatalogue`.
//       * "Updates"   = the installed-trailing set — apps whose on-disk
//         `manifest.json` version now lags the catalogue's. The
//         actionable "an update is available for something you own" list.
//         See `diffCatalog` (its installed-state walk ALSO drives logo
//         seeding + the in-place upgrade-chip repaint, so it stays).
//     While the modal is OPEN the page is not reloaded — the user sees the
//     diff right there, and in-place patches (banner sync, upgrade chips)
//     keep the visible cards consistent (no full repaint mid-modal). But if
//     the sync actually CHANGED the render inputs — catalogue.json (Featured
//     membership, new/removed apps, version bumps) and/or stats.json (the
//     download/rating counters the Popular / Top Rated tabs rank on) — a
//     one-shot reload fires ON CLOSE so those data-driven library tabs
//     re-render from the fresh files (a pure counter change adds no New/Update
//     row, so it would otherwise stay stale until a manual reload). A no-op
//     "Everything is up to date" check never reloads. Same mechanism the
//     per-user My Apps refresh already uses.
//   - Failure: flips the card into the `--error` state and surfaces a
//     human-readable error string so the user knows the catalog was
//     NOT updated.
//
// The catalog URL is read from `data-catalogue-url` on the trigger
// button — populated server-side by the `<browser-config-catalogue>`
// custom tag from `config.json` -> `catalogue`. Empty / missing
// URL = treated as a failure (the fetch isn't attempted).
//
// Diff source of truth: the fetched text is handed to the PLATFORM
// CLIENT (`globalThis.__brewserPlatformClient.parseCatalogue`) — this
// script never parses raw catalogue fields or builds a platform URL.
// Only an Ok outcome is persisted (D2b: a catalogue that fails to
// parse/validate, or is newer than this runtime understands, never
// replaces the cached copy). The diff then walks the NORMALIZED apps
// against the flat on-disk layout (`apps/<id>/…`), mirroring the
// engine-side library join that drives the grid-card upgrade chips.
//
// Visibility flips via classList — `.app-modal-overlay--open` on the
// overlay (reused from the missing-app modal's stylesheet) and
// `.updates-modal-card--loading` / `.updates-modal-card--error` on
// the card. Inline `style.display` writes are deliberately avoided:
// they don't invalidate the live-DOM paint cache, leaving stale
// modal pixels on screen across opens (the "two modals stacked"
// bug the missing-app modal hit). See `missing-app-modal.js` for
// the full reasoning.

(function () {
  // Look ups via `document.getElementById` only — LiveElement doesn't
  // implement `querySelector` (only the document shim does), so
  // `overlay.querySelector('.updates-modal-card')` would return undefined
  // and the gate check below would bail silently. Every node we need
  // therefore carries an explicit `id=` in apps.html. The trigger
  // button is looked up via `document.querySelector('.apps-check-updates')`
  // which routes through the document shim's class-selector branch.
  var overlay = document.getElementById('updates-modal-overlay');
  var card = document.getElementById('updates-modal-card');
  var resultsEl = document.getElementById('updates-modal-results');
  var updatesCountEl = document.getElementById('updates-modal-updates-count');
  var newCountEl = document.getElementById('updates-modal-new-count');
  var brewserCallout = document.getElementById('updates-modal-brewser');
  var brewserBtn = document.getElementById('updates-modal-brewser-btn');
  // Release-notes line under the Update button. Filled from the published
  // versions.json `notes` field; hidden when the release shipped none.
  var brewserNotesEl = document.getElementById('updates-modal-brewser-notes');
  var statusEl = document.getElementById('updates-modal-status');
  var errorEl = document.getElementById('updates-modal-error');
  // Two action buttons share the right slot — CSS gates which one is
  // visible based on `--loading` on the card. Both fire the same
  // `close()` action; the split exists purely so the visual cue
  // matches the modal phase (Cancel = "I'm still busy, abort"; Close
  // = "I'm done, dismiss").
  var cancelBtn = document.getElementById('updates-modal-cancel');
  var closeBtn = document.getElementById('updates-modal-close');
  var triggerBtn = document.querySelector('.apps-check-updates');
  if (!overlay || !card || !resultsEl || !updatesCountEl || !newCountEl || !brewserCallout || !brewserBtn || !statusEl || !errorEl || !cancelBtn || !closeBtn || !triggerBtn) {
    console.debug('[updates-modal] init aborted; missing node(s): '
      + ' overlay=' + !!overlay + ' card=' + !!card + ' results=' + !!resultsEl
      + ' updatesCount=' + !!updatesCountEl + ' newCount=' + !!newCountEl
      + ' brewserCallout=' + !!brewserCallout + ' brewserBtn=' + !!brewserBtn
      + ' statusEl=' + !!statusEl + ' errorEl=' + !!errorEl
      + ' cancelBtn=' + !!cancelBtn + ' closeBtn=' + !!closeBtn
      + ' triggerBtn=' + !!triggerBtn);
    return;
  }
  console.debug('[updates-modal] wired');

  // Offline Mode: the entire Check-for-Updates flow is network-bound, so
  // disable the trigger button. This IIFE re-runs on every home navigation
  // (no once-guard), so returning from Settings after a toggle reflects the
  // new state without a reboot. `open()` is also guarded below as a backstop.
  if (globalThis.__brewserOfflineMode === true) {
    triggerBtn.setAttribute('disabled', '');
  }

  // Where the fetched bytes are written. Matches the on-disk path
  // `loadCatalogGroup` reads via
  // `Switch.readFileSync(`${appRoot}configs/catalogue.json`)`
  // — `appRoot` is `sdmc:/switch/brewser/` on real hardware (see
  // `BREWSER_APP_ROOT` in src/browser-config.ts). The `configs/`
  // segment came from the 2026-06-14 consolidation of every JSON
  // config file under one folder.
  var APP_ROOT = 'sdmc:/switch/brewser/';
  var CATALOG_PATH = APP_ROOT + 'configs/catalogue.json';
  // Sibling telemetry files refreshed alongside the catalogue. The
  // URLs come from `data-downloads-url` / `data-ratings-url` on the
  // trigger button (populated from `config.json` `downloads`
  // / `ratings` via `<browser-config-downloads>` /
  // `<browser-config-ratings>`). Empty URL → the refresh is skipped
  // and the on-disk file is left untouched.
  var DOWNLOADS_PATH = APP_ROOT + 'configs/downloads.json';
  var RATINGS_PATH = APP_ROOT + 'configs/ratings.json';
  // Newly-released runtime/shell/nx.js versions are downloaded into
  // `versions.json` and compared against `current.json` (the immutable
  // "I shipped with these versions" snapshot seeded from
  // `romfs/configs/current.json`). Only a component whose published
  // version is STRICTLY NEWER by semver than the installed one appends a
  // "New Brewser version available" line to the modal summary AND turns
  // the Check-for-Updates button green — a merely-different (e.g. older
  // published) version is not an update. `current.json` is NEVER overwritten by this flow —
  // overwriting it would make the next check always read equal and
  // never surface an upgrade. `versions.json` is downloaded on every
  // Check-for-Updates press, so a stale copy can't hide a new release.
  // `versions.json` also carries a non-version `notes` key (the release-notes
  // blurb stamped by scripts/collect_current.py). It is METADATA, never a
  // component version, so the semver diff below skips it explicitly — see
  // NON_VERSION_KEYS.
  var VERSIONS_PATH = APP_ROOT + 'configs/versions.json';
  var CURRENT_PATH = APP_ROOT + 'configs/current.json';
  // Keys present in versions.json / current.json that are NOT component
  // versions and must never take part in the semver diff. Currently just the
  // release-notes blurb; kept as a list so a future metadata key is one entry,
  // not another special case scattered through the compare loop.
  var NON_VERSION_KEYS = ['notes'];
  // Banner (`appbanner.*`, the catalogue `logo`) sync cache. One record per
  // app id: `{rel, version, size, etag}` for the banner bytes currently on
  // disk. This is what makes the Check-for-Updates banner pass CHEAP:
  //   * Tier 0 (no network) — a banner whose recorded `version` still matches
  //     the catalogue AND whose on-disk `size` still matches the record is
  //     already correct, so it is skipped outright. In the steady state this
  //     takes the whole pass to ZERO requests.
  //   * Tier 1 (one conditional round-trip) — anything that fails Tier 0 is
  //     re-fetched with `If-None-Match: <etag>`, so an unchanged banner costs
  //     a 304 with no payload and no write.
  // Before this cache the pass re-downloaded every not-installed app's banner
  // on EVERY press (the `missing` bucket was keyed on the ENTRY file, so an
  // app the user never installs stayed in it forever), which scaled linearly
  // with the catalogue and serialized one TLS handshake per app.
  var BANNER_CACHE_PATH = APP_ROOT + 'configs/banner-cache.json';
  // Bounded concurrency for the banner pass. nx.js `fetch` opens a NEW socket
  // per request and sends `connection: close` for a bodyless GET (see
  // fetchHttp in packages/runtime/src/fetch/fetch.ts) — there is no connection
  // pool, so every banner costs a full TCP+TLS handshake. Latency, not
  // bandwidth, is the cost driver; overlapping a few requests hides it. Kept
  // deliberately small: the Switch's TLS stack is software crypto, and a wide
  // fan-out starves the catalogue/telemetry fetches running alongside it.
  var BANNER_CONCURRENCY = 4;
  // Hard ceiling on banner fetches per check. A first run against a large
  // catalogue would otherwise try to pull every banner at once; the cap bounds
  // the worst case and the remainder is picked up by the next press (each run
  // skips whatever the last one already cached, so successive presses make
  // strict progress rather than redoing work).
  var BANNER_FETCH_CAP = 24;
  // C2 operational counters (downloads/ratingAvg/ratingCount), fetched
  // alongside the catalogue from `data-stats-url`. Persisted only when
  // the platform client parses it; a bad/missing stats.json is NOT a
  // sync failure (Popular / Top Rated degrade visibly instead).
  var STATS_PATH = APP_ROOT + 'configs/stats.json';
  // Per-user "My Apps" / Favorites / Achievements documents are refreshed
  // alongside the catalogue when a Brewser account is signed in. The fetch /
  // validate / write for all three now lives in the shared `user-sync.js`
  // module (`globalThis.__brewserUserSync`), so the same logic drives both this
  // Check-for-Updates flow AND the post-login auto-sync dialog. This script
  // only supplies the endpoint URLs (from `data-my-catalogue-url` /
  // `data-favorites-url` / `data-achievements-url` on the trigger button) and
  // records whether My Apps changed (for the reload-on-close).

  var modalOpen = false;
  var fetchInFlight = false;
  // AbortController for the in-flight `runCheck` (null when idle). `close()`
  // aborts it on Cancel so the orphaned run stops touching the page; its
  // `signal` is threaded into every fetch + the banner pass so an aborted
  // run releases its sockets (best-effort) and bails before mutating more
  // cards. Captured per run so a later re-run can't clear an older run's lock.
  var activeAbort = null;
  // Per-request network deadline. On hardware `abort()` does NOT reliably
  // interrupt a stuck connect (see src/update/net.ts), so `fetchWithTimeout`
  // races each fetch against an INDEPENDENT timer that rejects on its own even
  // if the socket never settles — this is what stops one dead remote from
  // wedging the whole check (and, with it, the terminal cache repaint) forever.
  // 20s matches CONNECT_TIMEOUT_MS / MANIFEST_TIMEOUT_MS in update/config.ts.
  var FETCH_TIMEOUT_MS = 20000;
  // fetch() raced against an independent deadline. `signal` (optional) is wired
  // to the underlying request for best-effort cancellation; the timer is the
  // real guarantee. Rejects with a timeout Error when the deadline wins — the
  // caller's existing try/catch treats it like any other network failure.
  //
  // `init` (optional) merges extra RequestInit fields — currently only the
  // banner pass uses it, to send `if-none-match` for a conditional GET. It is
  // spread FIRST so `signal` always wins: a caller can add headers but can
  // never accidentally detach the abort wiring.
  function fetchWithTimeout(url, signal, init) {
    var timer = null;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('Request timed out after ' + FETCH_TIMEOUT_MS + 'ms: ' + url));
      }, FETCH_TIMEOUT_MS);
    });
    var opts = null;
    if (init) {
      opts = {};
      for (var k in init) {
        if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k];
      }
    }
    if (signal) {
      if (!opts) opts = {};
      opts.signal = signal;
    }
    var fetchP = globalThis.fetch(url, opts || undefined);
    return Promise.race([fetchP, timeout]).finally(function () {
      if (timer !== null) clearTimeout(timer);
    });
  }
  // Set true when the versions check found a newer Brewser than installed; gates
  // whether tapping the status line opens the self-update modal.
  var brewserUpdateOffered = false;
  // Set true when a Check-for-Updates run refreshed my-catalogue.json for a
  // signed-in user; drives a one-shot reload on close so the server-rendered
  // "My Apps" tab appears (the same effect the old button's reload had).
  var myCatalogueRefreshed = false;
  // Set true when a run changed the on-disk catalogue.json and/or stats.json.
  // Drives the SAME one-shot reload-on-close as myCatalogueRefreshed so the
  // data-driven library tabs — Featured / Most Recent / Popular / Top Rated —
  // re-render from the fresh files. A pure download/rating counter change adds
  // no "New app" / "Update" row, so without this the Popular / Top Rated order
  // stays stale until a manual reload. Left false on a no-op check, so a quiet
  // "Everything is up to date" run still never reloads.
  var libraryDataChanged = false;

  // Same inline-SVG arrow the grid cards + missing-app modal use for
  // the upgrade chip. Kept in sync verbatim so all three places paint
  // identical glyphs. live-overlay.ts paintLiveSvg handles viewBox
  // scaling per frame — one polygon per row, paint cost negligible.
  // Light fill (`#cdd9ee`) is for the modal's dark row backgrounds;
  // dark fill (`#0b1220`) matches the engine-side `UPGRADE_ARROW_SVG`
  // in src/resources/browser-resource-loader.ts and is used on the
  // grid cards (yellow `--upgrade` chip palette).
  var UPGRADE_ARROW_SVG = '<svg class="upgrade-arrow" viewBox="0 0 14 10" width="14" height="10">'
    + '<polygon points="0,4 8,4 8,1 14,5 8,9 8,6 0,6" fill="#cdd9ee"/>'
    + '</svg>';
  var UPGRADE_ARROW_SVG_CARD = '<svg class="upgrade-arrow" viewBox="0 0 14 10" width="14" height="10">'
    + '<polygon points="0,4 8,4 8,1 14,5 8,9 8,6 0,6" fill="#0b1220"/>'
    + '</svg>';

  function setLoading() {
    card.classList.add('updates-modal-card--loading');
    card.classList.remove('updates-modal-card--error');
    errorEl.innerHTML = '';
  }

  function setError(message) {
    card.classList.remove('updates-modal-card--loading');
    card.classList.add('updates-modal-card--error');
    var safe = String(message == null ? 'Unknown error' : message);
    errorEl.innerHTML = '<span>' + escapeHtml(safe) + '</span>';
    statusEl.innerHTML = 'Catalog update failed.';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripLeadingSlashes(p) {
    var i = 0;
    while (i < p.length && p[i] === '/') i++;
    return p.slice(i);
  }

  // Parent directory of a `/`-joined path, without the trailing slash.
  // Used as the `Switch.mkdirSync` argument when seeding a new app
  // folder — mkdirSync creates the full chain including intermediates.
  function parentDir(path) {
    var idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(0, idx) : '';
  }

  // On-disk size of `path`, or -1 when it doesn't exist. `Switch.statSync`
  // returns `{size, mtime, …}` or null for a missing file — it never reads the
  // bytes, so this is the CHEAP existence+size probe. The rest of this script
  // historically used `readFileSync(...) !== null` for existence, which pulls
  // the WHOLE file into memory just to answer a yes/no question (a catalogue
  // app's index.html runs to ~100KB, a banner to ~57KB). Errors read as absent
  // so a permissions/FS hiccup degrades to "fetch it" rather than throwing.
  function fileSize(path) {
    try {
      var st = Switch.statSync(path);
      return st && typeof st.size === 'number' ? st.size : -1;
    } catch (_) { return -1; }
  }

  // Cheap existence check — see fileSize. Prefer this over readFileSync for
  // any "is it there?" question.
  function fileExists(path) {
    return fileSize(path) >= 0;
  }

  // Load the banner sync cache (`configs/banner-cache.json`). Shape:
  //   { "<app id>": { rel, version, size, etag } }
  // Missing / unreadable / malformed all degrade to `{}` — an empty cache just
  // means the next pass re-validates every banner conditionally, which is
  // correct-but-slower, never wrong. Entries are validated individually so one
  // corrupt record can't discard the whole cache.
  function loadBannerCache() {
    var data = null;
    try { data = Switch.readFileSync(BANNER_CACHE_PATH); }
    catch (_) { data = null; }
    if (!data) return {};
    var parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(data)); }
    catch (err) {
      console.debug('[updates-modal] banner cache unparseable; starting empty: '
        + (err && err.message ? err.message : String(err)));
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    var out = {};
    for (var id in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, id)) continue;
      var rec = parsed[id];
      if (!rec || typeof rec !== 'object') continue;
      out[id] = {
        rel: typeof rec.rel === 'string' ? rec.rel : '',
        version: typeof rec.version === 'string' ? rec.version : '',
        size: typeof rec.size === 'number' ? rec.size : -1,
        etag: typeof rec.etag === 'string' ? rec.etag : '',
      };
    }
    return out;
  }

  // Persist the banner cache. Best-effort: a write failure costs the NEXT
  // run some redundant conditional requests (it re-validates instead of
  // skipping), which is a performance regression, never a correctness one —
  // so it is logged and swallowed rather than surfaced as a check failure.
  function saveBannerCache(cache) {
    try {
      Switch.writeFileSync(BANNER_CACHE_PATH, JSON.stringify(cache));
    } catch (err) {
      console.debug('[updates-modal] banner cache write failed: '
        + (err && err.message ? err.message : String(err)));
    }
  }

  // Recursive descendant-by-class lookup. LiveElement doesn't ship a
  // `querySelector` (only the document shim does) and the cards' meta
  // strip is nested two levels deep (`<a> > <div.app-card__meta> >
  // <div.app-meta__version>`), so the in-place card refresh helpers
  // below need to walk children manually. Returns the first match in
  // document order; null when nothing matches.
  function findDescendantByClass(el, className) {
    if (!el || !el.children) return null;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.classList && typeof c.classList.contains === 'function'
        && c.classList.contains(className)) return c;
      var deep = findDescendantByClass(c, className);
      if (deep) return deep;
    }
    return null;
  }

  // Rewrite the `<img>` src of every card whose banner was just downloaded,
  // in ONE pass over the grid.
  //
  // The previous shape took a single app and walked the whole card list per
  // call, from inside the download loop — O(banners x cards) `getAttribute` +
  // `JSON.parse` on top of the network work, and a live-tree mutation between
  // every fetch (which re-dirties the tree mid-check and costs the overlay its
  // cheap cache-blit scroll path). Batching means one walk, one parse per
  // card, and all the mutations land together.
  //
  // Each card's src moves to the `brewser://apps/<id>/<logo>` local URL and
  // the `logo` field inside `data-app-detail` is updated too, so the
  // missing-app modal (which reads that JSON at open time for its header
  // image) picks up the real art as well. The card stays flagged `missing`
  // when the entry file is still absent — only the visuals change.
  //
  // Returns the number of cards actually repainted; 0 is normal (home.html's
  // featured grid doesn't share the Apps cards, and an off-page card isn't in
  // the DOM at all).
  function refreshCardLogos(items) {
    if (!items || items.length === 0) return 0;
    // id -> brewser:// URL for this batch. Built first so the card walk is a
    // single hash lookup per card instead of a scan of the batch.
    var wanted = {};
    var pending = 0;
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      var logoRel = it.logo ? stripLeadingSlashes(it.logo) : '';
      if (!logoRel) continue;
      wanted[it.id] = 'brewser://apps/' + it.id + '/' + logoRel;
      pending++;
    }
    if (pending === 0) return 0;
    var painted = 0;
    var cards = document.querySelectorAll('[data-app-detail]');
    for (var i = 0; i < cards.length && pending > 0; i++) {
      var cardEl = cards[i];
      var raw = cardEl.getAttribute('data-app-detail');
      if (!raw) continue;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (_) { continue; }
      if (!parsed || !parsed.id) continue;
      if (!Object.prototype.hasOwnProperty.call(wanted, parsed.id)) continue;
      var brewserUrl = wanted[parsed.id];
      // Each id appears once in the grid; drop it so a duplicate card can't
      // double-count and so `pending` can end the walk early.
      delete wanted[parsed.id];
      pending--;
      // First IMG child = the banner element (only `<img>` in the card
      // markup; no need to filter by class). setAttribute routes through
      // LiveElement.setAttr which kicks off loadImage(value) — the new bytes
      // load async and the live tree dirties so the next paint shows them.
      for (var c = 0; c < cardEl.children.length; c++) {
        var child = cardEl.children[c];
        if (child.tagName === 'IMG') {
          child.setAttribute('src', brewserUrl);
          break;
        }
      }
      parsed.logo = brewserUrl;
      cardEl.setAttribute('data-app-detail', JSON.stringify(parsed));
      painted++;
    }
    return painted;
  }

  // In-place card refresh for an installed app whose on-disk manifest
  // version differs from the new catalog's version. Adds the
  // `app-card--upgrade` class (paints the card with the lighter blue
  // background) + replaces the meta strip's version chip with the
  // `vOld [→] vNew` two-span layout — same markup the engine emits
  // server-side in `renderAppCards` (browser-resource-loader.ts). The
  // arrow uses the dark `#0b1220` fill matching the yellow chip's
  // text color; modal rows use the lighter fill via UPGRADE_ARROW_SVG.
  //
  // Also patches `data-app-detail` so the missing-app modal (and any
  // other consumer that re-reads the JSON) sees the fresh version
  // pair. If the card's meta strip doesn't carry a `.app-meta__version`
  // element (catalog entry had no version pre-refresh), the chip
  // injection is skipped — the class flip alone is harmless and the
  // next page nav re-renders from the new catalog with the full chip.
  function refreshCardUpgrade(detail) {
    var cards = document.querySelectorAll('[data-app-detail]');
    for (var i = 0; i < cards.length; i++) {
      var cardEl = cards[i];
      var raw = cardEl.getAttribute('data-app-detail');
      if (!raw) continue;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (_) { continue; }
      if (!parsed || parsed.id !== detail.id) continue;
      cardEl.classList.add('app-card--upgrade');
      var versionEl = findDescendantByClass(cardEl, 'app-meta__version');
      var chipHtml = '<span>v' + escapeHtml(detail.installedVersion) + '</span>'
        + UPGRADE_ARROW_SVG_CARD
        + '<span>v' + escapeHtml(detail.version) + '</span>';
      if (versionEl) {
        versionEl.classList.add('app-meta__version--upgrade');
        versionEl.innerHTML = chipHtml;
      }
      parsed.version = detail.version;
      parsed.installedVersion = detail.installedVersion;
      cardEl.setAttribute('data-app-detail', JSON.stringify(parsed));
      return;
    }
  }

  // Apply `refreshCardUpgrade` to every entry in the updates bucket.
  // Synchronous; no I/O — purely walks the live tree.
  function refreshUpgradeChips(updates) {
    if (!updates || updates.length === 0) return;
    for (var i = 0; i < updates.length; i++) {
      try { refreshCardUpgrade(updates[i]); }
      catch (err) { console.debug('[updates-modal] refreshCardUpgrade failed: ' + (err && err.message ? err.message : String(err))); }
    }
  }

  // Banner (`appbanner.*`) sync for the Check-for-Updates pass. Takes the
  // CANDIDATE list from diffCatalog plus the persisted cache, and does the
  // least work that can still be correct. Three tiers:
  //
  //   Tier 0 — no network. diffCatalog already dropped every app whose banner
  //     is on disk at the cached size AND cached at the current catalogue
  //     version, so the steady state (nothing changed since the last press)
  //     arrives here with an EMPTY candidate list and issues zero requests.
  //     This is the whole point of the rewrite: the old pass re-downloaded
  //     every not-installed app's banner on every press, serially.
  //
  //   Tier 1 — one conditional round-trip. A candidate that still has a usable
  //     ETag (file present, same size, same rel) is re-fetched with
  //     `If-None-Match`. This is the version-bumped case: the app moved but
  //     its art usually did NOT, so the server answers 304 with no payload and
  //     no write, and we re-stamp the record at the new catalogue version so
  //     the NEXT press skips it at Tier 0 entirely.
  //
  //   Tier 2 — full GET. Only for a banner that is genuinely absent, size-
  //     mismatched, or has no stored ETag.
  //
  // KNOWN LIMIT (deliberate): a banner re-uploaded with NO version bump AND
  // the same byte size is not detected here — Tier 0 skips it without asking.
  // Detecting it would mean a conditional request per app per press, which is
  // exactly the per-press cost this pass exists to remove. The case is already
  // covered where it matters: download-modal.js cache-busts `appbanner.*` on
  // every (re)download, so installing or updating the app always pulls the
  // current art. A version bump also re-validates via Tier 1. If catalogue
  // entries ever start carrying `updatedAt` (allow-listed by the normalizer
  // but not emitted by the generator today), folding it into the Tier 0 key
  // alongside `version` would close this with no extra requests.
  //
  // Requests run through a small bounded worker pool (BANNER_CONCURRENCY) and
  // are capped per run (BANNER_FETCH_CAP) — nx.js opens a fresh socket per
  // fetch with `connection: close`, so each banner costs a full TCP+TLS
  // handshake and LATENCY dominates. Overlapping a few hides it without
  // starving the catalogue/telemetry fetches running alongside.
  //
  // `cache` is mutated in place; the caller persists it once at the end. Every
  // failure is logged and swallowed — a banner miss must never fail the
  // catalogue refresh.
  //
  // Returns `{painted, downloaded}`. `downloaded > 0` means banner BYTES on
  // disk changed, which is a render input: an installed app's card already
  // points at `brewser://apps/<id>/<logo>`, so re-setting the same src won't
  // reload it and the fresh art only appears on the next render. The caller
  // folds that into `libraryDataChanged` so close() reloads once. A run that
  // downloaded nothing (the steady state, and any all-304 run) leaves it 0, so
  // a quiet check still never reloads.
  async function syncBanners(candidates, cache, signal) {
    if (!candidates || candidates.length === 0) {
      console.debug('[updates-modal] banners: nothing stale; 0 requests');
      return { painted: 0, downloaded: 0 };
    }
    // Cap the per-run work. Successive presses make strict progress: whatever
    // this run caches is skipped at Tier 0 next time, so the remainder is
    // picked up rather than redone.
    var queue = candidates.length > BANNER_FETCH_CAP
      ? candidates.slice(0, BANNER_FETCH_CAP)
      : candidates;
    if (queue.length < candidates.length) {
      console.debug('[updates-modal] banners: ' + candidates.length + ' stale, capped to '
        + queue.length + ' this run (rest follow on the next check)');
    }
    // Cards to repaint. Collected here and applied in ONE pass after the
    // network work: the old per-app refreshCardLogo walked the whole card list,
    // so calling it per banner inside the loop was O(banners x cards) DOM work
    // on top of the fetches — and each in-loop mutation re-dirtied the live
    // tree mid-check.
    var repaints = [];
    var next = 0;
    var fetched = 0;
    var notModified = 0;
    var failed = 0;

    async function worker() {
      while (true) {
        if (signal && signal.aborted) return;
        var i = next++;
        if (i >= queue.length) return;
        var item = queue[i];
        try {
          var dir = parentDir(item.path);
          if (dir) Switch.mkdirSync(dir);
        } catch (err) {
          failed++;
          console.debug('[updates-modal] banner mkdir failed for ' + item.id + ': '
            + (err && err.message ? err.message : String(err)));
          continue;
        }
        var resp;
        try {
          // Tier 1 vs Tier 2: send the conditional header only when we have an
          // ETag that still describes the bytes on disk.
          var init = item.etag ? { headers: { 'if-none-match': item.etag } } : null;
          resp = await fetchWithTimeout(item.logoUrl, signal, init);
        } catch (err) {
          failed++;
          console.debug('[updates-modal] banner fetch failed for ' + item.logoUrl + ': '
            + (err && err.message ? err.message : String(err)));
          continue;
        }
        // 304 — bytes on disk are already current. No body, no write. Re-stamp
        // the record at the CURRENT catalogue version so the next press skips
        // this app at Tier 0 instead of re-asking.
        if (resp.status === 304) {
          notModified++;
          cache[item.id] = {
            rel: item.logo,
            version: item.version,
            size: item.onDiskSize >= 0 ? item.onDiskSize : fileSize(item.path),
            etag: item.etag,
          };
          continue;
        }
        if (!resp.ok) {
          failed++;
          console.debug('[updates-modal] banner HTTP ' + resp.status + ' for ' + item.logoUrl);
          continue;
        }
        var buf;
        try {
          buf = await resp.arrayBuffer();
          Switch.writeFileSync(item.path, buf);
        } catch (err) {
          failed++;
          console.debug('[updates-modal] banner write failed for ' + item.id + ': '
            + (err && err.message ? err.message : String(err)));
          continue;
        }
        fetched++;
        // Record what we just wrote. `size` comes from the buffer we actually
        // persisted (not a re-stat) so the record matches the write exactly;
        // a missing/absent ETag stores '' and simply costs an unconditional
        // GET next time the version moves.
        var etag = '';
        try { etag = resp.headers && resp.headers.get ? (resp.headers.get('etag') || '') : ''; }
        catch (_) { etag = ''; }
        cache[item.id] = {
          rel: item.logo,
          version: item.version,
          size: buf && typeof buf.byteLength === 'number' ? buf.byteLength : fileSize(item.path),
          etag: etag,
        };
        if (item.repaint) repaints.push(item);
      }
    }

    var pool = [];
    var width = Math.min(BANNER_CONCURRENCY, queue.length);
    for (var w = 0; w < width; w++) pool.push(worker());
    await Promise.all(pool);

    // Cancelled mid-pass: skip the DOM work entirely. close() already reset
    // the overlay; re-dirtying the live tree here would restart the
    // scroll-rebuild flashing that cancelling exists to stop.
    if (signal && signal.aborted) return { painted: 0, downloaded: fetched };

    var painted = 0;
    if (repaints.length > 0) {
      try { painted = refreshCardLogos(repaints); }
      catch (err) {
        console.debug('[updates-modal] banner repaint failed: '
          + (err && err.message ? err.message : String(err)));
      }
    }
    console.debug('[updates-modal] banners: ' + queue.length + ' checked, '
      + fetched + ' downloaded, ' + notModified + ' unchanged (304), '
      + failed + ' failed, ' + painted + ' cards repainted');
    return { painted: painted, downloaded: fetched };
  }

  // Best-effort refresh of a sibling JSON config (downloads / ratings)
  // from a remote URL. Validates the response body as JSON before the
  // write so a stray HTML 200 (e.g. captive portal) can't replace a
  // good file with garbage. Every failure path is logged + swallowed —
  // a downloads.json HTTP 500 should NOT block a successful catalog
  // refresh. Empty URL is treated as "skip silently".
  async function refreshConfigFile(remoteUrl, localPath, label, signal) {
    if (!remoteUrl) {
      console.debug('[updates-modal] ' + label + ' URL not configured; skipping refresh');
      return;
    }
    try {
      var resp = await fetchWithTimeout(remoteUrl, signal);
      if (!resp.ok) {
        console.debug('[updates-modal] ' + label + ' HTTP ' + resp.status + ' for ' + remoteUrl);
        return;
      }
      var text = await resp.text();
      try { JSON.parse(text); }
      catch (e) {
        console.debug('[updates-modal] ' + label + ' is not valid JSON; refusing write: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      Switch.writeFileSync(localPath, text);
      console.debug('[updates-modal] ' + label + ' refreshed (' + text.length + ' bytes)');
    } catch (err) {
      console.debug('[updates-modal] ' + label + ' refresh failed: ' + (err && err.message ? err.message : String(err)));
    }
  }

  // Fetch stats.json (C2 counters) and persist it ONLY when the
  // platform client parses it. Missing/corrupt/HTTP-error stats are
  // logged and skipped — deliberately NOT a sync failure: Featured and
  // Most Recent keep working, and the Popular / Top Rated tabs render
  // themselves unavailable with a reason instead.
  // Returns true when the freshly-fetched stats DIFFER from the cached copy
  // (so the caller can reload on close to re-rank Popular / Top Rated); false
  // on any skip/failure or when the content is byte-identical. The server's
  // publisher skips-when-unchanged (ignoring `generated`), so an unchanged
  // check re-serves the identical file → identical text → no reload.
  async function refreshStatsFile(client, remoteUrl, signal) {
    if (!remoteUrl) {
      console.debug('[updates-modal] stats URL not configured; skipping refresh');
      return false;
    }
    try {
      var resp = await fetchWithTimeout(remoteUrl, signal);
      if (!resp.ok) {
        console.debug('[updates-modal] stats.json HTTP ' + resp.status + ' — keeping cached stats');
        return false;
      }
      var text = await resp.text();
      var outcome = client.parseStats(text);
      if (outcome.kind !== 'Ok') {
        console.debug('[updates-modal] stats.json rejected (' + outcome.kind + '); keeping cached stats');
        return false;
      }
      // Compare against the cached copy BEFORE overwriting so a pure counter
      // change (which adds no New/Update row) can still trigger the re-render.
      var changed = true;
      try {
        var prev = Switch.readFileSync(STATS_PATH);
        if (prev && prev.byteLength > 0) {
          changed = (new TextDecoder().decode(prev) !== text);
        }
      } catch (_) { /* no cached stats yet → treat as changed */ }
      Switch.writeFileSync(STATS_PATH, text);
      console.debug('[updates-modal] stats.json refreshed (' + Object.keys(outcome.parsed.stats).length
        + ' apps' + (changed ? ', changed' : ', unchanged') + ')');
      return changed;
    } catch (err) {
      console.debug('[updates-modal] stats refresh failed: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
  }

  // Render the platform client's parse report into the modal — the
  // drift-visibility payload of the whole architecture. Always shows
  // version + app count; itemizes unknown fields/permissions/sources/
  // entities only when present, so a clean sync reads as one quiet line.
  //
  // DROPPED entries are deliberately NOT surfaced in the modal: an app the
  // catalogue lists but this platform can't run (e.g. a non-switch-compatible
  // entry) is an EXPECTED, routine filter, not drift the user needs to see.
  // It's logged to the console for diagnostics only — the modal stays silent
  // about it (per the "dropped apps happen silently" requirement).
  function renderParseReport(catalogue) {
    var el = document.getElementById('updates-modal-report');
    if (!el || !catalogue || !catalogue.report) return;
    var r = catalogue.report;
    var html = 'Catalogue v' + escapeHtml(String(r.version))
      + ' — ' + escapeHtml(String(r.appCount)) + ' apps';
    var details = [];
    if (r.dropped && r.dropped.length) {
      // Diagnostics only — not shown in the modal.
      var droppedLog = [];
      for (var i = 0; i < r.dropped.length; i++) {
        var d = r.dropped[i];
        droppedLog.push((d.id || ('#' + d.index)) + ': ' + d.reason);
      }
      console.debug('[updates-modal] dropped ' + r.dropped.length
        + ' catalogue entr' + (r.dropped.length === 1 ? 'y' : 'ies')
        + ' (' + droppedLog.join('; ') + ')');
    }
    if (r.unknownEntryFields && r.unknownEntryFields.length) {
      details.push('unknown fields: ' + escapeHtml(r.unknownEntryFields.join(', ')));
    }
    if (r.unknownPermissions && r.unknownPermissions.length) {
      details.push('unknown permissions: ' + escapeHtml(r.unknownPermissions.join(', ')));
    }
    if (r.unknownSources && r.unknownSources.length) {
      details.push('unknown sources: ' + escapeHtml(r.unknownSources.join(', ')));
    }
    if (r.unknownEntities && r.unknownEntities.length) {
      details.push('undecoded entities: ' + escapeHtml(r.unknownEntities.join(', ')));
    }
    if (details.length) {
      html += '<br>' + details.join('<br>');
      el.classList.add('updates-modal-report--drift');
    } else {
      el.classList.remove('updates-modal-report--drift');
    }
    el.innerHTML = html;
  }

  // Dotted-numeric semver compare — a plain-JS mirror of `semverCmp` in
  // src/update/decide.ts (this romfs page script can't import the bundle).
  // Pre-release (`-beta.5`) and build (`+…`) metadata are stripped: the
  // release NRO's brewser version is a clean `x.y.z`, and the anti-rollback
  // counter in the signed update manifest is the authoritative guard the
  // real self-update flow enforces. Returns true iff `a` is STRICTLY greater
  // than `b`; an unparseable segment fails closed to `false` (no update
  // offered) rather than risking a false positive.
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

  // Download `versions.json` from the configured URL, persist it under
  // `<appRoot>configs/versions.json`, then compare it against the seeded
  // `<appRoot>configs/current.json` baseline (the immutable "I shipped with
  // these versions" snapshot). Returns `{available:true, version:'<brewser>'}`
  // iff a tracked component's PUBLISHED version is strictly newer by semver
  // than the installed one — i.e. there is genuinely a newer build to
  // download (version = the published `brewser` value, for the button label).
  // Every skip/failure/no-update path returns falsy (`false`); the caller
  // coerces via `results[3] || {}`, so a boolean and the object both read
  // cleanly. Best-effort throughout: a versions-check miss can't cascade into
  // a catalogue refresh failure.
  // `current.json` is never written by this flow — overwriting it would
  // make every future check read equal and silently hide new releases.
  async function checkVersionsForUpdate(remoteUrl, signal) {
    if (!remoteUrl) {
      console.debug('[updates-modal] versions URL not configured; skipping check');
      return false;
    }
    var fetchedText;
    try {
      var resp = await fetchWithTimeout(remoteUrl, signal);
      if (!resp.ok) {
        console.debug('[updates-modal] versions HTTP ' + resp.status + ' for ' + remoteUrl);
        return false;
      }
      fetchedText = await resp.text();
    } catch (err) {
      console.debug('[updates-modal] versions fetch failed: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
    var fetchedParsed;
    try {
      fetchedParsed = JSON.parse(fetchedText);
      if (!fetchedParsed || typeof fetchedParsed !== 'object') {
        console.debug('[updates-modal] versions JSON is not an object; refusing write');
        return false;
      }
    } catch (err) {
      console.debug('[updates-modal] versions is not valid JSON; refusing write: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
    try {
      Switch.writeFileSync(VERSIONS_PATH, fetchedText);
      console.debug('[updates-modal] versions.json refreshed (' + fetchedText.length + ' bytes)');
    } catch (err) {
      console.debug('[updates-modal] versions write failed: ' + (err && err.message ? err.message : String(err)));
      // Comparison can still proceed against the in-memory parse even
      // if the write failed — don't bail.
    }
    // Read the immutable seeded baseline. `Switch.readFileSync` returns
    // null (not throw) on a missing file — see
    // [[reference-brewser-switch-readfilesync-returns-null]]. Missing
    // current.json on disk means we have no baseline to compare against
    // (fresh install before the seedRomfs walker copied it across, or a
    // user manually deleted it), so silently skip the "new version"
    // signal — better than asserting an upgrade we can't verify.
    var currentData = null;
    try { currentData = Switch.readFileSync(CURRENT_PATH); }
    catch (_) { currentData = null; }
    if (!currentData) {
      console.debug('[updates-modal] current.json missing on disk; skipping version diff');
      return false;
    }
    var currentParsed;
    try {
      currentParsed = JSON.parse(new TextDecoder().decode(currentData));
      if (!currentParsed || typeof currentParsed !== 'object') {
        console.debug('[updates-modal] current.json is not an object; skipping version diff');
        return false;
      }
    } catch (err) {
      console.debug('[updates-modal] current.json parse failed: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
    // Semver-GREATER decision (not string inequality). An update is offered
    // ONLY when a published component version is strictly newer than the one
    // installed — never merely different. The old string test fired in BOTH
    // directions, so a locally-built install whose brewser version already
    // LEADS the published versions.json was wrongly told "new version
    // available" every check; that direction is exactly the false positive
    // this fixes. Mirrors the semver arm of decideUpdate (the real
    // self-update flow re-checks counter + semver before downloading, so
    // this is just the cheap "worth offering?" hint and must agree).
    //
    // Only keys present on BOTH sides are compared: a key only in `fetched`
    // (a component that didn't exist when this build shipped) or only in
    // `current` (server stopped tracking it) is skipped rather than counted
    // — that asymmetry was the other historical false-positive source. The
    // brewser NRO bundles every component and its version bumps on every
    // release, so the `brewser` key alone reliably catches a real update;
    // iterating all shared keys is belt-and-braces.
    var updateAvailable = false;
    for (var key in fetchedParsed) {
      if (!Object.prototype.hasOwnProperty.call(fetchedParsed, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(currentParsed, key)) continue;
      // Skip release METADATA. `notes` is prose, not a version — feeding it to
      // semverGreater is meaningless and, for a blurb that happens to start
      // with digits ("2.0 rewrite of the decoder"), could parse into a bogus
      // comparison. Fail it out of the diff explicitly rather than relying on
      // parseInt returning NaN.
      if (NON_VERSION_KEYS.indexOf(key) !== -1) continue;
      if (semverGreater(String(fetchedParsed[key]), String(currentParsed[key]))) {
        console.debug('[updates-modal] newer version for "' + key + '": current='
          + String(currentParsed[key]) + ' published=' + String(fetchedParsed[key]));
        updateAvailable = true;
        break;
      }
    }
    if (!updateAvailable) return false;
    // Label the "Update Brewser" button with the published `brewser` version
    // (the NRO the self-update downloads). The NRO bumps `brewser` on every
    // release, so an update detected on any shared key coincides with a newer
    // `brewser`; a missing/non-string value falls back to '' → the button just
    // reads "Update Brewser".
    var brewserVer = typeof fetchedParsed.brewser === 'string' ? fetchedParsed.brewser : '';
    // Release-notes blurb for the offered build, straight from the PUBLISHED
    // versions.json (never the installed current.json — the point is to
    // describe the build being offered, not the one already on disk). Trimmed;
    // a missing / non-string / blank value yields '' and the caller hides the
    // notes line entirely rather than rendering an empty row.
    var notes = typeof fetchedParsed.notes === 'string' ? fetchedParsed.notes.trim() : '';
    return { available: true, version: brewserVer, notes: notes };
  }

  // Walk the NORMALIZED catalogue (platform-client output — this
  // script never reads raw catalogue fields) and bucket each app by its
  // INSTALLED state on disk:
  //   * updates — installed manifest `version` differs from the
  //     catalogue's. Drives BOTH the in-place upgrade-chip repaint
  //     (`refreshUpgradeChips`) and the modal's "Updates" list.
  //   * banners — apps whose on-disk `appbanner.*` may be out of date. This
  //     is the CANDIDATE set, not the fetch set; see below.
  // This is the ACTION diff (catalogue-vs-disk). It is NOT the source of
  // the "New apps" list — that comes from the store delta computed by
  // `diffNewInCatalogue` (old-vs-new catalogue). Mirrors the engine-side
  // library join so the installed-state view matches the grid after the
  // next reload.
  //
  // BANNER BUCKETING (rewritten — the old rule was both wasteful and wrong).
  // Previously the banner pass ran over `missing`, i.e. it keyed on the ENTRY
  // file. That had two defects pulling in opposite directions:
  //   * An app the user never installs stays in `missing` FOREVER, so its
  //     banner was re-downloaded in full on every single press even though the
  //     bytes on disk were already identical.
  //   * An INSTALLED app whose version just bumped was never in `missing`, so
  //     its banner was never refreshed at all — the one case where the art
  //     genuinely is likely to have changed.
  // The candidate rule is now about the BANNER, not the launcher: an app is a
  // candidate when its banner file is absent, or when the catalogue version
  // (or the on-disk size) differs from what the banner was cached at.
  // `syncBanners` then applies the cache / conditional-GET tiers on top, so a
  // candidate does not necessarily cost a request.
  function diffCatalog(normalized, bannerCache) {
    var decoder = new TextDecoder();
    var updates = [];
    var banners = [];
    var cache = bannerCache || {};
    var apps = normalized && Array.isArray(normalized.apps) ? normalized.apps : [];
    for (var ei = 0; ei < apps.length; ei++) {
      var e = apps[ei];
      var entryRel = stripLeadingSlashes(e.entryRel || 'index.html');
      var entryPath = APP_ROOT + 'apps/' + e.id + '/' + entryRel;
      // statSync, NOT readFileSync: this is a pure existence question and the
      // entry file is a full HTML document (~100KB for the bigger apps).
      // Reading every catalogue app's index.html into memory just to ask "is
      // it installed?" was a per-press cost that grew with the catalogue.
      var installed = fileExists(entryPath);
      var logoRel = stripLeadingSlashes(e.logoRel || '');
      var catVersion = e.version || '';
      // Banner candidate? Absent on disk, cached against a different catalogue
      // version, or the file changed size behind our back (manual copy, a
      // partial write from an interrupted run). Cheap: statSync only.
      if (logoRel && e.logoUrl) {
        var rec = Object.prototype.hasOwnProperty.call(cache, e.id) ? cache[e.id] : null;
        var bannerPath = APP_ROOT + 'apps/' + e.id + '/' + logoRel;
        var onDisk = fileSize(bannerPath);
        var stale = onDisk < 0
          || !rec
          || rec.rel !== logoRel
          || rec.version !== catVersion
          || rec.size !== onDisk;
        if (stale) {
          banners.push({
            id: e.id,
            name: e.name || e.id,
            version: catVersion,
            // Relative logo path + the platform-client-built remote URL
            // (`logoUrl` — source-aware, so ext-repo apps fetch from their
            // own root). The banner pass stashes the bytes under the flat
            // `apps/<id>/<logoRel>` so the engine's next render paints the
            // real art instead of the generic download.png.
            logo: logoRel,
            logoUrl: e.logoUrl,
            path: bannerPath,
            // Size already stat'd above — carried through so the 304 path can
            // re-stamp the record without a second stat of the same file.
            onDiskSize: onDisk,
            // Stored ETag for the conditional request, '' when we have no
            // usable record (absent file, changed size, different version of
            // the rel path) — those must be fetched unconditionally.
            etag: (rec && onDisk >= 0 && rec.rel === logoRel && rec.size === onDisk) ? rec.etag : '',
            // Only a not-installed app's card needs its <img src> rewritten in
            // place after a successful write — an installed app's card already
            // points at `brewser://apps/<id>/<logo>`, so the same path just
            // reloads. Recorded here so the pass doesn't re-derive it.
            repaint: !installed,
          });
        }
      }
      // Not installed — nothing further to diff. There is no separate
      // `missing` list any more: it existed only to drive the old banner pass,
      // and the banner candidate set above now covers installed and
      // not-installed apps alike. The modal reports counts (New apps /
      // Updates), never a per-app "missing" row, so nothing else read it.
      if (!installed) continue;
      // Installed — compare manifest.json's version against the
      // catalogue's. Skip when either side is empty (no signal to
      // surface) or the strings match (no upgrade available).
      if (!catVersion) continue;
      var manifestPath = APP_ROOT + 'apps/' + e.id + '/manifest.json';
      var manifestData = null;
      try { manifestData = Switch.readFileSync(manifestPath); } catch (_) { manifestData = null; }
      if (!manifestData) continue;
      var installedVersion = '';
      try {
        var manifest = JSON.parse(decoder.decode(manifestData));
        installedVersion = typeof manifest.version === 'string' ? manifest.version : '';
      } catch (_) { continue; }
      if (!installedVersion || installedVersion === catVersion) continue;
      updates.push({
        id: e.id,
        name: e.name || e.id,
        version: catVersion,
        installedVersion: installedVersion,
      });
    }
    return { updates: updates, banners: banners };
  }

  // Store DELTA for the "New apps" list — apps whose id is in the
  // freshly-downloaded catalogue but was NOT in the copy that was on disk
  // before this check. `oldIds` is a lookup map built from the previous
  // catalogue (see runCheck); it is `null` when no usable baseline could
  // be read/parsed, in which case there is no "previous one" to diff
  // against so we return [] rather than flooding the modal with every
  // listing. Each row carries just the name + version the list renders.
  function diffNewInCatalogue(oldIds, normalized) {
    if (!oldIds) return [];
    var out = [];
    var apps = normalized && Array.isArray(normalized.apps) ? normalized.apps : [];
    for (var i = 0; i < apps.length; i++) {
      var e = apps[i];
      if (Object.prototype.hasOwnProperty.call(oldIds, e.id)) continue;
      out.push({ id: e.id, name: e.name || e.id, version: e.version || '' });
    }
    return out;
  }

  // Set one summary count line: `<n> <label>` when n > 0, hidden otherwise.
  // Singular/plural chosen from n so "1 app has…" / "6 apps have…" both read.
  function setCountLine(el, n, singular, plural) {
    if (n > 0) {
      el.textContent = n + ' ' + (n === 1 ? singular : plural);
      el.classList.remove('updates-modal-count--hidden');
    } else {
      el.textContent = '';
      el.classList.add('updates-modal-count--hidden');
    }
  }

  // Collapse the two diffs to summary COUNTS — the modal no longer lists apps
  // one per row. `updates` is the installed-trailing set (apps on disk whose
  // version now lags the catalogue); `newApps` is the store DELTA (listings
  // added since the last check). Each line hides itself at zero. The Brewser
  // self-update callout + the whole-results empty state are driven by the
  // caller (runCheck), which also knows the versions-check result.
  function populate(newApps, updates) {
    setCountLine(updatesCountEl, updates.length, 'app has a new update', 'apps have a new update');
    setCountLine(newCountEl, newApps.length, 'new app available', 'new apps available');
  }

  // Fire-and-forget the actual update flow. Each failure path flips
  // the card into `--error` and surfaces a message; success leaves
  // the modal open with the diff lists populated. Nothing escapes.
  //
  // Per-user refreshes ("My Apps" / Favorites / Achievements) delegate to the
  // shared `user-sync.js` module (`globalThis.__brewserUserSync`) — the exact
  // same fetch / validate / write the post-login auto-sync dialog uses, so the
  // two callers can't drift. Each is best-effort (signed-out, missing URL, auth
  // failure, bad response, or write error just leaves the existing file
  // untouched and returns false), so they stay safe inside the runCheck
  // Promise.all. The URLs are read here from the trigger button's data-*
  // attributes (server-expanded from `<browser-config-*/>`).
  function userSync() { return globalThis.__brewserUserSync || null; }

  async function refreshMyCatalogue(signal) {
    var s = userSync();
    if (!s) return false;
    return s.syncMyCatalogue(triggerBtn.getAttribute('data-my-catalogue-url') || '', signal);
  }

  async function refreshFavorites(signal) {
    var s = userSync();
    if (!s) return false;
    return s.syncFavorites(triggerBtn.getAttribute('data-favorites-url') || '', signal);
  }

  async function refreshAchievements(signal) {
    var s = userSync();
    if (!s) return false;
    return s.syncAchievements(triggerBtn.getAttribute('data-achievements-url') || '', signal);
  }

  async function runCheck() {
    if (fetchInFlight) return;
    // Own an AbortController for this run so Cancel (`close()`) can orphan it.
    // `signal` is threaded into every fetch + the banner pass; the `finally`
    // only releases the lock when THIS run still owns it (a cancelled run's
    // lock was already cleared by close(); a superseded run must not clobber a
    // newer run's). Constructed defensively — if the runtime lacks
    // AbortController the run degrades to timeout-only (no best-effort abort),
    // but must never throw here and leave `fetchInFlight` wedged.
    var ac = null;
    try { ac = new AbortController(); } catch (_) { ac = null; }
    activeAbort = ac;
    var signal = ac ? ac.signal : null;
    fetchInFlight = true;
    try {
      var url = triggerBtn.getAttribute('data-catalogue-url') || '';
      if (!url) {
        setError('No catalog URL configured. Set "catalogue" in config.json.');
        return;
      }
      var response;
      try {
        response = await fetchWithTimeout(url, signal);
      } catch (e) {
        setError('Network error: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      if (!response.ok) {
        setError('HTTP ' + response.status + ' ' + (response.statusText || ''));
        return;
      }
      var text;
      try {
        text = await response.text();
      } catch (e) {
        setError('Failed reading response body: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      // Hand the raw text to the platform client. ONLY an Ok outcome
      // is persisted — a corrupt/invalid document, or one newer than
      // this runtime understands, keeps the cached catalogue in place
      // (D2b) and surfaces a distinct message. The version guard runs
      // before shape validation client-side, so a future catalogue is
      // reported as "runtime needs updating", not as corrupt.
      var client = globalThis.__brewserPlatformClient;
      if (!client) {
        setError('Platform client unavailable (shell bridge missing).');
        return;
      }
      var outcome;
      try {
        outcome = client.parseCatalogue(text);
      } catch (e) {
        setError('Catalogue parse threw: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      if (outcome.kind === 'TooNewCatalogue') {
        setError('This catalogue is version ' + outcome.version
          + ' — your Brewser runtime needs updating to read it. Keeping the current catalogue.');
        return;
      }
      if (outcome.kind !== 'Ok') {
        setError('Catalogue rejected (' + outcome.kind + '): '
          + (outcome.message || 'unknown reason') + '. Keeping the current catalogue.');
        return;
      }
      // Capture the PREVIOUS catalogue (the copy still on disk) before we
      // overwrite it, so the "New apps" list can show only what changed in
      // the store since the last check — not every uninstalled app. Read
      // into memory (no temp file to orphan if the check is interrupted);
      // parse it through the same platform client so the id set matches the
      // new side exactly. A missing/corrupt/too-old baseline yields `null`
      // → `diffNewInCatalogue` returns [] (no "previous one" to diff).
      var oldIds = null;
      try {
        var oldData = Switch.readFileSync(CATALOG_PATH);
        if (oldData) {
          var oldText = new TextDecoder().decode(oldData);
          var oldOutcome = client.parseCatalogue(oldText);
          if (oldOutcome && oldOutcome.kind === 'Ok') {
            oldIds = {};
            var oldApps = oldOutcome.catalogue.apps || [];
            for (var oi = 0; oi < oldApps.length; oi++) oldIds[oldApps[oi].id] = true;
          } else {
            console.debug('[updates-modal] previous catalogue unusable ('
              + (oldOutcome ? oldOutcome.kind : 'no outcome') + '); New-apps delta skipped');
          }
        } else {
          console.debug('[updates-modal] no previous catalogue on disk; New-apps delta skipped');
        }
      } catch (err) {
        console.debug('[updates-modal] reading previous catalogue failed: '
          + (err && err.message ? err.message : String(err)));
      }
      // Did the catalogue file itself change? Featured membership, new/removed
      // apps and version bumps all live here and drive the library tabs, so a
      // stale render would persist until a manual reload. `oldText` is undefined
      // when there was no usable previous copy on disk → treat as changed.
      var catalogueChanged = (typeof oldText !== 'string') || (oldText !== text);
      try {
        Switch.writeFileSync(CATALOG_PATH, text);
      } catch (e) {
        setError('Write failed: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      // Banner sync cache (configs/banner-cache.json) — read BEFORE the diff,
      // because diffCatalog uses it to decide which banners are even
      // candidates. A missing/corrupt cache degrades to `{}`: every banner is
      // then re-validated conditionally, which is slower but never wrong.
      var bannerCache = loadBannerCache();
      // Success — compute both diffs. The installed-state diff (buckets)
      // drives the banner pass + the upgrade chips + the "Updates" list; the
      // store delta (newApps) drives the "New apps" list against the old
      // catalogue captured above.
      var buckets;
      try {
        buckets = diffCatalog(outcome.catalogue, bannerCache);
      } catch (e) {
        setError('Diff failed: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      var newApps;
      try {
        newApps = diffNewInCatalogue(oldIds, outcome.catalogue);
      } catch (e) {
        // A delta failure must not sink an otherwise-good sync — degrade
        // to an empty "New apps" list and keep going.
        console.debug('[updates-modal] New-apps delta failed: ' + (e && e.message ? e.message : String(e)));
        newApps = [];
      }
      // Refresh the sibling telemetry files (downloads + ratings)
      // alongside the catalogue. Run in parallel with the banner pass
      // since they hit different hosts/repos and don't depend on each
      // other. Each call is best-effort and swallows its own errors,
      // so Promise.all here can't reject — we just await the whole
      // batch before flipping out of the loading state.
      var downloadsUrl = triggerBtn.getAttribute('data-downloads-url') || '';
      var ratingsUrl = triggerBtn.getAttribute('data-ratings-url') || '';
      var versionsUrl = triggerBtn.getAttribute('data-versions-url') || '';
      var statsUrl = triggerBtn.getAttribute('data-stats-url') || '';
      // Versions check runs alongside the other refreshes — independent
      // remote (versions.json lives in the apps repo, not telemetry),
      // independent failure mode. `Promise.all` is safe here only
      // because every task swallows its own errors; if any of these
      // ever start rejecting, switch to `Promise.allSettled`.
      // Cancelled during the catalogue fetch/parse? Skip the whole refresh
      // batch — close() already aborted this run and reset the overlay cache.
      if (signal && signal.aborted) return;
      var results = await Promise.all([
        syncBanners(buckets.banners, bannerCache, signal),
        refreshConfigFile(downloadsUrl, DOWNLOADS_PATH, 'downloads.json', signal),
        refreshConfigFile(ratingsUrl, RATINGS_PATH, 'ratings.json', signal),
        checkVersionsForUpdate(versionsUrl, signal),
        refreshStatsFile(client, statsUrl, signal),
        refreshMyCatalogue(signal),
        // Per-user Favorites + earned Achievements. Both best-effort and self-
        // contained (signed-out = no-op); their results don't gate any modal
        // UI — the favorites.html / achievements.html pages and the account-page
        // links pick them up server-side on the next render.
        refreshFavorites(signal),
        refreshAchievements(signal),
      ]);
      // Cancelled mid-batch: bail before the terminal DOM / cache mutations so
      // we don't re-dirty the page (which would resume the scroll-rebuild
      // flashing) or fight the repaint close() already did. The catalogue write
      // above stands — it's the point of the check; only the UI reveal is skipped.
      if (signal && signal.aborted) return;
      // Persist the banner cache once, after the whole pass — `syncBanners`
      // mutated it in place. Written even when nothing was fetched: a run that
      // only produced 304s still re-stamped records at the new catalogue
      // version, which is exactly what lets the NEXT press skip them with no
      // network at all. Skipped when the pass had no candidates (the object is
      // then untouched, so the write would be a no-op).
      if (buckets.banners.length > 0) saveBannerCache(bannerCache);
      // `checkVersionsForUpdate` returns {available, version} on a real update,
      // or falsy on any skip/no-update — coerce so both shapes read cleanly.
      var versionInfo = results[3] || {};
      var newBrewserVersionAvailable = !!versionInfo.available;
      var newBrewserVersion = typeof versionInfo.version === 'string' ? versionInfo.version : '';
      // Release-notes blurb for the offered build ('' when the release
      // published none — the line then stays hidden).
      var newBrewserNotes = typeof versionInfo.notes === 'string' ? versionInfo.notes : '';
      // Record whether the per-user My Apps document was refreshed this run —
      // close() reloads once so its server-rendered tab surfaces.
      myCatalogueRefreshed = !!results[5];
      // Reload on close when the render inputs actually changed: the catalogue
      // (Featured / app set / versions), stats.json (Popular / Top Rated
      // ordering), or freshly-downloaded banner bytes. `results[4]` is
      // refreshStatsFile's changed-flag; `results[0].downloaded` is the banner
      // pass's. A no-op check leaves all three false, so it still won't reload.
      var bannerResult = results[0] || {};
      libraryDataChanged = catalogueChanged || !!results[4] || bannerResult.downloaded > 0;
      // Repaint upgrade chips on already-installed cards whose
      // manifest version trails the new catalog. Synchronous DOM
      // mutation — runs after the logo downloads so all card-side
      // changes for this refresh land before populate() reveals
      // the modal lists.
      refreshUpgradeChips(buckets.updates);
      // Force a full body-cache rebuild so the open tab panel picks
      // up the upgraded card backgrounds + chip palette on the next
      // paint, not on the next layout-shifting input (tab switch).
      // The per-element invalidation chain (classList.notify →
      // invalidateLiveStyle) clears the cascade cache but leaves the
      // baked offscreen as-is for currently-visible content; the
      // closed modal then reveals stale pixels. Calling __swbRepaint
      // nukes the offscreen so the rebuild paints from the post-
      // mutation tree.
      if (typeof globalThis.__swbRepaint === 'function') {
        try { globalThis.__swbRepaint(); }
        catch (err) { console.debug('[updates-modal] __swbRepaint failed: ' + (err && err.message ? err.message : String(err))); }
      }
      populate(newApps, buckets.updates);
      renderParseReport(outcome.catalogue);
      card.classList.remove('updates-modal-card--loading');
      // Status line depends on whether this check surfaced anything: with no
      // store-delta apps, no installed-trailing updates and no newer Brewser,
      // everything is current → "Everything is up to date."; otherwise the
      // catalogue synced and the counts + Brewser callout show what changed.
      var somethingNew = newApps.length > 0 || buckets.updates.length > 0 || newBrewserVersionAvailable;
      statusEl.innerHTML = somethingNew ? 'Local Catalog is now synced!' : 'Everything is up to date.';
      brewserUpdateOffered = newBrewserVersionAvailable;
      // Whole-results empty state — shown only when NOTHING surfaced (both
      // counts hidden, Brewser callout hidden). Reveals the centered
      // "up to date" message instead of a bare results panel.
      if (somethingNew) {
        resultsEl.classList.remove('updates-modal-results--empty');
      } else {
        resultsEl.classList.add('updates-modal-results--empty');
      }
      // Brewser self-update: the bold "New Brewser version available" label
      // (static in the HTML) + the bright-yellow "Update Brewser vX.X.X" button
      // (labelled here, wired to the self-update modal below). Also mirror the
      // signal onto the trigger button (green `--update-available`) so it
      // persists after the modal closes. All cleared on an up-to-date run.
      if (newBrewserVersionAvailable) {
        brewserBtn.textContent = newBrewserVersion ? ('Update Brewser v' + newBrewserVersion) : 'Update Brewser';
        setBrewserNotes(newBrewserNotes);
        brewserCallout.classList.add('updates-modal-brewser--show');
        triggerBtn.classList.add('apps-check-updates--update-available');
      } else {
        setBrewserNotes('');
        brewserCallout.classList.remove('updates-modal-brewser--show');
        triggerBtn.classList.remove('apps-check-updates--update-available');
      }
    } finally {
      // Release the lock only if THIS run still owns it. A cancelled run had
      // its lock cleared (and `activeAbort` replaced/aborted) by close(), and a
      // re-run started after cancel now owns `activeAbort` — clearing here
      // unconditionally would unlock that newer run. Guard on identity + abort.
      if (activeAbort === ac) {
        fetchInFlight = false;
        activeAbort = null;
      }
    }
  }

  // Paint the release-notes line under the Update button. `textContent` (not
  // innerHTML) — the blurb is remote-authored text, and the modal must render
  // it as prose, never as markup. A blank/absent blurb hides the row so the
  // callout collapses back to label + button instead of leaving a gap.
  function setBrewserNotes(notes) {
    if (!brewserNotesEl) return;
    var text = typeof notes === 'string' ? notes.trim() : '';
    brewserNotesEl.textContent = text;
    if (text) {
      brewserNotesEl.classList.remove('updates-modal-brewser-notes--hidden');
    } else {
      brewserNotesEl.classList.add('updates-modal-brewser-notes--hidden');
    }
  }

  function open() {
    if (modalOpen) return;
    // Offline Mode backstop — refuse to open (and thus fetch) even if some
    // path fires open() while the trigger is disabled.
    if (globalThis.__brewserOfflineMode === true) return;
    // Reset the per-run My Apps flag so a prior run's reload can't fire.
    myCatalogueRefreshed = false;
    // Reset the catalogue/stats change flag too (same reason).
    libraryDataChanged = false;
    // Reset the Brewser-update offer so a stale prior run can't leave the status
    // line clickable before this run's versions check settles.
    brewserUpdateOffered = false;
    // Reset to loading state every open so a second tap after closing
    // shows the loading bar again (matches the user's expectation of
    // "checking…" each press).
    setLoading();
    statusEl.innerHTML = 'Local Catalog is now synced!';
    // Clear the summary counts + hide the Brewser callout so a prior
    // open/close cycle's content can't briefly flash on the next open before
    // the fetch settles.
    updatesCountEl.textContent = '';
    updatesCountEl.classList.add('updates-modal-count--hidden');
    newCountEl.textContent = '';
    newCountEl.classList.add('updates-modal-count--hidden');
    brewserCallout.classList.remove('updates-modal-brewser--show');
    setBrewserNotes('');
    resultsEl.classList.add('updates-modal-results--empty');
    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
    // Defer the fetch to a microtask so the modal paints in the
    // loading state on this frame; otherwise a synchronous fetch
    // error (e.g. missing URL) would flip the card straight to
    // `--error` before the user sees the loading bar at all.
    Promise.resolve().then(function () {
      if (!modalOpen) return;
      runCheck();
    });
  }

  function close() {
    if (!modalOpen) return;
    overlay.classList.remove('app-modal-overlay--open');
    card.classList.remove('updates-modal-card--loading');
    card.classList.remove('updates-modal-card--error');
    modalOpen = false;
    // Cancel during the loading phase: the check is still running. Orphan it so
    // the user isn't left watching the app grid re-bake on every scroll — while
    // the page's live tree is dirty (from the check's in-flight card mutations),
    // the overlay engine drops the cheap cache-blit scroll path and does a full
    // chunked rebuild each scroll, which reads as all cards "flashing/reloading".
    //   (a) abort the run's fetches (best-effort — a stuck connect is really
    //       killed by fetchWithTimeout's deadline; the abort also makes
    //       syncBanners bail before mutating more cards),
    //   (b) release the in-flight lock so the next "Check for Updates" tap isn't
    //       swallowed by the `if (fetchInFlight) return` guard, and
    //   (c) reconcile the overlay cache NOW (__swbRepaint → resetLiveOverlayCache)
    //       so scrolling returns to the cheap blit path immediately instead of
    //       waiting for the orphaned run (or a navigation) to settle.
    // The orphaned runCheck sees `signal.aborted` at its next guard and returns
    // without touching the page further; its `finally` no-ops (activeAbort has
    // moved on), so it can't clobber a subsequent run's lock.
    if (fetchInFlight) {
      if (activeAbort) { try { activeAbort.abort(); } catch (_) {} }
      activeAbort = null;
      fetchInFlight = false;
      if (typeof globalThis.__swbRepaint === 'function') {
        try { globalThis.__swbRepaint(); }
        catch (err) { console.debug('[updates-modal] cancel repaint failed: ' + (err && err.message ? err.message : String(err))); }
      }
    }
    // Reload once on dismiss when this sync changed anything the page renders
    // from disk: the per-user My Apps document, the catalogue (Featured / app
    // set / versions), or stats.json (Popular / Top Rated order). Fires AFTER
    // the modal is closed (never mid-modal, per the no-reload-mid-modal rule up
    // top). A no-op check leaves all flags false, so its behaviour is unchanged.
    if ((myCatalogueRefreshed || libraryDataChanged) && typeof globalThis.__swbReload === 'function') {
      myCatalogueRefreshed = false;
      libraryDataChanged = false;
      try { globalThis.__swbReload(); } catch (_) {}
    }
  }

  triggerBtn.addEventListener('click', function (e) {
    open();
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Expose the modal's open() so other page scripts can fire the EXACT same
  // action the "Check for Updates" toolbar button does. Consumed by the
  // boot-time "new version available" toast (boot-update-check.js): tapping
  // the toast runs the full check here — which then surfaces the yellow
  // "Update Brewser vX.X.X" button — rather than duplicating the flow. Guarded
  // in the consumer (`typeof … === 'function'`), so a page without this script
  // just no-ops.
  globalThis.__brewserOpenUpdatesModal = function () { open(); };

  // Cancel (during the loading phase) and Close (after the check
  // completes) both fire `close()`. Two separate listeners keep each
  // button's intent self-documenting at the call site. Cancel aborts the
  // in-flight run and reconciles the overlay cache (see `close()`), so a
  // dismissed check leaves the page in a clean, non-flashing state and a
  // fresh check can start immediately.
  cancelBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });
  closeBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // The bright-yellow "Update Brewser vX.X.X" button opens the self-update
  // modal (self-update-modal.js, loaded before this script). Only visible when
  // the versions check offered an update; `brewserUpdateOffered` is a
  // belt-and-braces gate so a stale click can't fire before this run settles.
  brewserBtn.addEventListener('click', function (e) {
    if (!brewserUpdateOffered) return;
    // Offline Mode: the self-update download is a network action. Unreachable
    // in practice (the modal can't open), but guard for defense in depth.
    if (globalThis.__brewserOfflineMode === true) return;
    if (typeof globalThis.__brewserOpenSelfUpdateModal === 'function') {
      globalThis.__brewserOpenSelfUpdateModal();
      if (e && e.stopPropagation) e.stopPropagation();
    }
  });

  // Backdrop tap → close. Filter on `e.target === overlay` so a tap
  // landing inside the card (which bubbles up) doesn't close it.
  overlay.addEventListener('click', function (e) {
    if (e && e.target === overlay) close();
  });

  // No-op window-level mousedown listener so page-mouse-forwarder.ts
  // flips its `pageHasListenerFor('mousedown')` gate and routes B
  // through `contextmenu` instead of the shell's no-op rightClick.
  // Same gate-flip the missing-app modal uses — both modals carry one
  // listener each; the dedicated empty handlers don't conflict because
  // they're just gate flags, not behavior.
  window.addEventListener('mousedown', function () { /* gate */ });

  // B (default rightClick) → close. preventDefault keeps the shell's
  // contextmenu fallback from doing anything else while the modal
  // is open. Sibling modals on the page each register their own
  // contextmenu listener; they each gate on their own `modalOpen`
  // flag so only the visible modal reacts.
  window.addEventListener('contextmenu', function (e) {
    if (!modalOpen) return;
    close();
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // L (default `back`) — the shell dispatches synthetic Escape on L
  // when any page keydown listener exists. preventDefault signals
  // the shell not to also navigate back, so an L press while the
  // modal is open only closes the modal.
  window.addEventListener('keydown', function (e) {
    if (!modalOpen) return;
    var key = e && e.key;
    if (key === 'Escape' || key === 'Esc') {
      close();
      if (e && e.preventDefault) e.preventDefault();
    }
  });
})();
