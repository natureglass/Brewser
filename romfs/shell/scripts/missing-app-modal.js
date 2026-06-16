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
  // SD-free chip — read each time the modal opens via
  // `Switch.FileSystem.openSdmc().freeSpace()` so the figure stays
  // fresh across installs. When the free space is less than the
  // catalog's `sizeBytes`, the chip flips into a red warning palette
  // AND we disable the Download / Update buttons.
  var sdFreeEl = document.getElementById('app-modal-sd-free');
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

  // Render a row with an em-dash when value is empty so the row is
  // still legible (matches the "intentionally unset" cue we want for
  // `allowed_origins: []`). Returns empty string for null/undefined so
  // a totally-absent field in the catalog suppresses its row instead.
  function rowOrDash(label, value) {
    if (value == null) return '';
    var s = String(value).trim();
    return row(label, s.length > 0 ? s : '—');
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

  // Smart byte formatter for SD card free space. Mirrors the sensors
  // app helper: GB with one decimal when >= 1 GB, MB without decimals
  // otherwise (`X MB` reads cleaner than `0.X GB` for small values).
  // Switch's microSD slot can hold up to 2 TB so MB granularity is
  // unnecessary at the top end; keep the rule simple.
  function formatBytesSmart(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    var gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    var mb = bytes / (1024 * 1024);
    return mb.toFixed(0) + ' MB';
  }

  // Read the sdmc free space via the nx.js FileSystem API. Returns
  // -1 on error (Switch global missing, FS open failed, runtime
  // type mismatch) so the caller can branch and treat "unknown" the
  // same as "skip the disable gate" — preferable to a hard refusal
  // when the syscall fails for any non-app reason.
  //
  // `freeSpace()` returns a BigInt on real hardware; cast to Number
  // for the comparison/format math. Switch SD cards top out at 2 TB
  // (~2.2e12 bytes), well under Number.MAX_SAFE_INTEGER, so no
  // precision loss in the conversion.
  function getSdFreeBytes() {
    try {
      if (typeof Switch === 'undefined' || !Switch || !Switch.FileSystem) return -1;
      var fs = Switch.FileSystem.openSdmc();
      if (!fs || typeof fs.freeSpace !== 'function') return -1;
      var v = Number(fs.freeSpace());
      return Number.isFinite(v) && v >= 0 ? v : -1;
    } catch (err) {
      console.debug('[apps] sdFree read failed: ' + (err && err.message ? err.message : String(err)));
      return -1;
    }
  }

  // Format an integer with thousands separators ("1234" → "1,234"). The
  // catalog of downloaded apps is small today but the field can grow
  // unbounded — formatting keeps four-and-five-digit counts readable.
  function formatCount(n) {
    var s = String(n | 0);
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
    var spacer = '<span style="display:inline-block;width:5px;height:1px;"></span>';
    var html = '<span class="app-modal-rating-average">' + formatAverage(avg) + '</span>';
    html += spacer;
    for (var i = 0; i < 5; i++) {
      var src;
      if (halves >= (i + 1) * 2) src = 'brewser://assets/star_full.png';
      else if (halves === i * 2 + 1) src = 'brewser://assets/star_half.png';
      else src = 'brewser://assets/star_empty.png';
      html += '<img class="app-modal-star" style="width:' + STAR_PX + 'px;height:' + STAR_PX + 'px;" src="' + src + '" alt="">';
    }
    html += spacer;
    html += '<span class="app-modal-stats-count">(' + formatCount(count) + ')</span>';
    return html;
  }

  // The Downloads + Rating rows that get prepended to the body row
  // stack on every show(). Stamped with IDs so the async fetch can
  // re-query and update them after the JSONs land. Uses the same
  // `.app-modal-row` / `.app-modal-row-label` / `.app-modal-row-value`
  // markup as the metadata rows below so labels line up across the
  // whole list. `.app-modal-rating-value` adds flex alignment for the
  // star <img>s + trailing count span.
  function statsRowsHtml() {
    return '<div class="app-modal-row">'
      + '<span class="app-modal-row-label">Downloads</span>'
      + '<span id="app-modal-downloads" class="app-modal-row-value">' + formatCount(0) + '</span>'
      + '</div>'
      + '<div class="app-modal-row">'
      + '<span class="app-modal-row-label">Rating</span>'
      + '<span id="app-modal-rating" class="app-modal-row-value app-modal-rating-value">'
      + renderStarsHtml(0, 0)
      + '</span>'
      + '</div>';
  }

  // Token guard for stats fetches. Bumped on every show(); the async
  // fetch checks the captured value before writing into the DOM so a
  // fast modal-swap (open A, close, open B before A's fetch resolves)
  // can't paint A's stats into B's modal.
  var statsToken = 0;

  function loadStats(appId) {
    var myToken = ++statsToken;
    if (!appId) return;
    var dlPromise = globalThis.fetch('configs/downloads.json')
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .catch(function () { return null; });
    var rtPromise = globalThis.fetch('configs/ratings.json')
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .catch(function () { return null; });
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
      if (rtEl) {
        if (entry) {
          var avg = (typeof entry.average === 'number' && isFinite(entry.average)) ? entry.average : 0;
          var c = (typeof entry.count === 'number' && isFinite(entry.count)) ? entry.count : 0;
          rtEl.innerHTML = renderStarsHtml(avg, c);
        } else {
          rtEl.innerHTML = renderStarsHtml(0, 0);
        }
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

    if (descEl) descEl.textContent = currentDetail.description || '';

    // Detail rows in the order requested: category → features →
    // permissions → allowed_origins → developer → source. Identifier
    // used to lead this list but now lives in the header column (see
    // identifierEl above) so the modal surfaces it next to the logo.
    // Version + license are shown as chips in the meta strip, so we
    // don't repeat them here either.
    var rows = [];
    // Downloads + Rating sit at the top of the row stack so the user
    // sees popularity + score before the metadata fields. Initial render
    // is the 0 / 5-empty-stars placeholder; loadStats() rewrites the
    // value spans once the configs land.
    rows.push(statsRowsHtml());
    if (currentDetail.category) rows.push(row('Category', currentDetail.category));
    if (currentDetail.features) rows.push(row('Features', currentDetail.features));
    if (currentDetail.permissions) rows.push(row('Permissions', currentDetail.permissions));
    // `allowed_origins: []` (deliberate "no external fetches") and an
    // absent field both round-trip through the renderer as the same
    // empty string — show the row with an em-dash in that case so
    // the modal still surfaces the field instead of silently dropping
    // it. Callers that genuinely want the row hidden can omit the
    // field from catalogue.json entirely (renderer drops null/undefined
    // before stringifying).
    rows.push(rowOrDash('Allowed origins', currentDetail.allowedOrigins));
    if (currentDetail.developer) rows.push(row('Developer', currentDetail.developer));
    if (currentDetail.source) rows.push(row('Source', currentDetail.source));
    bodyEl.innerHTML = rows.join('');

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

    // SD free-space chip + Download/Update gate. Read each open so the
    // figure stays fresh after installs. `freeBytes === -1` means the
    // syscall failed for some non-app reason (Switch global missing
    // when running outside nx.js, FS open errored, etc.) — treat that
    // as "unknown" and skip the disable gate rather than block the
    // user on a transient failure. When the figure IS known but is
    // less than `appSizeBytes`, paint the chip red and disable both
    // install paths (right-side Download + left-side Update).
    var freeBytes = getSdFreeBytes();
    var insufficient = (appSizeBytes > 0 && freeBytes >= 0 && freeBytes < appSizeBytes);
    if (sdFreeEl) {
      if (freeBytes >= 0) {
        sdFreeEl.textContent = 'Free: ' + formatBytesSmart(freeBytes);
        sdFreeEl.classList.add('app-modal-size--visible');
        if (insufficient) {
          sdFreeEl.classList.add('app-modal-size--warn');
        } else {
          sdFreeEl.classList.remove('app-modal-size--warn');
        }
      } else {
        sdFreeEl.textContent = '';
        sdFreeEl.classList.remove('app-modal-size--visible');
        sdFreeEl.classList.remove('app-modal-size--warn');
      }
    }
    // Disable the install buttons via the `disabled` attribute (the
    // CSS rule `[disabled]` paints them in a muted palette) AND drop
    // them off the keyboard-tap path by mirroring with a class so the
    // click handler can branch without re-reading the attribute every
    // tap. `disabled` on a `<button>` already suppresses the native
    // click event in real browsers, but the live-DOM dispatcher
    // doesn't honour that gate today — the JS check below is the
    // belt-and-suspenders.
    if (insufficient) {
      downloadBtn.setAttribute('disabled', '');
      updateBtn.setAttribute('disabled', '');
      downloadBtn.classList.add('app-modal-btn--disabled');
      updateBtn.classList.add('app-modal-btn--disabled');
    } else {
      downloadBtn.removeAttribute('disabled');
      updateBtn.removeAttribute('disabled');
      downloadBtn.classList.remove('app-modal-btn--disabled');
      updateBtn.classList.remove('app-modal-btn--disabled');
    }

    var hasUpgrade = !!(currentDetail.installedVersion && currentDetail.version);
    if (currentDetail.missing) {
      playBtn.classList.add('app-modal-btn--hidden');
      playBtn.removeAttribute('href');
      pendingLaunchUrl = '';
      downloadBtn.classList.remove('app-modal-btn--hidden');
      updateBtn.classList.add('app-modal-btn--hidden');
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
    }

    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
  }

  function close() {
    overlay.classList.remove('app-modal-overlay--open');
    modalOpen = false;
    currentDetail = null;
  }

  // Every catalog card (installed AND missing) carries data-app-detail
  // now — the modal is the universal tap target. Selecting on
  // `[data-app-detail]` keeps the same delegation shape regardless of
  // missing state; the branch is `currentDetail.missing` inside show().
  var cards = document.querySelectorAll('[data-app-detail]');
  for (var i = 0; i < cards.length; i++) {
    (function (card) {
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

  cancelBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

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
    if (!pendingLaunchUrl) return;
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
  // don't stack visually. `data-catalogue-url` + `data-artifacts-url`
  // are stamped on the buttons server-side from `config.json` via
  // the `<browser-config-catalogue/>` + `<browser-config-artifacts/>`
  // tags.
  function openDownload(mode) {
    var detail = currentDetail;
    var opener = globalThis.__brewserOpenDownloadModal;
    if (typeof opener !== 'function') {
      console.debug('[apps] download-modal not loaded; skipping ' + mode);
      return;
    }
    var btn = mode === 'update' ? updateBtn : downloadBtn;
    // Respect the insufficient-SD-space gate. The live-DOM dispatcher
    // doesn't honour the native `disabled` attribute, so the click
    // still reaches here — silently swallow when the button is
    // disabled rather than fire the download with an empty drive.
    if (btn && btn.classList && btn.classList.contains('app-modal-btn--disabled')) {
      console.debug('[apps] ' + mode + ' tap ignored — insufficient SD free space');
      return;
    }
    var catalogueUrl = (btn && btn.getAttribute && btn.getAttribute('data-catalogue-url')) || '';
    var artifactsUrl = (btn && btn.getAttribute && btn.getAttribute('data-artifacts-url')) || '';
    close();
    opener(detail || {}, {
      mode: mode,
      catalogueUrl: catalogueUrl,
      artifactsUrl: artifactsUrl,
    });
  }

  downloadBtn.addEventListener('click', function (e) {
    openDownload('download');
    if (e && e.stopPropagation) e.stopPropagation();
  });
  updateBtn.addEventListener('click', function (e) {
    openDownload('update');
    if (e && e.stopPropagation) e.stopPropagation();
  });

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
