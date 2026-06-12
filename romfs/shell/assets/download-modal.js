// Download / Update progress modal — opened from the missing-app
// modal's Download (missing app) or Update (installed-but-stale app)
// button. Fetches the per-app artifact manifest from the catalog repo,
// walks its file list, and writes each file under
// `sdmc:/switch/brewser/apps/<group>/<id>/<rel>`. The entry file
// (catalogue.json's `entry`, typically `index.html`) is saved LAST so an
// interrupted download leaves the card flagged as missing — the
// engine's missing-detection check (loadCatalogGroup in
// browser-toolbar.ts) and missing-app-modal.js diff both key on the
// entry file's presence, so re-tapping Download retries cleanly.
//
// API: exposes `globalThis.__brewserOpenDownloadModal(detail, opts)`.
//   `detail`  — the same JSON shape stamped on cards by
//               renderAppCards (id, group, name, version, entry,
//               installedVersion, logo, ...). At minimum needs
//               `id`, `group`, `entry`.
//   `opts.catalogueUrl` — current catalogue URL (we strip the trailing
//               filename to get the base directory for both the
//               artifact manifest fetch and the per-file fetches).
//   `opts.artifactsUrl` — optional GitHub Contents API listing for
//               sanity-checking; ignored when empty.
//   `opts.mode` — 'download' or 'update'; drives the title copy only.
//
// Visibility uses classList on the overlay + card (NEVER inline
// `style.display`) — same live-DOM cache reason as updates-modal.js
// and missing-app-modal.js. See those files for the full rationale.

