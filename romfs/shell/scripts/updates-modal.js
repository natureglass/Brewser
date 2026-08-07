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
//     diff right there, and in-place patches (logo seeding, upgrade chips)
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
  var VERSIONS_PATH = APP_ROOT + 'configs/versions.json';
  var CURRENT_PATH = APP_ROOT + 'configs/current.json';
  // C2 operational counters (downloads/ratingAvg/ratingCount), fetched
  // alongside the catalogue from `data-stats-url`. Persisted only when
  // the platform client parses it; a bad/missing stats.json is NOT a
  // sync failure (Popular / Top Rated degrade visibly instead).
  var STATS_PATH = APP_ROOT + 'configs/stats.json';
  // Per-user "My Apps" document — folded in from the retired standalone
  // "Fetch my Apps" button. Refreshed alongside the catalogue when a Brewser
  // account is signed in (Bearer token), written verbatim after the platform
  // client validates it. URL comes from `data-my-catalogue-url` on the trigger
  // button (`<browser-config-my-catalogue>`).
  var MY_CATALOGUE_PATH = APP_ROOT + 'configs/my-catalogue.json';
  // Per-user Favorites (catalogue-v2) and earned Achievements documents,
  // refreshed alongside the catalogue for a signed-in Brewser account. URLs
  // come from `data-favorites-url` / `data-achievements-url` on the trigger
  // button (`<browser-config-favorites>` / `<browser-config-achievements>`).
  // Favorites reuses the catalogue file name; achievements uses `my-` to avoid
  // clobbering the bundled `configs/achievements.json` criteria catalogue.
  var FAVORITES_PATH = APP_ROOT + 'configs/favorites.json';
  var ACHIEVEMENTS_PATH = APP_ROOT + 'configs/my-achievements.json';

  var modalOpen = false;
  var fetchInFlight = false;
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

  // Walk the grid cards on the page, find the one whose detail
  // matches `(group, id)`, and rewrite its `<img class="app-logo">`
  // `src` (plus the `logo` field inside its `data-app-detail` JSON
  // so the missing-app modal picks up the real glyph too) to the
  // brewser:// URL pointing at the just-downloaded logo. Triggers
  // a live-DOM image load + repaint so the user sees the real
  // logo without navigating away. Silent no-op when no card on the
  // current page matches — covers `home.html`'s featured grid not
  // sharing the same Apps cards.
  function refreshCardLogo(detail) {
    var logoRel = detail.logo ? stripLeadingSlashes(detail.logo) : '';
    if (!logoRel) return;
    var brewserUrl = 'brewser://apps/' + detail.id + '/' + logoRel;
    var cards = document.querySelectorAll('[data-app-detail]');
    for (var i = 0; i < cards.length; i++) {
      var cardEl = cards[i];
      var raw = cardEl.getAttribute('data-app-detail');
      if (!raw) continue;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (_) { continue; }
      if (!parsed || parsed.id !== detail.id) continue;
      // First IMG child = the `.app-logo` element (only `<img>` in
      // the card markup; no need to filter by class). setAttribute
      // routes through LiveElement.setAttr which kicks off
      // loadImage(value) — the new bytes load async and the live
      // tree dirties so the next paint shows them.
      for (var c = 0; c < cardEl.children.length; c++) {
        var child = cardEl.children[c];
        if (child.tagName === 'IMG') {
          child.setAttribute('src', brewserUrl);
          break;
        }
      }
      // Update the embedded detail JSON so the missing-app modal —
      // which reads `detail.logo` at open time to set its header
      // image — also picks up the real glyph. The card stays flagged
      // as `missing` (entry file is still absent) but the visuals are
      // now accurate.
      parsed.logo = brewserUrl;
      cardEl.setAttribute('data-app-detail', JSON.stringify(parsed));
      return;
    }
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

  // Best-effort download of every missing app's catalogue logo so the
  // grid card paints the real glyph on next render instead of the
  // generic `download.png`. Each failure is logged + swallowed —
  // failing a single logo doesn't fail the catalogue refresh.
  //
  // The remote URL is the platform client's `logoUrl` (built from the
  // catalogue's `sources` table — never assembled here); the local
  // path matches the flat on-disk layout `<appRoot>apps/<id>/<logo>`.
  // mkdirSync handles intermediate folders, so the app dir + any logo
  // subfolder (`assets/` etc.) are created in one call. After a
  // successful write the card on the visible Apps page gets its
  // `<img src>` rewritten in-place so the user sees the real glyph
  // without a reload.
  async function seedMissingLogos(missing) {
    if (!missing || missing.length === 0) return;
    for (var i = 0; i < missing.length; i++) {
      var detail = missing[i];
      var logoRel = detail.logo ? stripLeadingSlashes(detail.logo) : '';
      if (!logoRel || !detail.logoUrl) continue;
      var remoteUrl = detail.logoUrl;
      var localPath = APP_ROOT + 'apps/' + detail.id + '/' + logoRel;
      try {
        var dir = parentDir(localPath);
        if (dir) Switch.mkdirSync(dir);
      } catch (err) {
        console.debug('[updates-modal] mkdir failed for ' + detail.id + ': ' + (err && err.message ? err.message : String(err)));
        continue;
      }
      try {
        var resp = await globalThis.fetch(remoteUrl);
        if (!resp.ok) {
          console.debug('[updates-modal] logo HTTP ' + resp.status + ' for ' + remoteUrl);
          continue;
        }
        var buf = await resp.arrayBuffer();
        Switch.writeFileSync(localPath, buf);
      } catch (err) {
        console.debug('[updates-modal] logo fetch/write failed for ' + remoteUrl + ': ' + (err && err.message ? err.message : String(err)));
        continue;
      }
      // Successful write → repaint the matching grid card in place.
      try { refreshCardLogo(detail); }
      catch (err) { console.debug('[updates-modal] refreshCardLogo failed: ' + (err && err.message ? err.message : String(err))); }
    }
  }

  // Best-effort refresh of a sibling JSON config (downloads / ratings)
  // from a remote URL. Validates the response body as JSON before the
  // write so a stray HTML 200 (e.g. captive portal) can't replace a
  // good file with garbage. Every failure path is logged + swallowed —
  // a downloads.json HTTP 500 should NOT block a successful catalog
  // refresh. Empty URL is treated as "skip silently".
  async function refreshConfigFile(remoteUrl, localPath, label) {
    if (!remoteUrl) {
      console.debug('[updates-modal] ' + label + ' URL not configured; skipping refresh');
      return;
    }
    try {
      var resp = await globalThis.fetch(remoteUrl);
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
  async function refreshStatsFile(client, remoteUrl) {
    if (!remoteUrl) {
      console.debug('[updates-modal] stats URL not configured; skipping refresh');
      return false;
    }
    try {
      var resp = await globalThis.fetch(remoteUrl);
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
  // version + app count; itemizes dropped entries and unknown
  // fields/permissions/sources/entities only when present, so a clean
  // sync reads as one quiet line.
  function renderParseReport(catalogue) {
    var el = document.getElementById('updates-modal-report');
    if (!el || !catalogue || !catalogue.report) return;
    var r = catalogue.report;
    var html = 'Catalogue v' + escapeHtml(String(r.version))
      + ' — ' + escapeHtml(String(r.appCount)) + ' apps';
    var details = [];
    if (r.dropped && r.dropped.length) {
      var droppedBits = [];
      for (var i = 0; i < r.dropped.length; i++) {
        var d = r.dropped[i];
        droppedBits.push(escapeHtml((d.id || ('#' + d.index)) + ': ' + d.reason));
      }
      details.push('dropped ' + r.dropped.length + ' (' + droppedBits.join('; ') + ')');
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
  async function checkVersionsForUpdate(remoteUrl) {
    if (!remoteUrl) {
      console.debug('[updates-modal] versions URL not configured; skipping check');
      return false;
    }
    var fetchedText;
    try {
      var resp = await globalThis.fetch(remoteUrl);
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
    return { available: true, version: brewserVer };
  }

  // Walk the NORMALIZED catalogue (platform-client output — this
  // script never reads raw catalogue fields) and bucket each app by its
  // INSTALLED state on disk:
  //   * missing — launcher not on disk under the flat `apps/<id>/<entry>`.
  //     Drives `seedMissingLogos` (fetch the art for apps you don't have).
  //   * updates — installed manifest `version` differs from the
  //     catalogue's. Drives BOTH the in-place upgrade-chip repaint
  //     (`refreshUpgradeChips`) and the modal's "Updates" list.
  // This is the ACTION diff (catalogue-vs-disk). It is NOT the source of
  // the "New apps" list — that comes from the store delta computed by
  // `diffNewInCatalogue` (old-vs-new catalogue). Mirrors the engine-side
  // library join so the installed-state view matches the grid after the
  // next reload.
  function diffCatalog(normalized) {
    var decoder = new TextDecoder();
    var missing = [];
    var updates = [];
    var apps = normalized && Array.isArray(normalized.apps) ? normalized.apps : [];
    for (var ei = 0; ei < apps.length; ei++) {
      var e = apps[ei];
      var entryRel = stripLeadingSlashes(e.entryRel || 'index.html');
      var entryPath = APP_ROOT + 'apps/' + e.id + '/' + entryRel;
      var entryData = null;
      try { entryData = Switch.readFileSync(entryPath); } catch (_) { entryData = null; }
      if (!entryData) {
        missing.push({
          id: e.id,
          name: e.name || e.id,
          version: e.version || '',
          // Relative logo path + the platform-client-built remote URL
          // (`logoUrl` — source-aware, so ext-repo apps fetch from
          // their own root). The post-diff logo pass stashes the bytes
          // under the flat `apps/<id>/<logoRel>` so the engine's next
          // render paints the real glyph on the missing card.
          logo: e.logoRel || '',
          logoUrl: e.logoUrl || '',
        });
        continue;
      }
      // Installed — compare manifest.json's version against the
      // catalogue's. Skip when either side is empty (no signal to
      // surface) or the strings match (no upgrade available).
      if (!e.version) continue;
      var manifestPath = APP_ROOT + 'apps/' + e.id + '/manifest.json';
      var manifestData = null;
      try { manifestData = Switch.readFileSync(manifestPath); } catch (_) { manifestData = null; }
      if (!manifestData) continue;
      var installedVersion = '';
      try {
        var manifest = JSON.parse(decoder.decode(manifestData));
        installedVersion = typeof manifest.version === 'string' ? manifest.version : '';
      } catch (_) { continue; }
      if (!installedVersion || installedVersion === e.version) continue;
      updates.push({
        id: e.id,
        name: e.name || e.id,
        version: e.version,
        installedVersion: installedVersion,
      });
    }
    return { missing: missing, updates: updates };
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
  // Folded-in "Fetch my Apps": when a Brewser account is signed in, refresh
  // the per-user My Apps document alongside the catalogue. Best-effort — a
  // signed-out user, missing URL, auth failure, bad response, or write error
  // just leaves any existing my-catalogue.json untouched and never fails the
  // overall sync (so it's safe inside the runCheck Promise.all). Returns true
  // only when a fresh document was validated + written.
  // Shared Bearer-token read for the per-user refreshes (my-catalogue,
  // favorites, achievements). Returns '' when signed out (no active session).
  function readAuthToken() {
    if (globalThis.__swbAuth && typeof globalThis.__swbAuth.readActiveSession === 'function') {
      var session = globalThis.__swbAuth.readActiveSession();
      if (session && session.record && typeof session.record.token === 'string') {
        return session.record.token;
      }
    }
    return '';
  }

  async function refreshMyCatalogue() {
    var url = triggerBtn.getAttribute('data-my-catalogue-url') || '';
    if (!url) return false;
    var token = readAuthToken();
    if (!token) return false; // signed out — nothing to fetch
    var response;
    try {
      response = await globalThis.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    } catch (e) {
      console.debug('[updates-modal] my-catalogue fetch threw: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
    if (!response.ok) {
      console.debug('[updates-modal] my-catalogue HTTP ' + response.status);
      return false;
    }
    var text;
    try { text = await response.text(); }
    catch (e) { return false; }
    // Validate through the platform client before persisting — never write a
    // document the runtime can't read (same rule as the catalogue itself).
    var client = globalThis.__brewserPlatformClient;
    if (client && typeof client.parseCatalogue === 'function') {
      var outcome;
      try { outcome = client.parseCatalogue(text); }
      catch (e) { console.debug('[updates-modal] my-catalogue parse threw'); return false; }
      if (!outcome || outcome.kind !== 'Ok') {
        console.debug('[updates-modal] my-catalogue rejected: ' + (outcome ? outcome.kind : 'no outcome'));
        return false;
      }
    }
    try { Switch.writeFileSync(MY_CATALOGUE_PATH, text); }
    catch (e) { console.debug('[updates-modal] my-catalogue write failed: ' + (e && e.message ? e.message : String(e))); return false; }
    return true;
  }

  // Per-user Favorites — refreshed alongside the catalogue for a signed-in
  // account. Validated through the platform client (it's a catalogue-v2
  // document, same as the catalogue / my-catalogue) before persisting to
  // configs/favorites.json. Best-effort: signed-out, missing URL, auth failure,
  // bad body or write error leaves any existing file untouched and never fails
  // the overall sync (safe inside the runCheck Promise.all). Returns true only
  // when a fresh document was validated + written.
  async function refreshFavorites() {
    var url = triggerBtn.getAttribute('data-favorites-url') || '';
    if (!url) return false;
    var token = readAuthToken();
    if (!token) return false; // signed out — nothing to fetch
    var response;
    try {
      response = await globalThis.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    } catch (e) {
      console.debug('[updates-modal] favorites fetch threw: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
    if (!response.ok) {
      console.debug('[updates-modal] favorites HTTP ' + response.status);
      return false;
    }
    var text;
    try { text = await response.text(); }
    catch (e) { return false; }
    var client = globalThis.__brewserPlatformClient;
    if (client && typeof client.parseCatalogue === 'function') {
      var outcome;
      try { outcome = client.parseCatalogue(text); }
      catch (e) { console.debug('[updates-modal] favorites parse threw'); return false; }
      if (!outcome || outcome.kind !== 'Ok') {
        console.debug('[updates-modal] favorites rejected: ' + (outcome ? outcome.kind : 'no outcome'));
        return false;
      }
    }
    try { Switch.writeFileSync(FAVORITES_PATH, text); }
    catch (e) { console.debug('[updates-modal] favorites write failed: ' + (e && e.message ? e.message : String(e))); return false; }
    return true;
  }

  // Per-user earned Achievements — a small custom document
  // ({ version, generated, achievements: [...] }), NOT catalogue-v2, so it's
  // validated as JSON carrying an `achievements` array (a stray HTML 200 or a
  // shape drift can't replace a good file) before persisting to
  // configs/my-achievements.json. Best-effort, same rules as the others.
  async function refreshAchievements() {
    var url = triggerBtn.getAttribute('data-achievements-url') || '';
    if (!url) return false;
    var token = readAuthToken();
    if (!token) return false; // signed out — nothing to fetch
    var response;
    try {
      response = await globalThis.fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    } catch (e) {
      console.debug('[updates-modal] achievements fetch threw: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
    if (!response.ok) {
      console.debug('[updates-modal] achievements HTTP ' + response.status);
      return false;
    }
    var text;
    try { text = await response.text(); }
    catch (e) { return false; }
    try {
      var parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.achievements)) {
        console.debug('[updates-modal] achievements body missing achievements array; refusing write');
        return false;
      }
    } catch (e) {
      console.debug('[updates-modal] achievements is not valid JSON; refusing write: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
    try { Switch.writeFileSync(ACHIEVEMENTS_PATH, text); }
    catch (e) { console.debug('[updates-modal] achievements write failed: ' + (e && e.message ? e.message : String(e))); return false; }
    return true;
  }

  async function runCheck() {
    if (fetchInFlight) return;
    fetchInFlight = true;
    try {
      var url = triggerBtn.getAttribute('data-catalogue-url') || '';
      if (!url) {
        setError('No catalog URL configured. Set "catalogue" in config.json.');
        return;
      }
      var response;
      try {
        response = await globalThis.fetch(url);
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
      // Success — compute both diffs. The installed-state diff (buckets)
      // drives logo seeding + the upgrade chips + the "Updates" list; the
      // store delta (newApps) drives the "New apps" list against the old
      // catalogue captured above.
      var buckets;
      try {
        buckets = diffCatalog(outcome.catalogue);
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
      // alongside the catalogue. Run in parallel with the logo seed
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
      var results = await Promise.all([
        seedMissingLogos(buckets.missing),
        refreshConfigFile(downloadsUrl, DOWNLOADS_PATH, 'downloads.json'),
        refreshConfigFile(ratingsUrl, RATINGS_PATH, 'ratings.json'),
        checkVersionsForUpdate(versionsUrl),
        refreshStatsFile(client, statsUrl),
        refreshMyCatalogue(),
        // Per-user Favorites + earned Achievements. Both best-effort and self-
        // contained (signed-out = no-op); their results don't gate any modal
        // UI — the favorites.html / achievements.html pages and the account-page
        // links pick them up server-side on the next render.
        refreshFavorites(),
        refreshAchievements(),
      ]);
      // `checkVersionsForUpdate` returns {available, version} on a real update,
      // or falsy on any skip/no-update — coerce so both shapes read cleanly.
      var versionInfo = results[3] || {};
      var newBrewserVersionAvailable = !!versionInfo.available;
      var newBrewserVersion = typeof versionInfo.version === 'string' ? versionInfo.version : '';
      // Record whether the per-user My Apps document was refreshed this run —
      // close() reloads once so its server-rendered tab surfaces.
      myCatalogueRefreshed = !!results[5];
      // Reload on close when the render inputs actually changed: the catalogue
      // (Featured / app set / versions) or stats.json (Popular / Top Rated
      // ordering). `results[4]` is refreshStatsFile's changed-flag. A no-op
      // check leaves both false, so it still won't reload.
      libraryDataChanged = catalogueChanged || !!results[4];
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
        brewserCallout.classList.add('updates-modal-brewser--show');
        triggerBtn.classList.add('apps-check-updates--update-available');
      } else {
        brewserCallout.classList.remove('updates-modal-brewser--show');
        triggerBtn.classList.remove('apps-check-updates--update-available');
      }
    } finally {
      fetchInFlight = false;
    }
  }

  function open() {
    if (modalOpen) return;
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

  // Cancel (during the loading phase) and Close (after the check
  // completes) both fire `close()`. Two separate listeners keep each
  // button's intent self-documenting at the call site. Cancel only
  // dismisses the modal — the in-flight fetch continues to settle in
  // the background; the success path then populates the (now-hidden)
  // modal, which is harmless.
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
