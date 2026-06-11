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
  var downloadBtn = document.getElementById('app-modal-download');
  if (!overlay || !titleEl || !bodyEl || !cancelBtn || !downloadBtn) return;

  var modalOpen = false;
  var currentDetail = null;

  // Default download glyph — used when the catalog entry doesn't carry
  // a logo URL we can resolve (or carries the placeholder we already
  // emit for missing entries). Same asset the grid card paints.
  var DEFAULT_LOGO_URL = 'brewser://assets/download.png';

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
    // selector matches.
    if (versionEl) versionEl.textContent = currentDetail.version ? 'v' + currentDetail.version : '';
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
    // field from catalog.json entirely (renderer drops null/undefined
    // before stringifying).
    rows.push(rowOrDash('Allowed origins', currentDetail.allowedOrigins));
    if (currentDetail.developer) rows.push(row('Developer', currentDetail.developer));
    if (currentDetail.source) rows.push(row('Source', currentDetail.source));
    bodyEl.innerHTML = rows.join('');

    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
  }

  function close() {
    overlay.classList.remove('app-modal-overlay--open');
    modalOpen = false;
    currentDetail = null;
  }

  var cards = document.querySelectorAll('[data-missing]');
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

  // Stubbed for now — actual download flow lands in a later turn. The
  // console.debug surfaces in `nxjs-debug.log` so we can confirm taps
  // are landing while wiring it up.
  downloadBtn.addEventListener('click', function (e) {
    console.debug('[apps] download stub for ' + (currentDetail && currentDetail.id));
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