(function () {
  var overlay = document.getElementById('download-modal-overlay');
  var card = document.getElementById('download-modal-card');
  var titleEl = document.getElementById('download-modal-title');
  var statusEl = document.getElementById('download-modal-status');
  var counterEl = document.getElementById('download-modal-counter');
  // Remaining-megabytes cell on the LEFT of the progress row. Driven
  // by actual bytes pulled off the wire (cumulative `buf.byteLength`)
  // subtracted from the catalog's `sizeBytes`. Optional element —
  // `null` if a page hasn't been redeployed since the markup was added.
  var remainingEl = document.getElementById('download-modal-remaining');
  var progressFill = document.getElementById('download-modal-progress-fill');
  var errorEl = document.getElementById('download-modal-error');
  var cancelBtn = document.getElementById('download-modal-cancel');
  var closeBtn = document.getElementById('download-modal-close');
  if (!overlay || !card || !titleEl || !statusEl || !counterEl
    || !progressFill || !errorEl || !cancelBtn || !closeBtn) {
    console.debug('[download-modal] init aborted; missing node(s):'
      + ' overlay=' + !!overlay + ' card=' + !!card + ' title=' + !!titleEl
      + ' status=' + !!statusEl + ' counter=' + !!counterEl
      + ' progressFill=' + !!progressFill + ' errorEl=' + !!errorEl
      + ' cancelBtn=' + !!cancelBtn + ' closeBtn=' + !!closeBtn);
    return;
  }
  console.debug('[download-modal] wired');

  // Where files are written. Mirrors the engine's `appRoot` (see
  // `BREWSER_APP_ROOT` in src/browser-config.ts) — the same path
  // updates-modal.js seeds logos into and loadCatalogGroup reads from.
  var APP_ROOT = 'sdmc:/switch/brewser/';

  // Same upgrade-arrow polygon used by the grid card / missing-app /
  // updates modals. Kept in sync verbatim so the chip looks identical
  // wherever it appears.
  var UPGRADE_ARROW_SVG_CARD = '<svg class="upgrade-arrow" viewBox="0 0 14 10" width="14" height="10">'
    + '<polygon points="0,4 8,4 8,1 14,5 8,9 8,6 0,6" fill="#0b1220"/>'
    + '</svg>';

  var modalOpen = false;
  var inFlight = false;
  // Cancellation flag. `close()` sets it so the in-flight install
  // loop bails out at the next await boundary. Without this, tapping
  // Cancel during a download of a multi-GB app (e.g. pvzge ~1.2 GB)
  // leaves the loop running in the background — each iteration still
  // does a `Switch.writeFileSync` (SYNCHRONOUS, blocks the JS thread
  // for tens of MB) and a `setProgress` (DOM mutation that dirties
  // the live-DOM cache → repaint). User-visible symptom: mouse
  // cursor lags and FPS drops below 20 until every remaining file
  // has been fetched + written. `runInstall` resets this back to
  // false at the start of each install so a re-tapped Download
  // after a cancel starts fresh.
  var cancelled = false;

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
  // a trailing slash. Same helper updates-modal.js uses — the catalog
  // URL points at `catalogue.json`, the per-app asset URLs live alongside
  // it under `apps/<group>/<id>/`.
  function catalogueBaseUrl(url) {
    var idx = url.lastIndexOf('/');
    if (idx < 0) return url;
    return url.slice(0, idx + 1);
  }

  function parentDir(path) {
    var idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(0, idx) : '';
  }

  function setLoading() {
    card.classList.add('download-modal-card--loading');
    card.classList.remove('download-modal-card--error');
    card.classList.remove('download-modal-card--success');
    errorEl.innerHTML = '';
  }

  function setError(message) {
    card.classList.remove('download-modal-card--loading');
    card.classList.remove('download-modal-card--success');
    card.classList.add('download-modal-card--error');
    var safe = String(message == null ? 'Unknown error' : message);
    errorEl.innerHTML = '<span>' + escapeHtml(safe) + '</span>';
    statusEl.innerHTML = 'Download failed.';
  }

  function setSuccess(message) {
    card.classList.remove('download-modal-card--loading');
    card.classList.remove('download-modal-card--error');
    card.classList.add('download-modal-card--success');
    statusEl.innerHTML = escapeHtml(message);
  }

  // Format a megabyte figure with two decimals. Shared by the
  // remaining-MB cell whether we're showing "Remaining" (catalog
  // sizeBytes known) or "Downloaded" (catalog omitted size, falls
  // back to cumulative downloaded). Two decimals matches the
  // missing-app modal's size chip so the two figures read the same.
  function formatMB(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '0.00 MB';
    var mb = bytes / (1024 * 1024);
    return mb.toFixed(2) + ' MB';
  }

  function setProgress(done, total, downloadedBytes, totalBytes) {
    counterEl.textContent = done + '/' + total;
    var pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    // Width as % — live-css's transition support is unreliable, so the
    // fill div snaps to its new width each tick. Visually still reads
    // as a filling bar because the per-file delay between writes is
    // long enough that each snap is perceptible.
    progressFill.style.width = pct + '%';
    // MB readout. Two modes:
    //   - Catalog `sizeBytes` known (`totalBytes > 0`): show how
    //     many MB are LEFT to pull. `Math.max(0, …)` clamps the
    //     case where the catalog under-reports (e.g. logo
    //     resize'd post-publish) so the cell can't read negative.
    //   - Catalog omitted size (`totalBytes <= 0`): show how many
    //     MB we've ALREADY downloaded — still useful progress info,
    //     just without the target figure.
    if (remainingEl) {
      var dl = typeof downloadedBytes === 'number' && isFinite(downloadedBytes)
        ? downloadedBytes : 0;
      var tot = typeof totalBytes === 'number' && isFinite(totalBytes) && totalBytes > 0
        ? totalBytes : 0;
      if (tot > 0) {
        var remaining = Math.max(0, tot - dl);
        remainingEl.textContent = 'Remaining: ' + formatMB(remaining);
      } else {
        remainingEl.textContent = formatMB(dl) + ' downloaded';
      }
    }
  }

  // Recursive descendant-by-class lookup — LiveElement doesn't ship a
  // `querySelector`, mirrors the helper in updates-modal.js.
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

  // Walk the grid cards on the page and find the one whose
  // data-app-detail matches `(group, id)`. Returns null when no card on
  // the current page matches (e.g. home.html only shows the featured
  // group; a download from apps.html for a community card won't have a
  // matching home-page card).
  function findCardEl(group, id) {
    var cards = document.querySelectorAll('[data-app-detail]');
    for (var i = 0; i < cards.length; i++) {
      var cardEl = cards[i];
      var raw = cardEl.getAttribute('data-app-detail');
      if (!raw) continue;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (_) { continue; }
      if (!parsed || parsed.id !== id || parsed.group !== group) continue;
      return cardEl;
    }
    return null;
  }

  // After a successful install, flip the matching grid card out of
  // the missing / upgrade state in place so the user sees the result
  // without navigating away. Mirrors refreshCardLogo +
  // refreshCardUpgrade in updates-modal.js — same data-app-detail
  // round-trip + meta-strip patch.
  function refreshCardOnSuccess(detail) {
    var cardEl = findCardEl(detail.group, detail.id);
    if (!cardEl) return;
    cardEl.classList.remove('app-card--missing');
    cardEl.classList.remove('app-card--upgrade');
    // Patch the embedded detail JSON so a future tap on the same card
    // opens the modal in the installed (Play) state instead of
    // missing (Download) / upgrade (Update).
    var raw = cardEl.getAttribute('data-app-detail');
    var parsed;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    if (parsed) {
      parsed.missing = false;
      // Installed version is now the catalog version — clear the
      // upgrade signal.
      parsed.installedVersion = '';
      // Refresh the in-detail logo URL to point at the freshly-
      // downloaded asset (same scheme rewrite updates-modal.js does
      // post-logo-seed).
      if (detail.logo) {
        var logoRel = stripLeadingSlashes(detail.logo);
        // detail.logo may already be a brewser:// URL (from the card
        // detail) OR a catalog-relative path (from the artifact
        // manifest). Only rewrite when it isn't already brewser://.
        if (detail.logo.indexOf('brewser://') !== 0 && logoRel) {
          parsed.logo = 'brewser://apps/' + detail.group + '/' + detail.id + '/' + logoRel;
        }
      }
      cardEl.setAttribute('data-app-detail', JSON.stringify(parsed));
    }
    // Swap the meta strip's NEW pill / upgrade chip for the ordinary
    // version chip. Same lookup the renderer uses (.app-meta__version).
    var versionEl = findDescendantByClass(cardEl, 'app-meta__version');
    if (versionEl) {
      versionEl.classList.remove('app-meta__version--new');
      versionEl.classList.remove('app-meta__version--upgrade');
      if (detail.version) {
        versionEl.textContent = 'v' + detail.version;
      } else {
        versionEl.textContent = '';
      }
    }
    // Refresh the card's <img src> to the new logo path if the logo
    // file was downloaded.
    if (detail.logo) {
      var rel = stripLeadingSlashes(detail.logo);
      if (rel) {
        var brewserLogoUrl = detail.logo.indexOf('brewser://') === 0
          ? detail.logo
          : 'brewser://apps/' + detail.group + '/' + detail.id + '/' + rel;
        for (var c = 0; c < cardEl.children.length; c++) {
          var child = cardEl.children[c];
          if (child.tagName === 'IMG') {
            child.setAttribute('src', brewserLogoUrl);
            break;
          }
        }
      }
    }
  }

  // Parse a fetched artifact manifest into a flat list of relative file
  // paths. Accepts a few shapes so the upstream catalog repo can pick
  // whichever fits its tooling:
  //   - flat array of strings: `["index.html", "assets/x.png", ...]`
  //   - `{ files: [...] }`
  //   - `{ paths: [...] }`
  //   - array of objects with `path` / `name` field
  //     (also accepts `download_url` for direct-URL artifacts; ignored
  //     here, see resolveFileUrl).
  // Strips a leading slash off each entry so paths join cleanly.
  function extractFileList(parsed) {
    if (Array.isArray(parsed)) {
      return parsed.map(extractPath).filter(function (p) { return !!p; });
    }
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.files)) {
        return parsed.files.map(extractPath).filter(function (p) { return !!p; });
      }
      if (Array.isArray(parsed.paths)) {
        return parsed.paths.map(extractPath).filter(function (p) { return !!p; });
      }
    }
    return [];
  }

  function extractPath(entry) {
    if (typeof entry === 'string') return stripLeadingSlashes(entry);
    if (entry && typeof entry === 'object') {
      if (typeof entry.path === 'string') return stripLeadingSlashes(entry.path);
      if (typeof entry.name === 'string') return stripLeadingSlashes(entry.name);
    }
    return '';
  }

  // Resolve the remote URL for a single per-app file. Default layout:
  // `<catalogueBase>apps/<group>/<id>/<rel>`. Catalog authors who keep
  // the artifact tree under a different prefix can override per-file
  // by emitting `{ path, url }` entries in the artifact JSON — we honor
  // an absolute `url` on the entry when present.
  function resolveFileUrl(baseUrl, group, id, rel, entry) {
    if (entry && typeof entry === 'object'
      && typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url)) {
      return entry.url;
    }
    if (entry && typeof entry === 'object'
      && typeof entry.download_url === 'string' && /^https?:\/\//i.test(entry.download_url)) {
      return entry.download_url;
    }
    return baseUrl + 'apps/' + group + '/' + id + '/' + rel;
  }

  // Reorder the path list so the entry file lands LAST. The engine's
  // missing-detection check probes for `apps/<group>/<id>/<entry>`
  // (loadCatalogGroup) — leaving the entry until after every other
  // file is on disk means an interrupted download keeps the card
  // flagged as missing, and the user can re-tap Download to retry
  // without orphan state.
  function reorderEntryLast(paths, entryRel) {
    if (!entryRel) return paths.slice();
    var entry = stripLeadingSlashes(entryRel);
    var others = [];
    var foundEntry = false;
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      var pRel = typeof p === 'string' ? p : extractPath(p);
      if (pRel === entry) {
        foundEntry = true;
        continue;
      }
      others.push(p);
    }
    if (foundEntry) {
      // Preserve the original entry shape (string or object) so
      // resolveFileUrl can still honor a per-entry `url` override.
      var entryEntry = entry;
      for (var j = 0; j < paths.length; j++) {
        var pj = paths[j];
        var pjRel = typeof pj === 'string' ? pj : extractPath(pj);
        if (pjRel === entry) { entryEntry = pj; break; }
      }
      others.push(entryEntry);
    } else {
      // Entry file isn't named in the manifest — append it as a raw
      // string so resolveFileUrl uses the default base URL layout. The
      // fetch will 404 if the catalog repo doesn't ship the file, and
      // the modal flips to error.
      others.push(entry);
    }
    return others;
  }

  // Core install loop — given a parsed artifact manifest, walk each
  // file, mkdir its parent, fetch its bytes, write them. Updates the
  // progress UI as each file lands. Returns true on success, false on
  // any failure (caller surfaces the error to the modal).
  async function downloadFiles(parsed, detail, baseUrl) {
    var rawList = Array.isArray(parsed)
      ? parsed
      : (parsed && (parsed.files || parsed.paths)) || [];
    if (!Array.isArray(rawList) || rawList.length === 0) {
      setError('Artifact manifest has no files.');
      return false;
    }
    // Save the entry file LAST so an interrupted download leaves the
    // card flagged as missing.
    var ordered = reorderEntryLast(rawList, detail.entry || 'index.html');
    var total = ordered.length;
    var done = 0;
    // Cumulative bytes pulled off the wire. Summed from each file's
    // actual `buf.byteLength` so the figure reflects real progress
    // instead of an (totalBytes/totalFiles)*doneFiles estimate (which
    // would lie for catalogs with mixed file sizes — typical for
    // any non-trivial app where the entry HTML is tiny and the
    // asset PNGs / audio dominate). Total comes from the catalog's
    // `detail.sizeBytes`; 0 when the catalog omits it, in which case
    // setProgress flips the MB cell to "X.X MB downloaded" mode.
    var downloadedBytes = 0;
    var totalBytes = (typeof detail.sizeBytes === 'number' && isFinite(detail.sizeBytes)
      && detail.sizeBytes > 0) ? detail.sizeBytes : 0;
    setProgress(0, total, 0, totalBytes);
    statusEl.innerHTML = 'Downloading files…';
    for (var i = 0; i < ordered.length; i++) {
      // Cancel checkpoint at the top of every iteration — covers the
      // common case where the user taps Cancel between files.
      if (cancelled) return false;
      var entry = ordered[i];
      var rel = typeof entry === 'string' ? entry : extractPath(entry);
      if (!rel) {
        // Malformed entry — skip silently rather than failing the
        // whole install. Counter still ticks so the bar advances.
        done++;
        setProgress(done, total, downloadedBytes, totalBytes);
        continue;
      }
      var localPath = APP_ROOT + 'apps/' + detail.group + '/' + detail.id + '/' + rel;
      var remoteUrl = resolveFileUrl(baseUrl, detail.group, detail.id, rel, entry);
      try {
        var dir = parentDir(localPath);
        if (dir) Switch.mkdirSync(dir);
      } catch (err) {
        setError('mkdir failed for ' + rel + ': ' + (err && err.message ? err.message : String(err)));
        return false;
      }
      var resp;
      try {
        resp = await globalThis.fetch(remoteUrl);
      } catch (err) {
        // Cancelled mid-fetch — treat any fetch error as a clean
        // bail-out so we don't surface a confusing "Network error"
        // on the (now-hidden) modal.
        if (cancelled) return false;
        setError('Network error fetching ' + rel + ': ' + (err && err.message ? err.message : String(err)));
        return false;
      }
      // Cancel checkpoint AFTER the fetch — the network may have
      // landed before the user tapped Cancel, but we still want to
      // skip the expensive `arrayBuffer()` + `writeFileSync` that
      // come next.
      if (cancelled) return false;
      if (!resp.ok) {
        setError('HTTP ' + resp.status + ' fetching ' + rel);
        return false;
      }
      var buf;
      try {
        buf = await resp.arrayBuffer();
      } catch (err) {
        if (cancelled) return false;
        setError('Read failed for ' + rel + ': ' + (err && err.message ? err.message : String(err)));
        return false;
      }
      // Cancel checkpoint BEFORE the synchronous write. This is the
      // load-bearing one for the bug — `Switch.writeFileSync` is a
      // synchronous syscall that blocks the JS thread for the
      // duration of the write (tens to hundreds of ms for a multi-MB
      // file), so even one stale write after Cancel makes the
      // cursor stutter. Skipping it once the cancel flag is set
      // means the loop returns within a single fetch cycle.
      if (cancelled) return false;
      try {
        Switch.writeFileSync(localPath, buf);
      } catch (err) {
        setError('Write failed for ' + rel + ': ' + (err && err.message ? err.message : String(err)));
        return false;
      }
      // Add the actual bytes we just downloaded to the running total
      // BEFORE the per-tick UI update so the MB readout reflects the
      // current file's bytes. `byteLength` is defined on ArrayBuffer
      // (and on TypedArrays); guard against either shape having lost
      // it (defensive — `resp.arrayBuffer()` always returns an
      // ArrayBuffer in spec-compliant fetchers).
      if (buf && typeof buf.byteLength === 'number') {
        downloadedBytes += buf.byteLength;
      }
      done++;
      setProgress(done, total, downloadedBytes, totalBytes);
    }
    return true;
  }

  // Fire-and-forget install for the currently-open detail. Each
  // failure flips the card into `--error`; success flips into
  // `--success` and patches the matching grid card in place.
  async function runInstall(detail, opts) {
    if (inFlight) return;
    inFlight = true;
    // Reset the cancel flag so a re-tap after a cancelled install
    // starts a fresh attempt. The flag is set by `close()` to signal
    // the loop to bail; it's reset here on every start so a stale
    // `true` from a prior cancel can't immediately abort the new
    // install.
    cancelled = false;
    try {
      var catalogueUrl = (opts && opts.catalogueUrl) || '';
      if (!catalogueUrl) {
        setError('No catalog URL configured. Set "catalogue" in config.json.');
        return;
      }
      if (!detail || !detail.id || !detail.group) {
        setError('Missing app id/group.');
        return;
      }
      var baseUrl = catalogueBaseUrl(catalogueUrl);
      var artifactUrl = baseUrl + 'artifacts/' + detail.id + '.json';
      statusEl.innerHTML = 'Fetching artifact manifest…';
      var resp;
      try {
        resp = await globalThis.fetch(artifactUrl);
      } catch (e) {
        if (cancelled) return;
        setError('Network error fetching manifest: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      if (cancelled) return;
      if (!resp.ok) {
        setError('HTTP ' + resp.status + ' fetching artifact manifest.');
        return;
      }
      var text;
      try {
        text = await resp.text();
      } catch (e) {
        if (cancelled) return;
        setError('Failed reading manifest: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      if (cancelled) return;
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        setError('Manifest is not valid JSON: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      // Make sure the per-app directory exists upfront — mkdirSync
      // creates intermediates so this is also handled per-file below,
      // but doing it once at the top is cheap and gives a friendlier
      // error message if the path is somehow invalid.
      try {
        Switch.mkdirSync(APP_ROOT + 'apps/' + detail.group + '/' + detail.id);
      } catch (err) {
        setError('mkdir failed for app dir: ' + (err && err.message ? err.message : String(err)));
        return;
      }
      var ok = await downloadFiles(parsed, detail, baseUrl);
      // Cancel during the loop → downloadFiles returns false WITHOUT
      // calling setError. Skip both the failure surfacing AND the
      // success path so the modal just stays closed with no message.
      if (cancelled) return;
      if (!ok) return;
      // Refresh the grid card in place — remove missing/upgrade state,
      // update the version chip, swap the logo src.
      try { refreshCardOnSuccess(detail); }
      catch (err) { console.debug('[download-modal] refreshCardOnSuccess failed: ' + (err && err.message ? err.message : String(err))); }
      // Force a full body-cache rebuild so the static body cache
      // includes the post-install card state on the next paint —
      // otherwise the user might see stale "NEW" pill / upgrade chip
      // pixels until they navigate away. Same reason updates-modal.js
      // calls __swbRepaint after refreshUpgradeChips.
      if (typeof globalThis.__swbRepaint === 'function') {
        try { globalThis.__swbRepaint(); }
        catch (err) { console.debug('[download-modal] __swbRepaint failed: ' + (err && err.message ? err.message : String(err))); }
      }
      setSuccess(detail.name ? (detail.name + ' is ready to play!') : 'Install complete.');
    } finally {
      inFlight = false;
    }
  }

  function open(detail, opts) {
    if (modalOpen) return;
    setLoading();
    setProgress(0, 0, 0, 0);
    counterEl.textContent = '';
    if (remainingEl) remainingEl.textContent = '';
    var mode = (opts && opts.mode) || 'download';
    var name = (detail && (detail.name || detail.id)) || 'app';
    titleEl.textContent = (mode === 'update' ? 'Updating ' : 'Downloading ') + name;
    statusEl.innerHTML = 'Preparing…';
    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
    // Defer the work to a microtask so the modal paints in the
    // loading state on this frame; a synchronous setError (e.g.
    // missing URL) would otherwise flip the card to error before the
    // user sees the loading state at all.
    Promise.resolve().then(function () {
      if (!modalOpen) return;
      runInstall(detail || {}, opts || {});
    });
  }

  function close() {
    if (!modalOpen) return;
    // Signal any in-flight install loop to bail at its next
    // checkpoint. Without this the loop keeps fetching + writing
    // files to disk synchronously after the modal closes, which on
    // a multi-GB install (e.g. pvzge ~1.2 GB) blocks the JS thread
    // for tens of seconds — visible as cursor lag + FPS drop.
    // Always set, even when the loop isn't in flight (cheap).
    cancelled = true;
    overlay.classList.remove('app-modal-overlay--open');
    card.classList.remove('download-modal-card--loading');
    card.classList.remove('download-modal-card--error');
    card.classList.remove('download-modal-card--success');
    modalOpen = false;
  }

  // Expose the opener globally so missing-app-modal.js can wire its
  // Download / Update buttons to it without circular file deps. Sibling
  // modals do the same pattern (e.g. globalThis.__swbRepaint).
  globalThis.__brewserOpenDownloadModal = open;

  cancelBtn.addEventListener('click', function (e) {
    // Cancel during the loading phase — close the modal; the in-flight
    // fetch continues to settle in the background but its DOM writes
    // are harmless on the now-hidden card.
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });
  closeBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Backdrop tap → close. Filter on `e.target === overlay` so a tap
  // landing inside the card doesn't close it.
  overlay.addEventListener('click', function (e) {
    if (e && e.target === overlay) close();
  });

  // No-op window-level mousedown listener flips
  // page-mouse-forwarder.ts's `pageHasListenerFor('mousedown')` gate
  // so B routes through `contextmenu` instead of the shell's no-op
  // rightClick. Same gate the other modals install.
  window.addEventListener('mousedown', function () { /* gate */ });

  // B (default rightClick) → close when the modal is open. Each modal
  // on the page registers its own contextmenu listener and gates on
  // its own `modalOpen` flag; only the visible one reacts.
  window.addEventListener('contextmenu', function (e) {
    if (!modalOpen) return;
    close();
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // L (default `back`) → the shell dispatches a synthetic Escape on L
  // when any page keydown listener exists. preventDefault keeps the
  // shell from also navigating back; the press only closes the modal.
  window.addEventListener('keydown', function (e) {
    if (!modalOpen) return;
    var key = e && e.key;
    if (key === 'Escape' || key === 'Esc') {
      close();
      if (e && e.preventDefault) e.preventDefault();
    }
  });
})();
