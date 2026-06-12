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

    if (descEl) descEl.textContent = currentDetail.description || '';

    // Detail rows in the order requested: category → features →
    // permissions → allowed_origins → developer → source. Identifier
    // + catalog group sit at the top so the user knows which entry
    // the modal is describing (esp. useful when two groups list an
    // app with the same display name during community/featured
    // promotion). Version + license are already shown as chips in
    // the meta strip so we don't repeat them here.
    var rows = [];
    if (currentDetail.id) rows.push(row('Identifier', currentDetail.id));
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
      downloadBtn.classList.remove('app-modal-btn--hidden');
      updateBtn.classList.add('app-modal-btn--hidden');
    } else {
      // findTapIntent walks ancestors for an <a href>; setting href
      // here means the next tap fires a navigate intent the shell
      // resolves via the standard navigateTo path.
      playBtn.setAttribute('href', currentDetail.url || '');
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
  window.addEventListener('contextmenu', function (e) {
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
  window.addEventListener('keydown', function (e) {
    if (!modalOpen) return;
    var key = e && e.key;
    if (key === 'Escape' || key === 'Esc') {
      close();
      if (e && e.preventDefault) e.preventDefault();
    }
  });
})();
