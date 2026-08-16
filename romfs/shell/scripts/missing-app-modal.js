// Missing-app detail modal — shared by apps.html (full catalog) and
// home.html (Featured Apps grid). Looks for cards stamped
// `data-missing="true"` + `data-app-detail="<JSON>"` by the catalog
// renderer (see `renderAppCards` in browser-resource-loader.ts) and
// opens a centered detail modal in place of the would-be navigation.
//
// Visibility is driven by `classList.add/remove('app-modal-overlay--open')`
// — NOT `style.display`. The InlineStyle setters on LiveElement.style
// are plain field writes that don't invalidate the live-DOM paint cache
// (and don't mark the element dirty), so flipping display via inline
// style leaves the previous frame's pixels on screen when the modal
// closes. The second open then paints a fresh modal on top of the
// stale one — exactly the "two modals stacked" bug we hit in the first
// pass. classList mutations route through LiveTokenList.notify which
// chains invalidateLiveStyle + bumpLiveTreeVersion + markLiveDirty,
// so the dirty-region patch on the next onTick repaint properly
// erases the closed overlay.

(function () {
  var overlay = document.getElementById('app-modal-overlay');
  var logoEl = document.getElementById('app-modal-logo');
  var versionEl = document.getElementById('app-modal-version');
  var licenseEl = document.getElementById('app-modal-license');
  var titleEl = document.getElementById('app-modal-title');
  var identifierEl = document.getElementById('app-modal-identifier');
  // Header "Rating | Downloads" line (under the packageId). Populated each
  // show() from headStatsHtml(); null if the page markup predates it.
  var headStatsEl = document.getElementById('app-modal-headstats');
  var descEl = document.getElementById('app-modal-description');
  var bodyEl = document.getElementById('app-modal-body');
  var cancelBtn = document.getElementById('app-modal-cancel');
  var playBtn = document.getElementById('app-modal-play');
  var downloadBtn = document.getElementById('app-modal-download');
  // Update lives in the LEFT action slot; visually identical to
  // Download (same red palette) but conceptually "install over an
  // existing app to bring it to the catalog version." Stubbed for now
  // alongside Download until the actual install flow lands.
  var updateBtn = document.getElementById('app-modal-update');
  // Install-size chip. Populated from `detail.sizeBytes` (catalogue.json
  // → loadCatalogGroup → renderAppCards stamps it onto the card's
  // data-app-detail JSON). Lives in the LEFT action slot so it sits
  // alongside the Update button (upgrade case) or alone in that slot
  // (missing / installed-current). Optional element — `null` if the
  // page hasn't been redeployed since the markup was added.
  var sizeEl = document.getElementById('app-modal-size');
  // Delete button — LEFT action slot, shown only for an INSTALLED app
  // (i.e. whenever Launch is shown). Opens delete-modal.js which
  // uninstalls the app (per-file remove + progress bar) and reloads the
  // grid. Optional element so markup predating it can't break the modal.
  var deleteBtn = document.getElementById('app-modal-delete');
  // "Create shortcut" (app forwarder) — LEFT action slot, shown only for an
  // INSTALLED app (like Delete). Opens forwarder-modal.js. Optional element.
  var forwarderBtn = document.getElementById('app-modal-forwarder');
  // Expand/collapse the description into a near-full-modal reading view.
  // `cardEl` is the app-detail modal card (`.app-modal-card`; an id was
  // added to the markup for this feature). Toggling `app-modal-card--expanded`
  // on it hides the meta strip / header / body rows and lets the description
  // grow to fill the card — CSS lives in the four theme stylesheets.
  // `expandRow` wraps the button so we can hide the whole row (button and
  // all) for apps with no description. All three are optional — markup that
  // predates this feature simply won't wire the toggle.
  var cardEl = document.getElementById('app-modal-card');
  var expandBtn = document.getElementById('app-modal-expand');
  var expandRow = document.getElementById('app-modal-expand-row');
  if (!overlay || !titleEl || !bodyEl || !cancelBtn || !downloadBtn || !playBtn || !updateBtn) return;

  var modalOpen = false;
  var currentDetail = null;
  // Captured app URL for the warnings-modal handoff. Populated in
  // show() ONLY when the current detail has one or more permissions
  // that match an entry in `configs/warnings.json` — in that case we
  // deliberately leave the play <a>'s href unset so the engine's
  // findTapIntent finds no navigate ancestor on tap, and the click
  // listener below routes through the warnings modal instead. Cleared
  // back to '' when the current detail has no matching warnings (the
  // standard path: href is set on the play button and the engine
  // navigates directly without any JS in the middle).
  var pendingLaunchUrl = '';

  // Whether the description is currently in the expanded reading view.
  var descExpanded = false;
  // Toggle the near-full-modal description view. Adds/removes the
  // `app-modal-card--expanded` class (the theme CSS hides the meta / header
  // / body and grows the description to fill the card) and swaps the button
  // label between "Expand" and "Collapse". Uses classList — NOT
  // `style.display` — so the modal-layer paint cache invalidates, the same
  // reason the overlay open/close does (see the top-of-file note).
  function setExpanded(on) {
    descExpanded = !!on;
    if (cardEl) {
      if (descExpanded) cardEl.classList.add('app-modal-card--expanded');
      else cardEl.classList.remove('app-modal-card--expanded');
    }
    if (expandBtn) expandBtn.textContent = descExpanded ? 'Collapse' : 'Expand';
  }

  // Default download glyph — used when the catalog entry doesn't carry
  // a logo URL we can resolve (or carries the placeholder we already
  // emit for missing entries). Same asset the grid card paints.
  var DEFAULT_LOGO_URL = 'brewser://assets/download.png';

  // Right-pointing arrow painted between the installed + catalog
  // versions in the upgrade chip. Same `<svg><polygon>` markup the
  // grid renderer emits — kept in sync so the chip looks identical
  // in the modal and on the card. live-overlay.ts paintLiveSvg
  // handles viewBox scaling per frame.
  var UPGRADE_ARROW_SVG = '<svg class="upgrade-arrow" viewBox="0 0 14 10" width="14" height="10">'
    + '<polygon points="0,4 8,4 8,1 14,5 8,9 8,6 0,6" fill="#0b1220"/>'
    + '</svg>';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function row(label, value) {
    return '<div class="app-modal-row">'
      + '<span class="app-modal-row-label">' + esc(label) + '</span>'
      + '<span class="app-modal-row-value">' + esc(String(value)) + '</span>'
      + '</div>';
  }

  // Format a byte count as a megabyte string. Two decimal places —
  // enough resolution to distinguish a 0.05 MB icon-only test app
  // from a 0.50 MB demo and a 50.00 MB full app. Returns an empty
  // string when the input isn't a positive finite number so the
  // caller can branch on that to hide the chip entirely (catalog
  // entries that omit `sizeBytes` round-trip through the renderer
  // as 0).
  function formatSizeMB(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
    var mb = bytes / (1024 * 1024);
    return mb.toFixed(2) + ' MB';
  }

  // Format an integer with thousands separators ("1234" → "1,234"). The
  // catalog of downloaded apps is small today but the field can grow
  // unbounded — formatting keeps four-and-five-digit counts readable.
  function formatCount(n) {
    var s = String(n | 0);
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Read + parse a JSON config from the on-disk config dir
  // (`sdmc:/switch/brewser/configs/<name>`). Configs are read by ABSOLUTE
  // sdmc path, never a relative `fetch('configs/…')`: from the
  // `brewser://home/` page that relative URL resolves to the bogus
  // `brewser://home/configs/…` ("unknown brewser:// page"), and the
  // brewser:// loader only routes `apps/` to the app root — every other
  // path (incl. `configs/`) maps under the `shell/` subtree, where the
  // config files don't live. Same absolute-path pattern writeLocalRating
  // already uses to WRITE ratings.json. Returns the parsed value or null.
  function readJsonConfig(name) {
    if (typeof Switch === 'undefined' || !Switch || typeof Switch.readFileSync !== 'function') return null;
    try {
      var raw = Switch.readFileSync('sdmc:/switch/brewser/configs/' + name);
      if (!raw || !raw.byteLength) return null;
      return JSON.parse(new TextDecoder().decode(raw));
    } catch (err) {
      console.debug('[apps] config read failed (' + name + '): '
        + (err && err.message ? err.message : String(err)));
      return null;
    }
  }

  // Star pixel dimension. Mirrored in inline `style="width:Npx..."`
  // on each <img> in renderStarsHtml so the live-DOM layout sizes the
  // replaced inline atom at this dimension regardless of whether the
  // `.app-modal-star` class rule lands in the cascade (the PNGs are
  // 64×64 natural, which would otherwise determine layout size).
  var STAR_PX = 22;

  // Build the star-row HTML for a given raw average (0..5) + count.
  // Always 5 stars (full / half / empty mix) so the row width is
  // stable across apps. The average is rounded to the nearest HALF
  // — `halves = round(average * 2)` yields 0..10 — so 4.3 → 4 full +
  // 1 half (8.6 → 9), 4.8 → 5 full (9.6 → 10), 4.1 → 4 full (8.2 → 8).
  // For each star index `i` (0..4): full when at least two halves
  // remain for that slot, half when exactly one remains, else empty.
  // Inline style on each <img> forces the layout to STAR_PX × STAR_PX
  // even if class width doesn't reach the live-DOM image atom — the
  // engine's IMG layoutLeaf reads `cs.width`, and inline style is the
  // most specific rule.
  // Format the raw average as a short numeric string for the leading
  // chip in the rating row. One decimal place, with trailing ".0"
  // stripped so integer averages read clean (5.0 → "5", 4.5 → "4.5").
  function formatAverage(avg) {
    if (typeof avg !== 'number' || !isFinite(avg)) return '0';
    var s = avg.toFixed(1);
    if (s.length > 2 && s.charAt(s.length - 2) === '.' && s.charAt(s.length - 1) === '0') {
      s = s.slice(0, -2);
    }
    return s;
  }

  function renderStarsHtml(average, count) {
    var avg = typeof average === 'number' && isFinite(average) ? average : 0;
    var halves = Math.max(0, Math.min(10, Math.round(avg * 2)));
    // Row layout: explicit 5px inline-block spacers flank the star
    // group. Margins on flex / inline IMG children turned out to be
    // unreliable in the live-DOM engine, but `display:inline-block;
    // width:5px` paints a measurable empty atom every time (same
    // path the 22×22 stars use for their explicit size). The spacer
    // span carries the dimensions inline so a CSS-class miss can't
    // collapse it.
    //   [average] [5px spacer] [★1..★5] [5px spacer] [(count)]
    //
    // Each star carries `data-stars="N"` (1..5) so the delegated
    // tap handler on #app-modal-rating can route the click into
    // submitRating(N). The engine's findTapIntent doesn't walk into
    // <img> as a tap target by default, but the click event still
    // bubbles up from the live-DOM IMG atom — the listener uses
    // event.target.getAttribute('data-stars') (or closest match) to
    // recover the slot. Pointer cursor hint goes on each via inline
    // style so the row reads as interactive without requiring a
    // theme-CSS class to land.
    var spacer = '<span style="display:inline-block;width:5px;height:1px;"></span>';
    var html = '<span class="app-modal-rating-average">' + formatAverage(avg) + '</span>';
    html += spacer;
    for (var i = 0; i < 5; i++) {
      var src;
      if (halves >= (i + 1) * 2) src = 'brewser://assets/star_full.png';
      else if (halves === i * 2 + 1) src = 'brewser://assets/star_half.png';
      else src = 'brewser://assets/star_empty.png';
      html += '<img class="app-modal-star" data-stars="' + (i + 1)
        + '" style="width:' + STAR_PX + 'px;height:' + STAR_PX
        + 'px;cursor:pointer;" src="' + src + '" alt="">';
    }
    html += spacer;
    html += '<span class="app-modal-stats-count">(' + formatCount(count) + ')</span>';
    return html;
  }

  // The "Rating | Downloads" line shown in the HEADER, under the packageId
  // (moved out of the body row stack). Rating on the left — the interactive
  // star row + average + count — a thin divider, then the download count.
  // Stamped with the same #app-modal-rating / #app-modal-downloads IDs the
  // async loadStats() + submitRating() re-query, so relocating the stats
  // from the body to the header changed only where this markup lands.
  // `.app-modal-rating-value` keeps the star-row flex alignment; the extra
  // inline flex styles let the two stats sit on one line. The rating-message
  // host is now a static element in the header markup (see apps.html), so
  // this no longer emits it.
  function headStatsHtml() {
    return '<span id="app-modal-rating" class="app-modal-rating-value" style="display:inline-flex;align-items:center;">'
      + renderStarsHtml(0, 0)
      + '</span>'
      + '<span class="app-modal-headstats-sep" style="opacity:0.4;padding:0 2px;">|</span>'
      + '<span class="app-modal-headstats-dl" style="display:inline-flex;align-items:center;gap:6px;">'
      + '<img src="brewser://assets/download.png" alt="Downloads" style="width:15px;height:15px;">'
      + '<span id="app-modal-downloads">' + formatCount(0) + '</span>'
      + '</span>';
  }

  // Bind per-star click listeners. Required because the engine's
  // `dispatchEvent` (live-dom.ts) does NOT stamp `event.target` on
  // synthetic events — it just walks `target = target.parent` to
  // bubble listeners. So a delegated handler on an ancestor has no
  // way to recover which star atom was hit. Per-IMG binding with
  // the stars index closured in is the working pattern (same shape
  // the catalog-card delegation uses for the data-app-detail JSON).
  // Re-run after every rating-row innerHTML rewrite — the prior
  // IMG nodes are garbage-collected each time so their listeners
  // can't survive.
  function bindStarListeners() {
    var rtEl = document.getElementById('app-modal-rating');
    if (!rtEl) return;
    var stars = rtEl.querySelectorAll('[data-stars]');
    for (var i = 0; i < stars.length; i++) {
      (function (starEl) {
        var n = parseInt(starEl.getAttribute('data-stars'), 10);
        if (!(n >= 1 && n <= 5)) return;
        starEl.addEventListener('click', function (e) {
          submitRating(n);
          if (e && e.stopPropagation) e.stopPropagation();
          if (e && e.preventDefault) e.preventDefault();
        });
      })(stars[i]);
    }
  }

  // Replace the rating-row inner content. Re-renders the star group
  // from the current avg/count and clears any prior message in the
  // host slot (caller may immediately follow up with
  // setRatingMessage(...) to surface a new one). Re-binds the
  // per-star click listeners against the freshly-created IMG atoms.
  function updateRatingDom() {
    var rtEl = document.getElementById('app-modal-rating');
    if (!rtEl) return;
    rtEl.innerHTML = renderStarsHtml(currentRatingAvg, currentRatingCount);
    bindStarListeners();
  }

  // Fill or clear the host slot beneath the rating row. `html` is
  // the inner HTML of the message span (links / styled text); pass
  // '' (or omit) to clear. The wrapping row keeps the same
  // `.app-modal-row` structure as everything else in the body so the
  // separators align.
  function setRatingMessage(html) {
    var host = document.getElementById('app-modal-rating-msg-host');
    if (!host) return;
    if (!html) { host.innerHTML = ''; return; }
    // Simple inline message under the header stats line. The rating now
    // lives in the header (not the body row list), so it no longer borrows
    // the `.app-modal-row` border/padding cadence — a plain left-aligned
    // note sits directly beneath "Rating | Downloads".
    host.innerHTML = '<div style="margin-top:4px;font-size:13px;text-align:left;">' + html + '</div>';
  }

  // Rating-submission state. `currentRatingAvg/Count` are the values
  // the modal is currently displaying for the open detail — kept in
  // sync by loadStats() (post-fetch) and submitRating()
  // (optimistic-update). `ratingAppId` is the packageId those values
  // belong to, used to gate async POST callbacks from writing into
  // the wrong modal if the user swaps detail before the request
  // settles. `ratingInFlight` is the per-modal guard against
  // double-tap mid-POST.
  var currentRatingAvg = 0;
  var currentRatingCount = 0;
  var ratingAppId = '';
  var ratingInFlight = false;
  // Telemetry endpoint. The URL is strict-pinned at the runtime layer
  // (see `@switch-web/runtime`'s `RUNTIME_CONFIG_DEFAULTS.telemetry`)
  // and surfaced to the page by the resource loader's
  // `<browser-config-telemetry>` tag expansion, stamped onto
  // `<body data-telemetry-url>` of both home.html and apps.html (the
  // two pages that load this script). Reading from the DOM is
  // synchronous + can't fail with a network error, so the old
  // fetch-and-cache shape is gone too.
  function readTelemetryUrl() {
    var body = globalThis.document && globalThis.document.body;
    var url = body && body.getAttribute('data-telemetry-url');
    return Promise.resolve(typeof url === 'string' ? url : '');
  }

  // Best-effort "is the device online right now" probe. Reads the
  // engine's cached `__browserNetworkStatus` (set by `probeNetwork`
  // in browser-shell.ts on boot + every 60 s). Returns:
  //   - `true`  when the cached probe says the HTTPS path is up
  //   - `false` when the cached probe completed and overallReachable
  //              is explicitly false
  //   - `null`  when no probe has landed yet — caller treats as
  //              "let the fetch decide" rather than blocking the tap.
  // The 60 s staleness window means a freshly-pulled cable can still
  // surface as "online"; the fetch-throw catch downstream catches
  // that case and shows the same toast.
  function readEngineReachability() {
    var probe = globalThis.__browserNetworkStatus;
    if (!probe) return null;
    if (typeof probe.overallReachable === 'boolean') return probe.overallReachable;
    return null;
  }

  // Offline toast. Lives in a persistent host appended to the modal
  // overlay so it paints in the modal layer (above the page) and
  // tracks the modal's own visibility — when the user closes the
  // modal mid-toast the host is still there but visually hidden
  // behind the closing overlay. The host's innerHTML is rewritten
  // each show/hide, which is the cache-safe path: setting
  // `style.display` directly on a LiveElement is a plain field write
  // that doesn't invalidate the live-DOM paint cache (same reason
  // the modal overlay uses classList for open/close — see top-of-
  // file comment), but a fresh innerHTML stamp creates new DOM
  // nodes and is picked up cleanly.
  var toastHost = null;
  var toastTimer = null;
  function ensureToastHost() {
    if (toastHost) return toastHost;
    toastHost = document.createElement('div');
    toastHost.setAttribute('id', 'app-modal-toast-host');
    overlay.appendChild(toastHost);
    return toastHost;
  }
  function showOfflineToast(msg) {
    var host = ensureToastHost();
    // Single in-flight toast — bump the visible message + reset
    // the dismiss timer on each call.
    var safe = esc(msg);
    host.innerHTML = '<div style="'
      + 'position:fixed;top:24px;left:50%;transform:translateX(-50%);'
      + 'padding:12px 22px;border-radius:10px;'
      + 'background:#1a0d22;border:1px solid #ff5577;'
      + 'color:#ffe7ec;font-size:14px;font-weight:600;'
      + 'box-shadow:0 6px 22px rgba(0,0,0,0.45);'
      + 'z-index:1100;max-width:520px;text-align:center;'
      + '">' + safe + '</div>';
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (toastHost) toastHost.innerHTML = '';
    }, 3200);
  }
  function clearOfflineToast() {
    if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastHost) toastHost.innerHTML = '';
  }
  // The friendly message the user sees when the device can't reach
  // the telemetry server. Kept as a constant so both the pre-flight
  // short-circuit and the post-fetch network-error catch surface
  // identical text.
  var OFFLINE_TOAST_MSG = "You're offline — connect to Wi-Fi to send your rating.";

  // Apply a new rating to the on-disk `configs/ratings.json` after
  // a successful telemetry POST. Reads the file fresh (so a parallel
  // updates-modal refresh that landed since loadStats can't be
  // clobbered), finds or appends the entry for `packageId`, and
  // recomputes count + average per the spec:
  //     newCount = oldCount + 1
  //     newAvg   = (oldAvg * oldCount + stars) / newCount
  // The file is the local cache for the modal's display next open —
  // server is the source of truth and the next "Check for Updates"
  // pull resyncs.
  function writeLocalRating(packageId, stars) {
    if (typeof Switch === 'undefined' || !Switch) return;
    var path = 'sdmc:/switch/brewser/configs/ratings.json';
    var arr = [];
    try {
      var raw = Switch.readFileSync(path);
      if (raw && raw.byteLength > 0) {
        var text = new TextDecoder().decode(raw);
        var parsed = JSON.parse(text);
        if (Array.isArray(parsed)) arr = parsed;
      }
    } catch (err) {
      console.debug('[apps] ratings.json read failed: ' + (err && err.message ? err.message : String(err)));
    }
    var entry = null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].packageId === packageId) { entry = arr[i]; break; }
    }
    if (entry) {
      var oldAvg = (typeof entry.average === 'number' && isFinite(entry.average)) ? entry.average : 0;
      var oldCount = (typeof entry.count === 'number' && isFinite(entry.count)) ? entry.count : 0;
      var newCount = oldCount + 1;
      entry.count = newCount;
      entry.average = (oldAvg * oldCount + stars) / newCount;
    } else {
      arr.push({ packageId: packageId, count: 1, average: stars });
    }
    try {
      Switch.writeFileSync(path, JSON.stringify(arr, null, 2));
    } catch (err) {
      console.debug('[apps] ratings.json write failed: ' + (err && err.message ? err.message : String(err)));
    }
  }

  // Star-tap entry point. `stars` is 1..5. Validates auth, applies
  // an optimistic UI update (so the row reflects the new score
  // BEFORE the POST returns), fires the telemetry POST, and either
  // commits the local file write (on 202) or reverts the UI + shows
  // an inline error.
  function submitRating(stars) {
    var n = stars | 0;
    if (n < 1 || n > 5) return;
    if (!ratingAppId) return;
    if (ratingInFlight) return;
    // Auth gate. `__swbAuth.readActiveSession()` is synchronous
    // (file-backed read of `auth/active.json` + the named provider's
    // record). Missing global = script load order regression; treat
    // as not-signed-in so we surface the prompt instead of crashing.
    var session = null;
    try {
      if (globalThis.__swbAuth && typeof globalThis.__swbAuth.readActiveSession === 'function') {
        session = globalThis.__swbAuth.readActiveSession();
      }
    } catch (err) {
      console.debug('[apps] __swbAuth.readActiveSession threw: ' + (err && err.message ? err.message : String(err)));
    }
    if (!session || !session.record || typeof session.record.id !== 'string' || session.record.id.length === 0) {
      setRatingMessage('<a href="brewser://login/" style="color:#7cf;">Sign in to rate</a>');
      return;
    }
    // Pre-flight offline check. If the engine's cached probe is
    // explicitly false (`overallReachable === false`) we know the
    // POST will fail — short-circuit with the toast and DON'T fire
    // the optimistic update. When the probe is missing or `null`
    // (race with boot, no probe yet) we fall through and let the
    // fetch decide; a TypeError / no-response catch downstream
    // shows the same toast.
    if (readEngineReachability() === false) {
      showOfflineToast(OFFLINE_TOAST_MSG);
      return;
    }
    var userId = session.record.id;
    var packageId = ratingAppId;
    // Capture pre-update state for revert.
    var prevAvg = currentRatingAvg;
    var prevCount = currentRatingCount;
    var newCount = prevCount + 1;
    var newAvg = (prevAvg * prevCount + n) / newCount;
    currentRatingAvg = newAvg;
    currentRatingCount = newCount;
    updateRatingDom();
    setRatingMessage('');
    clearOfflineToast();
    ratingInFlight = true;

    // Track whether the failure looks like a network drop vs. a
    // server-side reject. The promise chain throws either way; the
    // catch branch decides which UI to surface (toast vs. inline
    // "Rating failed").
    var networkFailure = false;
    readTelemetryUrl().then(function (telemetryUrl) {
      if (!telemetryUrl) throw new Error('telemetry URL not configured');
      var body = JSON.stringify({
        packageId: packageId,
        userId: userId,
        reqType: 'like',
        data: ['like', n],
        platform: 'switch',
      });
      return globalThis.fetch(telemetryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      }).catch(function (err) {
        // fetch() itself threw — that's a transport-layer fault
        // (DNS, TLS, socket, timeout). Tag it so the outer catch
        // surfaces the offline toast instead of the inline error
        // (which is reserved for "server said no" cases).
        networkFailure = true;
        throw err;
      });
    }).then(function (resp) {
      if (!resp || resp.status !== 202) {
        // No response object at all → treat as a network fault too
        // (nxjs's fetch can resolve with null in edge cases the
        // spec doesn't cover). A non-202 status, by contrast, means
        // the server reached us and rejected — inline error path.
        if (!resp) networkFailure = true;
        throw new Error('HTTP ' + (resp ? resp.status : 'no response'));
      }
      writeLocalRating(packageId, n);
    }).catch(function (err) {
      console.debug('[apps] rating POST failed: ' + (err && err.message ? err.message : String(err)));
      // Revert ONLY if the modal still has the same app open. If
      // the user closed/swapped the modal while the request was in
      // flight, ratingAppId no longer matches and the DOM update
      // would land on the wrong card.
      if (ratingAppId === packageId) {
        currentRatingAvg = prevAvg;
        currentRatingCount = prevCount;
        updateRatingDom();
        if (networkFailure) {
          showOfflineToast(OFFLINE_TOAST_MSG);
        } else {
          setRatingMessage('<span style="color:#f88;">Rating failed. Try again.</span>');
        }
      }
    }).then(function () {
      ratingInFlight = false;
    });
  }

  // Token guard for stats fetches. Bumped on every show(); the async
  // fetch checks the captured value before writing into the DOM so a
  // fast modal-swap (open A, close, open B before A's fetch resolves)
  // can't paint A's stats into B's modal.
  var statsToken = 0;

  function loadStats(appId) {
    var myToken = ++statsToken;
    if (!appId) return;
    // Read the cached stats straight from disk (absolute sdmc path — see
    // readJsonConfig). Wrapped in Promise.resolve so the downstream
    // token-guarded DOM update below is unchanged.
    var dlPromise = Promise.resolve(readJsonConfig('downloads.json'));
    var rtPromise = Promise.resolve(readJsonConfig('ratings.json'));
    Promise.all([dlPromise, rtPromise]).then(function (results) {
      if (myToken !== statsToken) return;
      var dl = results[0];
      var rt = results[1];
      var count = (dl && typeof dl === 'object' && typeof dl[appId] === 'number') ? dl[appId] : 0;
      // Re-query the DOM each time — the row spans are written into
      // body innerHTML on every show(), so module-level refs would go
      // stale after the second open.
      var dlEl = document.getElementById('app-modal-downloads');
      var rtEl = document.getElementById('app-modal-rating');
      if (dlEl) dlEl.textContent = formatCount(count);
      var entry = null;
      if (Array.isArray(rt)) {
        for (var i = 0; i < rt.length; i++) {
          if (rt[i] && rt[i].packageId === appId) { entry = rt[i]; break; }
        }
      }
      var avg = 0;
      var c = 0;
      if (entry) {
        avg = (typeof entry.average === 'number' && isFinite(entry.average)) ? entry.average : 0;
        c = (typeof entry.count === 'number' && isFinite(entry.count)) ? entry.count : 0;
      }
      // Cache the post-fetch state so the star-tap handler can apply
      // its optimistic delta on top of the real numbers (vs. the
      // 0/0 placeholder we baked in at show() time).
      currentRatingAvg = avg;
      currentRatingCount = c;
      if (rtEl) {
        rtEl.innerHTML = renderStarsHtml(avg, c);
        // The placeholder stars stamped by show() had listeners
        // attached, but innerHTML replaces those IMG atoms with
        // fresh ones — re-bind against the new nodes.
        bindStarListeners();
      }
    });
  }

  function show(detail) {
    currentDetail = detail || {};
    // Logo. The catalog renderer passes a brewser:// URL — for missing
    // entries that's the download.png placeholder; for future "cached"
    // entries it'll be the real app logo. Fall back to download.png
    // when the field is absent for any reason.
    if (logoEl) {
      var logoUrl = (typeof currentDetail.logo === 'string' && currentDetail.logo.length > 0)
        ? currentDetail.logo
        : DEFAULT_LOGO_URL;
      logoEl.setAttribute('src', logoUrl);
    }
    // Meta strip chips. Mirror the grid card's `v1.0.0` / `MIT`
    // shape exactly — `:empty` rules in main.css hide the slot when
    // the catalog omits one. textContent stays empty so the empty-
    // selector matches. When `installedVersion` is set, render the
    // upgrade variant (yellow `--upgrade` chip with installed +
    // catalog versions split by an inline-SVG arrow) — same markup
    // shape as the grid card's chip so the two stay visually
    // consistent. innerHTML routes through the live-DOM HTML parser
    // so the SVG subtree paints via paintLiveSvg.
    if (versionEl) {
      if (currentDetail.installedVersion && currentDetail.version) {
        versionEl.innerHTML = '<span>v' + esc(currentDetail.installedVersion) + '</span>'
          + UPGRADE_ARROW_SVG
          + '<span>v' + esc(currentDetail.version) + '</span>';
        versionEl.classList.add('app-meta__version--upgrade');
      } else {
        versionEl.textContent = currentDetail.version ? 'v' + currentDetail.version : '';
        versionEl.classList.remove('app-meta__version--upgrade');
      }
    }
    if (licenseEl) licenseEl.textContent = currentDetail.license || '';

    titleEl.textContent = currentDetail.name || currentDetail.id || 'Unknown app';

    // Identifier sits in the header column next to the logo (above
    // the description). Promoted out of the body rows so the user can
    // see the dotted ID at a glance alongside the title. The `:empty`
    // CSS rule hides the slot when the catalog entry has no `id`.
    if (identifierEl) identifierEl.textContent = currentDetail.id || '';

    // Description block. Prefer the full HTML `description` (carried in the
    // catalogue entry / local manifest) rendered as HTML so paragraphs,
    // bold and bullet lists show — the developer-authored body is
    // wp_kses-sanitized on the WP side, and the `.app-modal-description`
    // CSS bounds it with a max-height + scrollbar. Fall back to the short
    // blurb (`description`) as plain text when there's no full description.
    // innerHTML/textContent both replace the children, so swapping apps is
    // cache-safe (fresh nodes each open, per the toast-host note above).
    var hasDescription = false;
    if (descEl) {
      var fullDesc = (typeof currentDetail.fullDescription === 'string')
        ? currentDetail.fullDescription : '';
      if (fullDesc.replace(/^\s+|\s+$/g, '') !== '') {
        descEl.innerHTML = fullDesc;
        hasDescription = true;
      } else {
        var shortDesc = currentDetail.description || '';
        descEl.textContent = shortDesc;
        hasDescription = shortDesc.replace(/^\s+|\s+$/g, '') !== '';
      }
      // Reset the scroll position so a freshly-opened app always starts
      // reading from the top. The description element persists across
      // opens (only its children are swapped by innerHTML/textContent),
      // so without this it inherits the previous app's scrollTop. The
      // scrollTop setter bumps the modal tree version when the element is
      // in the modal layer, so the modal cache repaints at offset 0 (see
      // the modal inner-scroll note at the top of this file).
      descEl.scrollTop = 0;
    }
    // Only surface the Expand toggle when there's a description to expand —
    // mirrors the description block's own `:empty { display:none }` rule so
    // we never leave an orphaned button under a hidden block. The install-size
    // chip now shares this row (to the button's LEFT) but is independent of the
    // description, so we hide only the BUTTON here and defer the ROW's
    // visibility to after the size chip is populated below (the row stays
    // visible whenever either the button or the size chip is showing).
    if (expandBtn) {
      if (hasDescription) expandBtn.classList.remove('app-modal-btn--hidden');
      else expandBtn.classList.add('app-modal-btn--hidden');
    }

    // Detail rows in the order requested: category → features →
    // permissions → allowed_origins → developer → source. Identifier
    // used to lead this list but now lives in the header column (see
    // identifierEl above) so the modal surfaces it next to the logo.
    // Version + license are shown as chips in the meta strip, so we
    // don't repeat them here either.
    // Rating | Downloads go in the HEADER (under the packageId), not the
    // body row stack. Rendered as the 0 / 5-empty-stars placeholder;
    // loadStats() rewrites the value spans once the configs land. Also
    // clear any stale rating message from a previous open (the message
    // host is a static header element now, not re-stamped each show()).
    if (headStatsEl) headStatsEl.innerHTML = headStatsHtml();
    setRatingMessage('');

    var rows = [];
    if (currentDetail.category) rows.push(row('Category', currentDetail.category));
    if (currentDetail.features) rows.push(row('Features', currentDetail.features));
    if (currentDetail.permissions) rows.push(row('Permissions', currentDetail.permissions));
    // Drop the row entirely when there are no allowed origins — matches
    // the Features row above rather than surfacing an empty em-dash cell.
    if (currentDetail.allowedOrigins) rows.push(row('Allowed origins', currentDetail.allowedOrigins));
    if (currentDetail.developer) rows.push(row('Developer', currentDetail.developer));
    if (currentDetail.source) rows.push(row('Source', currentDetail.source));
    bodyEl.innerHTML = rows.join('');

    // Reset rating-submission state for the new modal session. The
    // placeholder 0/0 cached here gets overwritten by loadStats()
    // once the on-disk ratings.json read resolves; an in-flight POST
    // from the previous modal session keeps running but its DOM
    // updates are gated on `ratingAppId === packageId` (set below)
    // so it can't paint into the wrong card. The toast clear keeps
    // a previous session's offline toast from re-appearing on
    // reopen if the auto-dismiss hadn't yet fired.
    ratingAppId = currentDetail.id || '';
    currentRatingAvg = 0;
    currentRatingCount = 0;
    ratingInFlight = false;
    clearOfflineToast();

    // Bind the per-star listeners on the placeholder 0/0 stars that
    // headStatsHtml just stamped into the header. Without this the user
    // could tap a star before loadStats() resolves and the tap would
    // silently no-op (no listeners attached yet). loadStats's
    // re-render path re-binds against the post-fetch stars too.
    bindStarListeners();

    // Kick off the Downloads + Rating fetches AFTER the body innerHTML
    // is written — the async update path re-queries the row spans by
    // ID, which must exist by then. The token guard handles fast
    // modal swaps.
    loadStats(currentDetail.id || '');

    // Action button branch (3-way):
    //   - missing                         → right Download
    //   - installed, version up-to-date   → right Play
    //   - installed, upgrade available    → LEFT Update + right Play
    // The right-side Download stays hidden for installed apps because
    // the upgrade-install button lives on the LEFT for that case, by
    // design (gives the user a visual hint that "the download here
    // means 'replace', not 'install fresh'"). All three are toggled
    // via classList so the live-DOM cache invalidates correctly (same
    // reason as the overlay open/close).
    // Install-size chip (LEFT slot). Populated from `detail.sizeBytes`
    // (catalogue.json). Visibility-toggled via the `--visible` class so
    // the empty-state collapse matches the surrounding button toggles
    // (textContent + a hide-when-empty CSS gate would work, but the
    // class flip keeps the rule self-documenting and lets the cascade
    // gate the flex gap when the chip is hidden).
    var appSizeBytes = (typeof currentDetail.sizeBytes === 'number'
      && isFinite(currentDetail.sizeBytes) && currentDetail.sizeBytes > 0)
      ? currentDetail.sizeBytes : 0;
    if (sizeEl) {
      var sizeText = formatSizeMB(appSizeBytes);
      if (sizeText) {
        sizeEl.textContent = sizeText;
        sizeEl.classList.add('app-modal-size--visible');
      } else {
        sizeEl.textContent = '';
        sizeEl.classList.remove('app-modal-size--visible');
      }
    }

    // Surface the shared Expand row when EITHER the Expand button (present
    // only when there's a description) or the install-size chip is showing;
    // hide it only when both are absent so we never leave an empty
    // 14px-margin strip under the description. Runs after the size chip is
    // populated so the `--visible` class reflects this app.
    if (expandRow) {
      var sizeVisible = !!(sizeEl && sizeEl.classList.contains('app-modal-size--visible'));
      if (hasDescription || sizeVisible) expandRow.classList.remove('app-modal-expand-row--hidden');
      else expandRow.classList.add('app-modal-expand-row--hidden');
    }

    // (The device SD free-space chip + insufficient-space disable gate
    // were removed — the modal no longer surfaces free space, and
    // Download / Update stay enabled. A genuinely full disk now surfaces
    // as a write error in the download modal instead of a pre-emptive
    // silent disable.)

    var hasUpgrade = !!(currentDetail.installedVersion && currentDetail.version);
    if (currentDetail.missing) {
      playBtn.classList.add('app-modal-btn--hidden');
      playBtn.removeAttribute('href');
      pendingLaunchUrl = '';
      downloadBtn.classList.remove('app-modal-btn--hidden');
      updateBtn.classList.add('app-modal-btn--hidden');
      // Not installed → no Delete, no shortcut (embed/link both need the app).
      if (deleteBtn) deleteBtn.classList.add('app-modal-btn--hidden');
      if (forwarderBtn) forwarderBtn.classList.add('app-modal-btn--hidden');
    } else {
      // Warnings gate. When the catalog's permissions list contains
      // one or more keys that map to a warnings.json entry, we DON'T
      // stamp the href on the play <a> — that's the only mechanism
      // the engine's findTapIntent uses to fire navigate, so a
      // missing href silently blocks the standard nav path. The
      // click listener below then takes over: reads pendingLaunchUrl
      // and routes the tap into the warnings modal. When no
      // permissions match (or the warnings table failed to load and
      // the matcher returns []), we set the href as before and the
      // engine navigates directly without JS in the middle.
      var url = currentDetail.url || '';
      var matcher = globalThis.__brewserGetWarningsForPermissions;
      var matched = (typeof matcher === 'function')
        ? matcher(currentDetail.permissions || '')
        : [];
      if (matched.length > 0 && url) {
        playBtn.removeAttribute('href');
        pendingLaunchUrl = url;
      } else {
        playBtn.setAttribute('href', url);
        pendingLaunchUrl = '';
      }
      playBtn.classList.remove('app-modal-btn--hidden');
      downloadBtn.classList.add('app-modal-btn--hidden');
      if (hasUpgrade) {
        updateBtn.classList.remove('app-modal-btn--hidden');
      } else {
        updateBtn.classList.add('app-modal-btn--hidden');
      }
      // Installed → offer Delete (uninstall) + Create shortcut in the LEFT slot.
      if (deleteBtn) deleteBtn.classList.remove('app-modal-btn--hidden');
      if (forwarderBtn) forwarderBtn.classList.remove('app-modal-btn--hidden');
    }

    // Always open in the collapsed view — the expanded reading state is a
    // transient per-read toggle, not a sticky preference across opens.
    setExpanded(false);

    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
  }

  function close() {
    overlay.classList.remove('app-modal-overlay--open');
    modalOpen = false;
    currentDetail = null;
    // Drop the expanded class so a lingering `--expanded` state can't ride
    // into the next open (show() also resets, but keep close() self-clean).
    setExpanded(false);
    // Drop any pending offline toast so it doesn't ride the next
    // open. The timer is also cancelled so it can't fire into a
    // closed modal.
    clearOfflineToast();
  }

  // Every catalog card (installed AND missing) carries data-app-detail
  // now — the modal is the universal tap target. Selecting on
  // `[data-app-detail]` keeps the same shape regardless of missing state;
  // the branch is `currentDetail.missing` inside show().
  //
  // Wiring is per-card (LiveElement has no event delegation), so cards that
  // apps-pagination.js swaps into the grid AFTER load would have no tap
  // handler. `wireAppCards` is therefore idempotent (skips already-wired cards
  // via `data-tap-wired`) and re-exposed on globalThis so the pager can call it
  // after each page swap.
  function wireAppCards() {
    var cards = document.querySelectorAll('[data-app-detail]');
    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        if (card.getAttribute('data-tap-wired')) return;
        card.setAttribute('data-tap-wired', '1');
        card.addEventListener('click', function (e) {
          var raw = card.getAttribute('data-app-detail');
          var detail = {};
          if (raw) {
            try { detail = JSON.parse(raw); } catch (_) { /* fall through */ }
          }
          show(detail);
          if (e && e.preventDefault) e.preventDefault();
          if (e && e.stopPropagation) e.stopPropagation();
        });
      })(cards[i]);
    }
  }
  wireAppCards();
  globalThis.__brewserWireAppCards = wireAppCards;

  cancelBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Expand / Collapse the description. stopPropagation keeps the tap from
  // bubbling to the overlay backdrop close handler.
  if (expandBtn) {
    expandBtn.addEventListener('click', function (e) {
      setExpanded(!descExpanded);
      if (e && e.stopPropagation) e.stopPropagation();
    });
  }

  // Arm the shell's black "Loading <name>" launch splash. The click
  // dispatch runs BEFORE the engine's findTapIntent fires the navigate
  // (see warnings-modal.js), so the name is in place when navigateTo
  // reads it. Best-effort — a shell build without the hook just launches
  // without the splash.
  function armLaunchSplash(name) {
    try {
      console.debug('[launch-splash-page] arm attempt name=' + String(name == null ? '' : name)
        + ' hook=' + (typeof globalThis.__brewserArmLaunchSplash));
      if (typeof globalThis.__brewserArmLaunchSplash === 'function') {
        globalThis.__brewserArmLaunchSplash(String(name == null ? '' : name));
      }
    } catch (_) { /* no-op */ }
  }

  // Play (Launch) click → warnings-modal handoff when applicable.
  // pendingLaunchUrl is set in show() ONLY when this detail's
  // permissions contain matches in warnings.json AND the href was
  // therefore deliberately left off. Else this branch is empty and
  // the engine's findTapIntent walks up to the play <a>'s href and
  // navigates directly — no JS path in the middle. stopPropagation
  // keeps the click from bubbling to the overlay backdrop close
  // handler (target === overlay test would fail anyway, but belt +
  // suspenders for the launch flow).
  playBtn.addEventListener('click', function (e) {
    if (!pendingLaunchUrl) {
      // Direct launch (no permission warnings): the engine navigates via
      // the play <a>'s href right after this listener. Arm the splash so
      // the shell covers the load with "Loading <name>".
      armLaunchSplash(currentDetail && currentDetail.name);
      return;
    }
    // Warnings path: we open the warnings modal instead of launching now,
    // so do NOT arm here — the warnings modal arms on its own Launch.
    var opener = globalThis.__brewserOpenWarningsModal;
    if (typeof opener !== 'function') {
      console.debug('[apps] warnings-modal not loaded; falling through');
      return;
    }
    opener(currentDetail || {}, { url: pendingLaunchUrl });
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Hand off to download-modal.js — it owns the artifact-manifest
  // fetch + per-file download loop and surfaces progress / errors in
  // its own overlay. We close this modal first so the two cards
  // don't stack visually. No URLs cross this boundary: the download
  // modal resolves everything from the cached normalized catalogue via
  // the platform bridge.
  function openDownload(mode) {
    var detail = currentDetail;
    var opener = globalThis.__brewserOpenDownloadModal;
    if (typeof opener !== 'function') {
      console.debug('[apps] download-modal not loaded; skipping ' + mode);
      return;
    }
    close();
    opener(detail || {}, { mode: mode });
  }

  downloadBtn.addEventListener('click', function (e) {
    openDownload('download');
    if (e && e.stopPropagation) e.stopPropagation();
  });
  updateBtn.addEventListener('click', function (e) {
    openDownload('update');
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Hand off to delete-modal.js — it owns the recursive per-file
  // uninstall + progress bar and reloads the grid on success. Close
  // this modal first so the two cards don't stack (same pattern as
  // openDownload). The delete modal resolves the app dir from the id.
  function openDelete() {
    var detail = currentDetail;
    var opener = globalThis.__brewserOpenDeleteModal;
    if (typeof opener !== 'function') {
      console.debug('[apps] delete-modal not loaded; skipping delete');
      return;
    }
    close();
    opener(detail || {});
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', function (e) {
      openDelete();
      if (e && e.stopPropagation) e.stopPropagation();
    });
  }

  // Hand off to forwarder-modal.js — it owns the confirmation dialog +
  // on-device generation. Close this modal first so the cards don't stack
  // (same pattern as openDownload / openDelete).
  function openForwarder() {
    var detail = currentDetail;
    var opener = globalThis.__brewserOpenForwarderModal;
    if (typeof opener !== 'function') {
      console.debug('[apps] forwarder-modal not loaded; skipping shortcut');
      return;
    }
    close();
    opener(detail || {});
  }
  if (forwarderBtn) {
    forwarderBtn.addEventListener('click', function (e) {
      openForwarder();
      if (e && e.stopPropagation) e.stopPropagation();
    });
  }

  // Backdrop tap → close. Filter on `e.target === overlay` so a tap
  // landing inside the card (which bubbles up through the overlay)
  // doesn't close it.
  overlay.addEventListener('click', function (e) {
    if (e && e.target === overlay) close();
  });

  // No-op window-level mousedown listener: page-mouse-forwarder.ts
  // gates B → contextmenu routing on `pageHasListenerFor('mousedown' | …)`.
  // Without any window-level mouse listener, B is dispatched as the
  // shell `rightClick` action (a no-op outside pages) and we never see
  // the contextmenu event. The empty handler is enough to flip the gate.
  window.addEventListener('mousedown', function () { /* gate */ });

  // B (default rightClick) closes the modal. page-mouse-forwarder
  // dispatches `contextmenu` on B-rising-then-falling when the cursor
  // is outside the chrome strip and a page mouse listener exists; we
  // installed one just above. preventDefault keeps the (no-op) shell
  // contextmenu path from doing anything else.
  //
  // `_brewserHandled` handshake: the permissions-warning modal sits on
  // top of this one when an app's permissions trigger a warning. Its
  // contextmenu listener fires FIRST (loaded earlier in the script
  // chain), sets the flag, and closes itself. We bail when the flag
  // is set so a single B press peels off only the top modal, leaving
  // the app modal visible. A second B then closes this modal as usual.
  window.addEventListener('contextmenu', function (e) {
    if (e && e._brewserHandled) return;
    if (!modalOpen) return;
    close();
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // L (default `back`) → the shell dispatches a synthetic `Escape`
  // keydown when any page keydown listener exists (browser-shell.ts
  // ~L762). Calling preventDefault() signals the shell not to also
  // navigate back, so the modal-open press only closes the modal and
  // a follow-up press still works for normal back nav.
  //
  // Same `_brewserHandled` handshake as the contextmenu listener
  // above — the warnings modal's L handler peels off the top layer
  // first and flags the event so this listener leaves the app modal
  // alone.
  window.addEventListener('keydown', function (e) {
    if (e && e._brewserHandled) return;
    if (!modalOpen) return;
    var key = e && e.key;
    if (key === 'Escape' || key === 'Esc') {
      close();
      if (e && e.preventDefault) e.preventDefault();
    }
  });
})();
