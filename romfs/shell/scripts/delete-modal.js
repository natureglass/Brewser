// delete-modal.js — app uninstall progress modal. Opened from the
// missing-app modal's "Delete app" button (shown only for an installed
// app). Enumerates every file under sdmc:/switch/brewser/apps/<id> and
// removes them one at a time so the progress bar advances, then removes
// the now-empty directory tree. On success reloads the shell so the grid
// re-renders with the app shown as not-installed (dimmed + Download).
//
// API: exposes globalThis.__brewserOpenDeleteModal(detail).
//   `detail` — the card JSON (id, name, entry, ...). Needs `id`.
//
// Reuses the download modal's progress CSS: the card carries the
// `download-modal-card` class + the same `--loading`/`--error`/
// `--success` state modifiers and progress/status/button classes, so
// the theme stylesheet drives all show/hide with no new CSS. Visibility
// uses classList on the overlay + card (NEVER inline `style.display`) —
// same live-DOM cache reason as the sibling modals (see download-modal.js).

(function () {
  var overlay = document.getElementById('delete-modal-overlay');
  var card = document.getElementById('delete-modal-card');
  var titleEl = document.getElementById('delete-modal-title');
  var statusEl = document.getElementById('delete-modal-status');
  var counterEl = document.getElementById('delete-modal-counter');
  var remainingEl = document.getElementById('delete-modal-remaining');
  var progressFill = document.getElementById('delete-modal-progress-fill');
  var errorEl = document.getElementById('delete-modal-error');
  var cancelBtn = document.getElementById('delete-modal-cancel');
  var closeBtn = document.getElementById('delete-modal-close');
  if (!overlay || !card || !titleEl || !statusEl || !counterEl
    || !progressFill || !errorEl || !cancelBtn || !closeBtn) {
    console.debug('[delete-modal] init aborted; missing node(s):'
      + ' overlay=' + !!overlay + ' card=' + !!card + ' title=' + !!titleEl
      + ' status=' + !!statusEl + ' counter=' + !!counterEl
      + ' progressFill=' + !!progressFill + ' errorEl=' + !!errorEl
      + ' cancelBtn=' + !!cancelBtn + ' closeBtn=' + !!closeBtn);
    return;
  }
  console.debug('[delete-modal] wired');

  // Where apps live on disk. Mirrors the engine's appRoot (BREWSER_APP_ROOT
  // in src/browser-config.ts) — the same path download-modal.js writes to.
  var APP_ROOT = 'sdmc:/switch/brewser/';

  var modalOpen = false;
  var inFlight = false;
  // Set by close() so an in-flight delete loop bails at its next
  // checkpoint (mirrors download-modal.js). A cancelled uninstall may
  // leave the app partially removed — because we delete the ENTRY file
  // first, that partial state reads as "not installed" and the app can
  // be re-downloaded cleanly.
  var cancelled = false;
  // Set true the instant a delete COMPLETES; read by close() to fire ONE
  // full-page reload on dismiss so the grid re-renders from disk with the
  // app now gone (card flips to the not-installed / Download state). An
  // installed→removed change is a SET change, so we reload rather than
  // patch the card in place — same rule download-modal.js follows.
  var deletedOnSuccess = false;

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

  // Hide/restore the shell toolbar strip for the whole delete, mirroring
  // download-modal.js — the toolbar overlay otherwise paints on top of
  // the modal. Guarded: a build without the hook just keeps the toolbar.
  function setChromeVisible(visible) {
    try {
      if (typeof globalThis.__brewserSetChromeVisible === 'function') {
        globalThis.__brewserSetChromeVisible(visible);
      }
    } catch (_) { /* no-op */ }
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
    statusEl.innerHTML = 'Delete failed.';
  }

  function setSuccess(message) {
    card.classList.remove('download-modal-card--loading');
    card.classList.remove('download-modal-card--error');
    card.classList.add('download-modal-card--success');
    statusEl.innerHTML = escapeHtml(message);
  }

  function setProgress(done, total) {
    counterEl.textContent = done + '/' + total;
    var pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    // Snap the fill width each tick — live-css transitions are unreliable
    // (same note as download-modal.js). The bar still reads as filling
    // because each per-file remove yields before the next width write.
    progressFill.style.width = pct + '%';
    if (remainingEl) {
      var left = Math.max(0, total - done);
      remainingEl.textContent = left + ' file' + (left === 1 ? '' : 's') + ' left';
    }
  }

  // Recursively collect every FILE path under `dir`. Uses the async
  // `Switch.readDir` (yields typed DirEntry {name,isFile,isDirectory}) —
  // `readDirSync` returns names WITHOUT types, so the async form is the
  // one that lets us recurse into subdirectories. Directories themselves
  // are removed by the single recursive `removeSync(appDir)` at the end;
  // this list drives the per-file progress bar only.
  async function collectFiles(dir) {
    var files = [];
    async function walk(d) {
      var entries = [];
      try {
        for await (var e of Switch.readDir(d)) entries.push(e);
      } catch (_) {
        return; // unreadable dir — skip; removeSync cleans it up later
      }
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var name = e && e.name;
        if (!name || name === '.' || name === '..') continue;
        var full = d + '/' + name;
        if (e.isDirectory) {
          await walk(full);
        } else {
          files.push(full);
        }
      }
    }
    await walk(dir);
    return files;
  }

  // Fire-and-forget uninstall for the given detail. Enumerates files,
  // deletes each (entry file FIRST so an interrupted delete reads as
  // not-installed), then recursively removes the emptied directory.
  async function runDelete(detail) {
    if (inFlight) return;
    inFlight = true;
    cancelled = false;
    deletedOnSuccess = false;
    try {
      var id = detail && detail.id;
      // Safety gate: this drives a recursive filesystem delete, so refuse
      // anything that isn't a plain folder name (no path traversal) BEFORE
      // touching disk.
      if (!id || typeof id !== 'string' || /[\/\\]/.test(id) || id.indexOf('..') >= 0) {
        setError('Invalid app id — nothing was deleted.');
        return;
      }
      if (typeof Switch === 'undefined' || !Switch
        || typeof Switch.remove !== 'function' || typeof Switch.readDir !== 'function') {
        setError('Filesystem API unavailable.');
        return;
      }
      var appDir = APP_ROOT + 'apps/' + id;

      statusEl.innerHTML = 'Scanning files…';
      var files = await collectFiles(appDir);
      if (cancelled) return;

      // Delete the entry file first so a partial (cancelled / failed)
      // uninstall leaves the app flagged not-installed — the inverse of
      // download-modal.js writing the entry LAST.
      var entryFull = appDir + '/' + stripLeadingSlashes((detail && detail.entry) || 'index.html');
      var ordered = [];
      var sawEntry = false;
      for (var i = 0; i < files.length; i++) {
        if (files[i] === entryFull) { sawEntry = true; continue; }
        ordered.push(files[i]);
      }
      if (sawEntry) ordered.unshift(entryFull);

      var total = ordered.length;
      var done = 0;
      setProgress(0, total);
      statusEl.innerHTML = 'Deleting files…';
      for (var j = 0; j < ordered.length; j++) {
        if (cancelled) return;
        try {
          await Switch.remove(ordered[j]);
        } catch (err) {
          setError('Failed to delete a file: ' + (err && err.message ? err.message : String(err)));
          return;
        }
        done++;
        setProgress(done, total);
      }
      if (cancelled) return;

      // Remove the now file-less directory tree in one recursive call.
      // Also covers the total===0 case (empty / corrupt install: nothing
      // to tick through, but the dir still needs clearing).
      try {
        Switch.removeSync(appDir);
      } catch (err) {
        // The files are already gone; a leftover empty dir is harmless.
        // Log and still report success rather than failing the uninstall.
        console.debug('[delete-modal] removeSync(appDir) failed: '
          + (err && err.message ? err.message : String(err)));
      }

      // Remove the forwarder generator's inventory sidecar for this app
      // (configs/app-inventory/<id>.json) so it doesn't orphan after uninstall.
      // Best-effort — absent for legacy installs; a leftover would be harmless
      // anyway (the app dir is gone, so the generator's installed-test fails).
      try {
        Switch.removeSync(APP_ROOT + 'configs/app-inventory/' + id + '.json');
      } catch (err) { /* no sidecar / already gone — fine */ }

      if (total === 0) setProgress(1, 1); // show a full bar for a no-file app

      deletedOnSuccess = true;
      setSuccess((detail && detail.name) ? (detail.name + ' was deleted.') : 'App deleted.');
    } finally {
      inFlight = false;
    }
  }

  function open(detail) {
    if (modalOpen) return;
    setLoading();
    setProgress(0, 0);
    counterEl.textContent = '';
    if (remainingEl) remainingEl.textContent = '';
    var name = (detail && (detail.name || detail.id)) || 'app';
    titleEl.textContent = 'Deleting ' + name;
    statusEl.innerHTML = 'Preparing…';
    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;
    setChromeVisible(false);
    // Defer to a microtask so the modal paints its loading state on this
    // frame before the (synchronous-ish) scan starts.
    Promise.resolve().then(function () {
      if (!modalOpen) return;
      runDelete(detail || {});
    });
  }

  function close() {
    if (!modalOpen) return;
    // Signal any in-flight delete loop to bail at its next checkpoint.
    cancelled = true;
    overlay.classList.remove('app-modal-overlay--open');
    card.classList.remove('download-modal-card--loading');
    card.classList.remove('download-modal-card--error');
    card.classList.remove('download-modal-card--success');
    modalOpen = false;
    setChromeVisible(true);
    // One-shot reload after a successful delete so the grid re-renders
    // from disk (the app is gone). Fires only AFTER the modal is closed
    // (never mid-modal); a cancelled/failed delete leaves the flag false.
    if (deletedOnSuccess && typeof globalThis.__swbReload === 'function') {
      deletedOnSuccess = false;
      try { globalThis.__swbReload(); } catch (_) {}
    }
  }

  // Expose the opener so missing-app-modal.js can wire its Delete button
  // without a circular file dep (same pattern as __brewserOpenDownloadModal).
  globalThis.__brewserOpenDeleteModal = open;

  cancelBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });
  closeBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Backdrop tap → close. Filter on `e.target === overlay` so a tap
  // inside the card doesn't close it.
  overlay.addEventListener('click', function (e) {
    if (e && e.target === overlay) close();
  });

  // No-op window mousedown flips page-mouse-forwarder's gate so B routes
  // through contextmenu (same as the sibling modals).
  window.addEventListener('mousedown', function () { /* gate */ });

  // B (rightClick) → close when open.
  window.addEventListener('contextmenu', function (e) {
    if (!modalOpen) return;
    close();
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // L (back) → the shell dispatches a synthetic Escape; close on it.
  window.addEventListener('keydown', function (e) {
    if (!modalOpen) return;
    var key = e && e.key;
    if (key === 'Escape' || key === 'Esc') {
      close();
      if (e && e.preventDefault) e.preventDefault();
    }
  });
})();
