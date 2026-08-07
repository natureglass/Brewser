// Permission-warnings modal — opened by missing-app-modal.js when an
// app's `permissions` field contains one or more keys that match an
// entry in `configs/warnings.json`. Sits on top of the app-detail modal
// (the app modal stays open behind this one — Cancel just dismisses the
// warnings modal; Launch closes it and lets the engine navigate to the
// app URL).
//
// Public surface (installed on globalThis at load time so
// missing-app-modal.js can call into us regardless of script load
// order between pages):
//   __brewserGetWarningsForPermissions(permissionsStr) -> matched[]
//   __brewserOpenWarningsModal(detail, { url })       -> void
//
// `permissionsStr` is the comma-joined display string the catalog
// loader emits into `data-app-detail` (see joinStringArray in
// src/profile/browser-toolbar.ts) — e.g. `"network, storage"`.
//
// Visibility is class-driven via `.app-modal-overlay--open` (same flip
// the missing-app + updates + download modals use), NOT
// `style.display`. The InlineStyle setter on LiveElement.style is a
// plain field write that doesn't invalidate the paint cache; only
// classList mutations chain through invalidateLiveStyle +
// bumpLiveTreeVersion + markLiveDirty.
//
// The Launch button is an `<a role="button">` whose href is stamped at
// open time from the captured URL. On tap, the click listener closes
// this modal synchronously THEN the engine's `findTapIntent` (called
// after click dispatch in live-input-dispatch.ts) walks up the still-
// present <a href> and fires a navigate intent. `preventDefault()` on
// the engine side is a no-op for tap navigation — removing the href is
// the actual gate, and we don't want to remove it here because we
// WANT navigation; the close-then-let-engine-navigate flow is correct.

