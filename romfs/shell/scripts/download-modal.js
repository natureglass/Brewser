// Download / Update progress modal — opened from the missing-app
// modal's Download (missing app) or Update (installed-but-stale app)
// button. Looks the app up in the CACHED NORMALIZED catalogue via the
// platform bridge (`globalThis.__brewserPlatformClient`), fetches its
// artifact manifest from `app.artifactsUrl`, parses it with
// `client.parseArtifacts`, and writes each file under the flat
// `sdmc:/switch/brewser/apps/<id>/<rel>` — every remote URL comes from
// the platform client (`app.fileUrl(rel)`), never assembled here. The
// entry file is saved LAST so an interrupted download leaves the card
// flagged as missing and re-tapping Download retries cleanly.
//
// API: exposes `globalThis.__brewserOpenDownloadModal(detail, opts)`.
//   `detail`  — the same JSON shape stamped on cards by
//               renderAppCards (id, name, version, entry,
//               installedVersion, logo, ...). At minimum needs `id`.
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

  // Set true the instant an install COMPLETES successfully; read by
  // close() to fire ONE full-page reload on dismiss so the grid re-renders
  // from disk with the app now installed. A missing→installed change is a
  // SET change (the same case updates-modal.js reloads for on close), not a
  // cosmetic in-place tweak — so we deliberately do NOT mutate the grid
  // card while this modal is open (doing so + repainting was what left the
  // card blank until the user manually navigated away and back).
  var installedOnSuccess = false;

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

  function parentDir(path) {
    var idx = path.lastIndexOf('/');
    return idx >= 0 ? path.slice(0, idx) : '';
  }

  // Files whose CONTENT can change WITHOUT a version bump — the app's
  // `manifest.json` (e.g. an added permission) and its banner image
  // (`appbanner.*`, i.e. the catalogue `logo`) — get cache-busted on
  // every (re)download so an edited manifest / banner lands even when the
  // GitHub-Pages CDN edge still holds the old bytes. The manifest.json +
  // appbanner.jpg are already in the artifact file list and thus already
  // overwritten, but the CDN can serve a stale copy for minutes after a
  // redeploy — the cache-bust query forces the origin's current bytes.
  // The bulk asset files deliberately keep their plain, cacheable URLs:
  // busting every file would defeat the CDN for the whole user base, and
  // assets change alongside a version bump (which the Update flow handles).
  function isFreshFile(rel, logoRel) {
    var base = rel.replace(/^.*\//, '');
    if (base === 'manifest.json') return true;
    if (/^appbanner\.[a-z0-9]+$/i.test(base)) return true;
    if (logoRel && rel === logoRel) return true;
    return false;
  }
  function cacheBust(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_cb=' + Date.now();
  }

  // Hide/restore the shell toolbar strip for the whole download. The toolbar
  // overlay paints on top of the modal, so without this it stays visible over
  // the download backdrop (same issue the self-update modal solved). Guarded:
  // a build without the shell hook just keeps the toolbar (no-op). Mirrors
  // `setChromeVisible` in self-update-modal.js verbatim.
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
  // data-app-detail matches the app id. Returns null when no card on
  // the current page matches (e.g. the visible tab doesn't include
  // this app).
  function findCardEls(id) {
    var out = [];
    var cards = document.querySelectorAll('[data-app-detail]');
    for (var i = 0; i < cards.length; i++) {
      var cardEl = cards[i];
      var raw = cardEl.getAttribute('data-app-detail');
      if (!raw) continue;
      var parsed;
      try { parsed = JSON.parse(raw); } catch (_) { continue; }
      if (!parsed || parsed.id !== id) continue;
      out.push(cardEl);
    }
    return out;
  }

  // After a successful install, flip the matching grid card out of
  // the missing / upgrade state in place so the user sees the result
  // without navigating away. Mirrors refreshCardLogo +
  // refreshCardUpgrade in updates-modal.js — same data-app-detail
  // round-trip + meta-strip patch.
  function refreshCardOnSuccess(detail) {
    // Patch EVERY card matching this id, not just the first: a published
    // app appears in several tab panels at once (Featured / Recent /
    // Popular / Top Rated AND My Apps), all present in the DOM. Patching
    // only the first left the visible tab's card (often My Apps) stuck on
    // "Download" until a reload — the app was installed but the card said
    // otherwise.
    var cardEls = findCardEls(detail.id);
    for (var ci = 0; ci < cardEls.length; ci++) {
      patchCardOnSuccess(cardEls[ci], detail);
    }
  }

  function patchCardOnSuccess(cardEl, detail) {
    cardEl.classList.remove('app-card--missing');
    cardEl.classList.remove('app-card--upgrade');
    // The app is now installed, so it is no longer "not downloaded":
    // clear the flag that dims the card banner (opacity 0.65) at render.
    cardEl.removeAttribute('data-missing');
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
          parsed.logo = 'brewser://apps/' + detail.id + '/' + logoRel;
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
          : 'brewser://apps/' + detail.id + '/' + rel;
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

  // Reorder the path list so the entry file lands LAST. The engine's
  // missing-detection check probes for `apps/<id>/<entry>` — leaving
  // the entry until after every other file is on disk means an
  // interrupted download keeps the card flagged as missing, and the
  // user can re-tap Download to retry without orphan state.
  // (Artifact parsing lives in the platform client now —
  // `client.parseArtifacts` yields a plain string[] of relative paths.)
  function reorderEntryLast(paths, entryRel) {
    if (!entryRel) return paths.slice();
    var entry = stripLeadingSlashes(entryRel);
    var others = [];
    var foundEntry = false;
    for (var i = 0; i < paths.length; i++) {
      if (paths[i] === entry) {
        foundEntry = true;
        continue;
      }
      others.push(paths[i]);
    }
    // Append the entry last whether or not the manifest named it — if
    // the repo doesn't actually ship the file, the fetch 404s and the
    // modal flips to error, which is the honest outcome.
    void foundEntry;
    others.push(entry);
    return others;
  }

  // Core install loop — given the artifact file list (string[] from the
  // platform client) and the normalized catalogue app (whose
  // `fileUrl(rel)` builds every remote URL), walk each file, mkdir its
  // parent, fetch its bytes, write them. Updates the progress UI as
  // each file lands. Returns true on success, false on any failure
  // (caller surfaces the error to the modal).
  async function downloadFiles(files, detail, app) {
    var rawList = Array.isArray(files) ? files : [];
    if (rawList.length === 0) {
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
      var rel = stripLeadingSlashes(ordered[i] || '');
      if (!rel) {
        // Malformed entry — skip silently rather than failing the
        // whole install. Counter still ticks so the bar advances.
        done++;
        setProgress(done, total, downloadedBytes, totalBytes);
        continue;
      }
      var localPath = APP_ROOT + 'apps/' + detail.id + '/' + rel;
      var remoteUrl = app.fileUrl(rel);
      // Force manifest.json + the banner past any CDN cache so an edited
      // manifest (new permissions) / banner refreshes on this download
      // without waiting for the edge cache to expire (or a Check-for-Updates).
      if (isFreshFile(rel, app && app.logoRel)) remoteUrl = cacheBust(remoteUrl);
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

  // Look an app up in the cached per-user "My Apps" document
  // (configs/my-catalogue.json). Apps a developer owns but that aren't in
  // the PUBLIC catalogue (unpublished, or staged) live only here. Returns
  // the normalized entry (with its source-resolved artifactsUrl/fileUrl)
  // or null. Published + unpublished entries resolve to the base host and
  // have artifact manifests; staged entries resolve to the staging host,
  // which has none (handled by the caller).
  function findInMyCatalogue(client, id) {
    var text = null;
    try {
      var raw = Switch.readFileSync(APP_ROOT + 'configs/my-catalogue.json');
      if (raw && raw.byteLength > 0) text = new TextDecoder().decode(raw);
    } catch (_) { return null; }
    if (!text) return null;
    var outcome;
    try { outcome = client.parseCatalogue(text); } catch (_) { return null; }
    if (!outcome || outcome.kind !== 'Ok') return null;
    for (var i = 0; i < outcome.catalogue.apps.length; i++) {
      if (outcome.catalogue.apps[i].id === id) return outcome.catalogue.apps[i];
    }
    return null;
  }

  // Best-effort download telemetry. On a completed install/update we POST a
  // {reqType:'download'} event to the strict-pinned telemetry endpoint so
  // WordPress bumps the per-package counter (wp_swtel_downloads). That counter
  // is the ONLY signal behind the runtime's Popular ("most downloaded") library
  // tab: the daily WP cron folds it into stats.json, which Check-for-Updates
  // fetches. Without this call nothing ever reports a download, so every app
  // publishes downloads:0 and Popular reports "No download counts yet."
  //
  // Mirrors missing-app-modal.js's rating POST (same endpoint, stamped on
  // `<body data-telemetry-url>` of home.html + apps.html; that flow uses
  // reqType:'like'). A download event needs ONLY {reqType, packageId} — the
  // telemetry schema makes userId/data requiredIf reqType is like/save, not
  // download. Fire-and-forget: every failure path is swallowed so a telemetry
  // hiccup never touches the already-successful download UI, and we do NOT
  // await it (the success message paints immediately).
  function reportDownload(packageId) {
    try {
      if (!packageId) return;
      var body = globalThis.document && globalThis.document.body;
      var url = body && body.getAttribute('data-telemetry-url');
      if (typeof url !== 'string' || !url) return;
      globalThis.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reqType: 'download', packageId: packageId, platform: 'switch' }),
      }).catch(function (err) {
        console.debug('[download-modal] download telemetry POST failed: '
          + (err && err.message ? err.message : String(err)));
      });
    } catch (err) {
      console.debug('[download-modal] download telemetry skipped: '
        + (err && err.message ? err.message : String(err)));
    }
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
    // Clear the success flag so a re-tapped Download after a prior success
    // can't fire a stale reload when THIS attempt's modal closes.
    installedOnSuccess = false;
    try {
      if (!detail || !detail.id) {
        setError('Missing app id.');
        return;
      }
      // Look the app up in the CACHED normalized catalogue — the only
      // place remote URLs come from. An app absent from the cache
      // cannot be downloaded (nothing trustworthy to fetch from), so
      // say so instead of guessing a URL.
      var client = globalThis.__brewserPlatformClient;
      if (!client) {
        setError('Platform client unavailable (shell bridge missing).');
        return;
      }
      // Resolve the app's remote URLs from a normalized catalogue — the only
      // trustworthy source. Prefer the PUBLIC catalogue; fall back to the
      // per-user "My Apps" document for apps that live only there (unpublished
      // or staged). A missing public catalogue must NOT block a My Apps
      // install — a profile that only ever refreshed my-catalogue has none.
      var app = null;
      var cached = client.readCachedCatalogue();
      if (cached && cached.kind === 'Ok') {
        for (var ai = 0; ai < cached.catalogue.apps.length; ai++) {
          if (cached.catalogue.apps[ai].id === detail.id) { app = cached.catalogue.apps[ai]; break; }
        }
      }
      if (!app) {
        // my-catalogue points each entry at its real host: the base repo for
        // published/unpublished, the my.brewser.tech staging host for staged.
        // Both serve an artifacts/<id>.json, so the install path is identical.
        app = findInMyCatalogue(client, detail.id);
      }
      if (!app) {
        setError('App is not in the current catalogue — run Check for Updates and try again.');
        return;
      }
      statusEl.innerHTML = 'Fetching artifact manifest…';
      var resp;
      try {
        resp = await globalThis.fetch(app.artifactsUrl);
      } catch (e) {
        if (cancelled) return;
        setError('Network error fetching manifest: ' + (e && e.message ? e.message : String(e)));
        return;
      }
      if (cancelled) return;
      if (!resp.ok) {
        // 404 usually means a just-staged app whose files are still deploying
        // (the staging CI writes artifacts/<id>.json on deploy) — a transient,
        // retryable state rather than a hard failure.
        if (resp.status === 404) {
          setError('This app’s file list isn’t available yet — if it was just staged, its files are still deploying. Try again shortly.');
        } else {
          setError('HTTP ' + resp.status + ' fetching artifact manifest.');
        }
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
      var artifacts = client.parseArtifacts(text);
      if (artifacts.kind !== 'Ok') {
        setError('Artifact manifest rejected (' + artifacts.kind + '): '
          + (artifacts.message || 'unknown reason'));
        return;
      }
      // Make sure the per-app directory exists upfront — mkdirSync
      // creates intermediates so this is also handled per-file below,
      // but doing it once at the top is cheap and gives a friendlier
      // error message if the path is somehow invalid.
      try {
        Switch.mkdirSync(APP_ROOT + 'apps/' + detail.id);
      } catch (err) {
        setError('mkdir failed for app dir: ' + (err && err.message ? err.message : String(err)));
        return;
      }
      var ok = await downloadFiles(artifacts.artifacts.files, detail, app);
      // Cancel during the loop → downloadFiles returns false WITHOUT
      // calling setError. Skip both the failure surfacing AND the
      // success path so the modal just stays closed with no message.
      if (cancelled) return;
      if (!ok) return;
      // App files are now on disk (entry file written LAST). A
      // missing→installed transition is a SET change, not a cosmetic chip
      // tweak, so we do NOT patch the grid card in place here: mutating the
      // host cards + repainting WHILE this modal is open is exactly what
      // left the card blank until a manual navigation. Instead flag a
      // one-shot reload on dismiss (see close()), mirroring updates-modal.js's
      // `myCatalogueRefreshed` → reload-on-close pattern — the grid then
      // re-renders from disk with the app installed and immediately playable.
      // (The former in-place path — refreshCardOnSuccess / patchCardOnSuccess
      // — is retained above but intentionally no longer invoked.)
      installedOnSuccess = true;
      // Report the completed download so the Popular tab has data to rank on.
      // Fires for both fresh installs and updates (the WP counter has no
      // dedup — each acquisition is a download), best-effort, never awaited.
      reportDownload(detail.id);
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
    // Hide the toolbar for the entire download; restored in close() on any
    // dismiss/cancel/terminal-state. On a successful install close() fires
    // __swbReload, which brings back a fresh toolbar anyway.
    setChromeVisible(false);
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
    // Download is done or aborted — bring the toolbar back. Harmless on the
    // success path (the __swbReload below repaints the whole shell anyway);
    // essential on cancel/failure where no reload follows.
    setChromeVisible(true);
    // One-shot reload after a successful install so the grid re-renders
    // from disk (the app is now installed) and the card returns in its
    // playable state — without the user having to navigate away and back.
    // Fires only AFTER the modal is closed (never mid-modal, per the
    // no-reload-mid-modal rule); a cancelled/failed download leaves the
    // flag false so its close is unchanged. Same shape as updates-modal.js
    // close()'s `myCatalogueRefreshed` reload.
    if (installedOnSuccess && typeof globalThis.__swbReload === 'function') {
      installedOnSuccess = false;
      // Land the reloaded Home on the "Downloads" tab so the user sees the app
      // they just installed. One-shot hint the resource loader reads (+clears)
      // when it re-renders home's <browser-home-checked> radios — applies to
      // exactly this reload, then Home falls back to the configured homeSection.
      try { globalThis.__brewserPendingHomeTab = 'downloads'; } catch (_) {}
      try { globalThis.__swbReload(); } catch (_) {}
    }
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
