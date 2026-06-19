// Check-for-Updates modal — wired to the `.apps-check-updates` button
// on apps.html. Opens a centered modal that shows a pulsing loading
// bar while a real http(s) fetch of the configured catalog URL is in
// flight, then either:
//   - Success: rewrites `sdmc:/switch/brewser/catalogue.json` with the
//     fetched bytes, then walks the new catalog vs. each installed
//     app's `manifest.json` on disk to produce the "New apps" /
//     "Updates" diff lists in the modal. The page is NOT reloaded —
//     the user sees the diff right there, then dismisses the modal.
//     The grid cards in the background still reflect the OLD catalog
//     until the user navigates away and back, by design (avoids a
//     full repaint mid-modal).
//   - Failure: flips the card into the `--error` state and surfaces a
//     human-readable error string so the user knows the catalog was
//     NOT updated.
//
// The catalog URL is read from `data-catalogue-url` on the trigger
// button — populated server-side by the `<browser-config-catalogue>`
// custom tag from `config.json` -> `catalogue`. Empty / missing
// URL = treated as a failure (the fetch isn't attempted).
//
// Diff source of truth: AFTER the write, the script parses the just-
// fetched catalog JSON and walks each entry, reading
// `sdmc:/switch/brewser/apps/<group>/<id>/manifest.json` for the
// installed version + checking the launcher's entry file for
// presence. This mirrors `loadCatalogGroup` + `readInstalledVersion
// IfChanged` in src/profile/browser-toolbar.ts — they're the engine-
// side equivalents that drive the grid-card upgrade chips.
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
  var newSection = document.getElementById('updates-modal-new-section');
  var newList = document.getElementById('updates-modal-new');
  var updateSection = document.getElementById('updates-modal-update-section');
  var updateList = document.getElementById('updates-modal-update');
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
  if (!overlay || !card || !resultsEl || !newSection || !newList || !updateSection || !updateList || !statusEl || !errorEl || !cancelBtn || !closeBtn || !triggerBtn) {
    console.debug('[updates-modal] init aborted; missing node(s): '
      + ' overlay=' + !!overlay + ' card=' + !!card + ' results=' + !!resultsEl
      + ' newSection=' + !!newSection + ' newList=' + !!newList
      + ' updateSection=' + !!updateSection + ' updateList=' + !!updateList
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
  // `romfs/configs/current.json`). Any field-by-field mismatch
  // appends a "New Brewser Version available" line to the modal
  // summary. `current.json` is NEVER overwritten by this flow —
  // overwriting it would make the next check always read equal and
  // never surface an upgrade. `versions.json` is downloaded on every
  // Check-for-Updates press, so a stale copy can't hide a new release.
  var VERSIONS_PATH = APP_ROOT + 'configs/versions.json';
  var CURRENT_PATH = APP_ROOT + 'configs/current.json';
  // The three catalog groups walked when computing the diff. Mirror
  // `CATALOG_GROUPS` in src/profile/browser-toolbar.ts — keep in sync
  // if a new group is ever added on the engine side.
  var GROUPS = ['featured', 'community', 'experimental'];

  var modalOpen = false;
  var fetchInFlight = false;

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

  // Strip the final URL path segment to get a base directory URL with
  // a trailing slash. The catalogue URL points at `catalogue.json` (or
  // whatever the user named it); the per-app asset URLs live alongside
  // it, so the base is "catalog URL minus the filename". Falls back to
  // the input unchanged when there's no `/` to strip (defensive — a
  // malformed URL still produces some output rather than throwing).
  function catalogueBaseUrl(url) {
    var idx = url.lastIndexOf('/');
    if (idx < 0) return url;
    return url.slice(0, idx + 1);
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
    var brewserUrl = 'brewser://apps/' + detail.group + '/' + detail.id + '/' + logoRel;
    var cards = document.querySelectorAll('[data-app-detail]');
    for (var i = 0; i < cards.length; i++) {
      var cardEl = cards[i];
      var raw = cardEl.getAttribute('data-app-detail');
      if (!raw) continue;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (_) { continue; }
      if (!parsed || parsed.id !== detail.id || parsed.group !== detail.group) continue;
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
      if (!parsed || parsed.id !== detail.id || parsed.group !== detail.group) continue;
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

  // Best-effort download of every missing app's catalog logo so the
  // grid card paints the real glyph on next render instead of the
  // generic `download.png`. Each failure is logged + swallowed —
  // failing a single logo doesn't fail the catalog refresh.
  //
  // The remote URL is constructed from the catalogue URL's base dir
  // (`https://.../main/`) + `apps/<group>/<id>/<logo>`, matching the
  // on-disk layout the engine expects under `<appRoot>apps/<group>/
  // <id>/<logo>`. mkdirSync handles intermediate folders, so the app
  // dir + any logo subfolder (`assets/` etc.) are created in one call.
  // After a successful write the card on the visible Apps page gets
  // its `<img src>` rewritten in-place so the user sees the real
  // glyph without a reload.
  async function seedMissingLogos(missing, catalogueUrl) {
    if (!missing || missing.length === 0) return;
    var baseUrl = catalogueBaseUrl(catalogueUrl);
    for (var i = 0; i < missing.length; i++) {
      var detail = missing[i];
      var logoRel = detail.logo ? stripLeadingSlashes(detail.logo) : '';
      if (!logoRel) continue;
      var remoteUrl = baseUrl + 'apps/' + detail.group + '/' + detail.id + '/' + logoRel;
      var localPath = APP_ROOT + 'apps/' + detail.group + '/' + detail.id + '/' + logoRel;
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

  // Download `versions.json` from the configured URL, persist it under
  // `<appRoot>configs/versions.json`, then compare it field-by-field
  // against the seeded `<appRoot>configs/current.json` baseline.
  // Returns `true` iff any field differs (the modal then appends the
  // "New Brewser Version available" line). Best-effort throughout:
  // every failure path logs + returns `false` so a versions-check miss
  // can't cascade into a catalogue refresh failure. `current.json` is
  // never written by this flow — overwriting it would make every
  // future check read equal and silently hide new releases.
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
    // Strict string inequality on every key present in the fetched
    // versions.json. A field-by-field test (not a semver compare) is
    // the contract — "is this exactly the same set of bits I shipped
    // with?". Keys present in `current` but missing from `fetched` are
    // ignored (the server is authoritative for what's currently
    // released; a dropped field means that component isn't tracked
    // anymore). A new key in `fetched` (a component that didn't exist
    // when this install shipped) counts as a mismatch — current's
    // implicit value is "" which won't equal the fetched string.
    for (var key in fetchedParsed) {
      if (!Object.prototype.hasOwnProperty.call(fetchedParsed, key)) continue;
      var fetchedVal = fetchedParsed[key];
      var currentVal = Object.prototype.hasOwnProperty.call(currentParsed, key)
        ? currentParsed[key] : '';
      if (String(fetchedVal) !== String(currentVal)) {
        console.debug('[updates-modal] version mismatch on "' + key + '": current=' + String(currentVal) + ' fetched=' + String(fetchedVal));
        return true;
      }
    }
    return false;
  }

  // Walk the fetched catalog and bucket each entry as missing (the
  // launcher file isn't on disk under `apps/<group>/<id>/<entry>`) or
  // updated (manifest.json's `version` differs from the catalog's
  // `version`). Mirrors the engine-side checks in
  // src/profile/browser-toolbar.ts so the modal's diff matches what
  // the grid will show after the next reload.
  function diffCatalog(catalog) {
    var decoder = new TextDecoder();
    var missing = [];
    var updates = [];
    for (var gi = 0; gi < GROUPS.length; gi++) {
      var group = GROUPS[gi];
      var entries = catalog && Array.isArray(catalog[group]) ? catalog[group] : [];
      for (var ei = 0; ei < entries.length; ei++) {
        var e = entries[ei];
        if (!e || typeof e !== 'object') continue;
        if (typeof e.id !== 'string' || typeof e.entry !== 'string') continue;
        var name = typeof e.name === 'string' ? e.name : e.id;
        var version = typeof e.version === 'string' ? e.version : '';
        var entryRel = stripLeadingSlashes(e.entry);
        var entryPath = APP_ROOT + 'apps/' + group + '/' + e.id + '/' + entryRel;
        var entryData = null;
        try { entryData = Switch.readFileSync(entryPath); } catch (_) { entryData = null; }
        if (!entryData) {
          missing.push({
            id: e.id,
            group: group,
            name: name,
            version: version,
            // Catalog-relative logo path (e.g. `assets/pvzge_logo.png`).
            // Forwarded to the post-diff logo-download pass so it can
            // pull the bytes from the remote catalog and stash them
            // under `apps/<group>/<id>/<logo>` on disk — the engine's
            // next render then paints the real logo on the missing
            // card instead of the generic download glyph.
            logo: typeof e.logo === 'string' ? e.logo : '',
          });
          continue;
        }
        // Installed — compare manifest.json's version against the
        // catalog's. Skip when either side is empty (no signal to
        // surface) or the strings match (no upgrade available).
        if (!version) continue;
        var manifestPath = APP_ROOT + 'apps/' + group + '/' + e.id + '/manifest.json';
        var manifestData = null;
        try { manifestData = Switch.readFileSync(manifestPath); } catch (_) { manifestData = null; }
        if (!manifestData) continue;
        var installedVersion = '';
        try {
          var manifest = JSON.parse(decoder.decode(manifestData));
          installedVersion = typeof manifest.version === 'string' ? manifest.version : '';
        } catch (_) { continue; }
        if (!installedVersion || installedVersion === version) continue;
        updates.push({
          id: e.id,
          group: group,
          name: name,
          version: version,
          installedVersion: installedVersion,
        });
      }
    }
    return { missing: missing, updates: updates };
  }

  function renderNewRow(detail) {
    var name = escapeHtml(detail.name || detail.id || 'Unknown app');
    var ver = detail.version
      ? '<span class="updates-modal-row-version">v' + escapeHtml(detail.version) + '</span>'
      : '';
    return '<div class="updates-modal-row">'
      + '<span class="updates-modal-row-name">' + name + '</span>'
      + ver
      + '</div>';
  }

  function renderUpdateRow(detail) {
    var name = escapeHtml(detail.name || detail.id || 'Unknown app');
    // `v1.0.0 [→] v1.0.1` — installed on the LEFT, catalog on the
    // RIGHT, separated by the same inline-SVG arrow used elsewhere.
    // Critical: do NOT substitute a Unicode `→` here — the engine
    // doesn't ship a font with that glyph and it'd render as tofu.
    var ver = '<span class="updates-modal-row-version">'
      + 'v' + escapeHtml(detail.installedVersion)
      + UPGRADE_ARROW_SVG
      + 'v' + escapeHtml(detail.version)
      + '</span>';
    return '<div class="updates-modal-row">'
      + '<span class="updates-modal-row-name">' + name + '</span>'
      + ver
      + '</div>';
  }

  function populate(buckets) {
    var newHtml = buckets.missing.map(renderNewRow).join('');
    var updateHtml = buckets.updates.map(renderUpdateRow).join('');
    newList.innerHTML = newHtml;
    updateList.innerHTML = updateHtml;
    // Per-section empty toggle keeps the heading suppressed when its
    // list has no entries, but only one of the two needs to be empty
    // for the modal to still feel populated.
    if (buckets.missing.length === 0) {
      newSection.classList.add('updates-modal-section--empty');
    } else {
      newSection.classList.remove('updates-modal-section--empty');
    }
    if (buckets.updates.length === 0) {
      updateSection.classList.add('updates-modal-section--empty');
    } else {
      updateSection.classList.remove('updates-modal-section--empty');
    }
    // Whole-results empty state: shown only when BOTH lists are empty.
    if (buckets.missing.length === 0 && buckets.updates.length === 0) {
      resultsEl.classList.add('updates-modal-results--empty');
    } else {
      resultsEl.classList.remove('updates-modal-results--empty');
    }
  }

  // Fire-and-forget the actual update flow. Each failure path flips
  // the card into `--error` and surfaces a message; success leaves
  // the modal open with the diff lists populated. Nothing escapes.
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
      // JSON-validate before writing — bad JSON on disk would silently
      // empty the apps grid (loadCatalogGroup returns []). Better to
      // refuse the write and keep the old catalog in place.
      var parsed;
      try {
        parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') {
          setError('Catalog JSON is not an object.');
          return;
        }
      } catch (e) {
        setError('Catalog is not valid JSON: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      try {
        Switch.writeFileSync(CATALOG_PATH, text);
      } catch (e) {
        setError('Write failed: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      // Success — compute the diff against the freshly-written
      // catalog and the on-disk manifests, then populate the modal
      // and remove the loading state so the lists become visible.
      var buckets;
      try {
        buckets = diffCatalog(parsed);
      } catch (e) {
        setError('Diff failed: ' + (e && e.message ? e.message : String(e)));
        return;
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
      // Versions check runs alongside the other refreshes — independent
      // remote (versions.json lives in the apps repo, not telemetry),
      // independent failure mode. `Promise.all` is safe here only
      // because every task swallows its own errors; if any of these
      // ever start rejecting, switch to `Promise.allSettled`.
      var results = await Promise.all([
        seedMissingLogos(buckets.missing, url),
        refreshConfigFile(downloadsUrl, DOWNLOADS_PATH, 'downloads.json'),
        refreshConfigFile(ratingsUrl, RATINGS_PATH, 'ratings.json'),
        checkVersionsForUpdate(versionsUrl),
      ]);
      var newBrewserVersionAvailable = !!results[3];
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
      populate(buckets);
      card.classList.remove('updates-modal-card--loading');
      // Append a second line to the modal summary when the
      // freshly-downloaded versions.json differs from the seeded
      // current.json baseline. `<br>` keeps the original "Local Catalog
      // is now synced!" intact + readable on its own line. The append
      // is purely visual — no per-frame work since the fixed-position
      // overlay is repainted from the cache (see
      // [[reference-brewser-fixed-overlay-paint-cost]]).
      var statusHtml = 'Local Catalog is now synced!';
      if (newBrewserVersionAvailable) {
        statusHtml += '<br>New Brewser Version available';
      }
      statusEl.innerHTML = statusHtml;
    } finally {
      fetchInFlight = false;
    }
  }

  function open() {
    if (modalOpen) return;
    // Reset to loading state every open so a second tap after closing
    // shows the loading bar again (matches the user's expectation of
    // "checking…" each press).
    setLoading();
    statusEl.innerHTML = 'Local Catalog is now synced!';
    // Empty the new/update lists so an old open/close cycle's content
    // doesn't briefly flash on the next open before the fetch settles.
    newList.innerHTML = '';
    updateList.innerHTML = '';
    newSection.classList.add('updates-modal-section--empty');
    updateSection.classList.add('updates-modal-section--empty');
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