(function () {
  var overlay = document.getElementById('warnings-modal-overlay');
  var listEl = document.getElementById('warnings-modal-list');
  var cancelBtn = document.getElementById('warnings-modal-cancel');
  var launchBtn = document.getElementById('warnings-modal-launch');
  if (!overlay || !listEl || !cancelBtn || !launchBtn) {
    console.debug('[warnings-modal] init aborted; missing node(s): '
      + ' overlay=' + !!overlay + ' list=' + !!listEl
      + ' cancel=' + !!cancelBtn + ' launch=' + !!launchBtn);
    return;
  }

  // Warning table loaded from the on-disk `configs/warnings.json`. Read
  // SYNCHRONOUSLY by absolute sdmc path at script load and cached; any
  // miss leaves the table null and the matcher returns an empty array —
  // the launch path then proceeds without opening this modal (safe
  // fallback on a missing/broken file).
  //
  // Why not `fetch('configs/warnings.json')` (as before): from the
  // catalog page `brewser://home/` that relative URL resolves to the
  // bogus `brewser://home/configs/warnings.json` — the log's "unknown
  // brewser:// page" — so the fetch always failed, the table stayed
  // null, and NO permission warning ever showed before launch. The
  // brewser:// loader also only routes `apps/` to the app root, so even
  // an absolute `brewser://configs/…` would miss (it maps under the
  // `shell/` tree, where configs don't live). Reading the absolute sdmc
  // path directly fixes both — and being synchronous also closes the old
  // fetch-vs-tap race where a fast launch tap beat the async load.
  var warningTable = null;
  (function loadWarningTable() {
    if (typeof Switch === 'undefined' || !Switch || typeof Switch.readFileSync !== 'function') return;
    try {
      var raw = Switch.readFileSync('sdmc:/switch/brewser/configs/warnings.json');
      if (!raw || !raw.byteLength) return;
      // The JSON shape is `{ "Permissions": { "<key>": { description,
      // warning, risk }, … } }`. Flatten one level so the matcher just
      // looks up `table[key]`. Falls back to the top-level object if
      // someone removes the `Permissions` wrapper later.
      var j = JSON.parse(new TextDecoder().decode(raw));
      if (j && typeof j === 'object') {
        warningTable = (j.Permissions && typeof j.Permissions === 'object') ? j.Permissions : j;
        console.debug('[warnings-modal] table loaded: ' + Object.keys(warningTable).length + ' entries');
      }
    } catch (err) {
      console.debug('[warnings-modal] warnings.json read failed: '
        + (err && err.message ? err.message : String(err)));
    }
  })();

  // User-configured severity gate (`config.warnings`). Stamped onto
  // `<body data-warnings>` by browser-resource-loader's
  // `<browser-config-warnings>` expansion (comma-separated list of
  // enabled severities). Read synchronously at script load so
  // getMatchedWarnings always sees the user's current gate — the prior
  // `fetch('configs/config.json')` path was exposed to a fetch-vs-tap
  // race that could let stale defaults filter the first launch tap.
  // Missing attribute (older page, fresh install pre-stamp) → fall
  // back to all-three "show everything"; missing attr is NOT the same
  // as empty string (the empty-string case is the user explicitly
  // opting out of every severity, which we honor literally).
  var enabledRisks = (function () {
    var raw = (document.body && document.body.getAttribute('data-warnings'));
    if (raw == null) return { low: true, medium: true, high: true };
    var next = { low: false, medium: false, high: false };
    var parts = String(raw).split(',');
    for (var i = 0; i < parts.length; i++) {
      var v = parts[i].trim();
      if (v === 'low' || v === 'medium' || v === 'high') next[v] = true;
    }
    console.debug('[warnings-modal] enabled risks: '
      + 'low=' + next.low + ' medium=' + next.medium + ' high=' + next.high);
    return next;
  })();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Split the catalog's comma-joined permissions string into trimmed
  // keys, dropping empties. Accepts comma + optional whitespace so
  // both `"network, storage"` (the canonical join) and `"network,storage"`
  // (a hand-edited manifest) round-trip cleanly.
  function splitPermissions(permStr) {
    if (typeof permStr !== 'string' || permStr.length === 0) return [];
    var parts = permStr.split(',');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var k = parts[i].trim();
      if (k.length > 0) out.push(k);
    }
    return out;
  }

  // Risk → sort weight. Higher number = higher priority, sorted to
  // the top. Unknown / missing risks land at 0 so they sink below
  // known-severity entries — surfacing a "could be anything" warning
  // above a "definitely high-risk" one would mislead the user.
  var RISK_WEIGHT = { high: 3, medium: 2, low: 1 };

  function getMatchedWarnings(permStr) {
    if (!warningTable) return [];
    var keys = splitPermissions(permStr);
    if (keys.length === 0) return [];
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var entry = warningTable[key];
      if (entry && typeof entry === 'object' && typeof entry.warning === 'string') {
        var risk = typeof entry.risk === 'string' ? entry.risk : '';
        // Severity gate: drop entries whose risk is one of the three
        // gated severities but unchecked in Settings. Unknown-risk
        // entries (empty string or an out-of-set value) always pass —
        // hiding them silently on a malformed warnings.json edit would
        // be worse than showing them uncategorized.
        if ((risk === 'low' || risk === 'medium' || risk === 'high')
          && !enabledRisks[risk]) continue;
        out.push({
          key: key,
          risk: risk,
          description: typeof entry.description === 'string' ? entry.description : '',
          warning: entry.warning,
        });
      }
    }
    // Sort high → medium → low. Stable order within the same risk
    // level: ties resolve to the original catalog order (Array.sort
    // is stable in ES2019+ which is what swb's runtime targets), so
    // two `medium`-risk permissions stay in their declared sequence.
    out.sort(function (a, b) {
      var wa = RISK_WEIGHT[a.risk] || 0;
      var wb = RISK_WEIGHT[b.risk] || 0;
      return wb - wa;
    });
    return out;
  }

  // Risk → heading color (green/orange/red). Inline-applied via the
  // `style="color: …"` attribute on the heading element rather than
  // relying on the BEM `.warnings-modal-row-head--<risk>` cascade —
  // in this engine the explicit attribute lands more reliably than a
  // multi-class rule cascade through the live-CSS resolver (same
  // workaround the star-row uses for explicit pixel widths). The CSS
  // rules are also kept as a belt + suspenders so removing the inline
  // style later still produces colored headings.
  var RISK_COLOR = {
    low: '#7eda9f',
    medium: '#ffb86b',
    high: '#ff8676',
  };

  function renderRow(w) {
    // Heading reads "NETWORK - MEDIUM" as a single colored line. The
    // risk modifier class also lands so the cascade-driven rules apply
    // if/when the engine resolves them; the inline color above wins
    // when both are present, which is the intended source of truth.
    // Unknown risk drops the suffix + modifier + inline color so a
    // malformed entry just shows the key in the default heading color
    // rather than mislabeling severity.
    var headClass = 'warnings-modal-row-head';
    var headText = esc(w.key.toUpperCase());
    var headStyle = '';
    if (RISK_COLOR[w.risk]) {
      headClass += ' warnings-modal-row-head--' + esc(w.risk);
      headText += ' - ' + esc(w.risk.toUpperCase());
      headStyle = ' style="color:' + RISK_COLOR[w.risk] + ';"';
    }
    return '<div class="warnings-modal-row">'
      + '<div class="' + headClass + '"' + headStyle + '>' + headText + '</div>'
      + '<p class="warnings-modal-row-warning">' + esc(w.warning) + '</p>'
      + '</div>';
  }

  var modalOpen = false;
  // App display name captured at open() so the Launch listener can arm the
  // shell's "Loading <name>" splash for the launch that follows.
  var launchName = '';

  // Arm the shell's black launch splash. Best-effort; a build without the
  // hook just launches without it. Mirrors the helper in missing-app-modal.js.
  function armLaunchSplash(name) {
    try {
      if (typeof globalThis.__brewserArmLaunchSplash === 'function') {
        globalThis.__brewserArmLaunchSplash(String(name == null ? '' : name));
      }
    } catch (_) { /* no-op */ }
  }

  function open(detail, options) {
    var opts = options || {};
    var url = typeof opts.url === 'string' ? opts.url : '';
    launchName = (detail && detail.name) ? String(detail.name) : '';
    var matched = getMatchedWarnings(detail && detail.permissions);
    if (matched.length === 0) {
      // Caller is expected to have checked first via
      // __brewserGetWarningsForPermissions, but guard anyway — surfacing
      // an empty warnings modal would be confusing.
      console.debug('[warnings-modal] open() called with no matches; ignoring');
      return;
    }
    listEl.innerHTML = matched.map(renderRow).join('');
    // Stamp the captured URL onto the Launch <a> so the engine's
    // findTapIntent walks up to it on tap and fires navigate. Empty
    // URL means the catalog entry had no `entry` field — leave the
    // attribute off so the tap silently no-ops rather than navigating
    // to a broken brewser:// URL.
    if (url) launchBtn.setAttribute('href', url);
    else launchBtn.removeAttribute('href');
    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
  }

  function close() {
    if (!modalOpen) return;
    overlay.classList.remove('app-modal-overlay--open');
    modalOpen = false;
  }

  cancelBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Launch click → close THIS modal synchronously; the engine's
  // findTapIntent runs after click dispatch (live-input-dispatch.ts
  // resolveIntentAndFormTap) and walks up to the <a href> we stamped
  // in open(), firing navigate. We don't preventDefault — that's a
  // no-op for tap-intent navigation, and we WANT the navigation here.
  launchBtn.addEventListener('click', function (e) {
    // Arm the launch splash BEFORE close()/navigate — the shell reads it
    // when findTapIntent fires the navigate right after this click dispatch.
    armLaunchSplash(launchName);
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Backdrop tap → close. Filter `e.target === overlay` so a tap
  // inside the card (which bubbles up) doesn't dismiss the modal.
  overlay.addEventListener('click', function (e) {
    if (e && e.target === overlay) close();
  });

  // Gate flips for page-mouse-forwarder (sibling modals each install
  // one — they all flag the same gate, no conflict).
  window.addEventListener('mousedown', function () { /* gate */ });

  // B (default rightClick) closes only THIS modal — the app modal
  // behind it carries its own contextmenu listener and would otherwise
  // also close on the same press because LiveWindow.dispatchEvent
  // loops every listener regardless of stopPropagation (it's a no-op
  // on synthetic events; see src/scripts/live-dom.ts ~L2446). We
  // mutate the event with a `_brewserHandled` flag so the
  // missing-app-modal listener (registered AFTER ours in script-load
  // order: warnings-modal.js → missing-app-modal.js) can see we
  // already handled this press and bail. Same handshake on L below.
  window.addEventListener('contextmenu', function (e) {
    if (!modalOpen) return;
    if (e) e._brewserHandled = true;
    close();
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // L (synthetic Escape) — same handshake pattern as B above.
  window.addEventListener('keydown', function (e) {
    if (!modalOpen) return;
    var key = e && e.key;
    if (key === 'Escape' || key === 'Esc') {
      if (e) e._brewserHandled = true;
      close();
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
    }
  });

  // Install the public hooks AFTER the matcher + open() are defined.
  // missing-app-modal.js reads __brewserGetWarningsForPermissions on
  // every show() to decide whether to set the play <a>'s href or
  // route the click through this modal instead.
  globalThis.__brewserGetWarningsForPermissions = getMatchedWarnings;
  globalThis.__brewserOpenWarningsModal = open;
  console.debug('[warnings-modal] wired');
})();
