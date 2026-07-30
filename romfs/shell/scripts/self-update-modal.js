// Self-update ("Update Brewser") modal. Opened via
// `globalThis.__brewserOpenSelfUpdateModal()`, wired from updates-modal.js when
// the versions check finds a newer Brewser than the one installed.
//
// It drives the bundle-exposed `globalThis.__brewserSelfUpdate` API (installed
// by src/update/seam.ts): `prepare(ui)` runs check → decide → streamed download
// → chunk-verify → stage, reporting progress through the `ui` adapter below;
// then `applyStaged(stagedPath)` chainloads the staged build (the console
// relaunches into it, it self-applies over brewser.nro, and reboots). The
// installed NRO is never touched until that verified staged build applies
// itself — see the two-stage design in src/update/apply.ts.
//
// Visibility uses classList only (NEVER inline style.display on the card /
// overlay) — same live-DOM paint-cache reason as the sibling modals. The
// progress-fill WIDTH is an inline style, exactly as download-modal.js does it.
// Card state classes are reused verbatim from download-modal so the theme CSS
// styles this modal with no additions: `--loading` (progress + Cancel),
// `--success` (green progress + the primary button), `--error` (error slot).

(function () {
  var overlay = document.getElementById('selfupdate-modal-overlay');
  var card = document.getElementById('selfupdate-modal-card');
  var titleEl = document.getElementById('selfupdate-modal-title');
  var progressFill = document.getElementById('selfupdate-modal-progress-fill');
  var detailEl = document.getElementById('selfupdate-modal-detail');
  var statusEl = document.getElementById('selfupdate-modal-status');
  var errorEl = document.getElementById('selfupdate-modal-error');
  var cancelBtn = document.getElementById('selfupdate-modal-cancel');
  var closeBtn = document.getElementById('selfupdate-modal-close');
  if (!overlay || !card || !titleEl || !progressFill || !detailEl || !statusEl || !errorEl || !cancelBtn || !closeBtn) {
    console.debug('[self-update-modal] init aborted; missing node(s):'
      + ' overlay=' + !!overlay + ' card=' + !!card + ' title=' + !!titleEl
      + ' fill=' + !!progressFill + ' detail=' + !!detailEl + ' status=' + !!statusEl
      + ' error=' + !!errorEl + ' cancel=' + !!cancelBtn + ' close=' + !!closeBtn);
    return;
  }

  var modalOpen = false;
  // 'idle' | 'downloading' | 'staged' | 'restarting' | 'done'
  var phase = 'idle';
  var stagedPath = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setState(state) {
    card.classList.remove('download-modal-card--loading');
    card.classList.remove('download-modal-card--error');
    card.classList.remove('download-modal-card--success');
    if (state) card.classList.add('download-modal-card--' + state);
  }

  function setProgress(frac, label) {
    if (typeof frac === 'number' && frac >= 0) {
      var p = Math.round(Math.max(0, Math.min(1, frac)) * 100);
      progressFill.style.width = p + '%';
    }
    if (label != null) detailEl.innerHTML = escapeHtml(label);
  }

  function setError(msg) {
    setState('error');
    errorEl.innerHTML = '<span>' + escapeHtml(msg == null ? 'Unknown error' : msg) + '</span>';
    statusEl.innerHTML = 'Update failed.';
    closeBtn.innerHTML = 'Close';
    phase = 'done';
  }

  // The progress surface handed to the bundle's self-update API.
  var ui = {
    status: function (m) { statusEl.innerHTML = escapeHtml(m); },
    progress: function (frac, label) { setProgress(frac, label); },
  };

  async function startInstall() {
    phase = 'downloading';
    titleEl.innerHTML = 'Updating Brewser';
    setState('loading');
    progressFill.style.width = '0%';
    detailEl.innerHTML = '';
    statusEl.innerHTML = 'Preparing…';

    var api = globalThis.__brewserSelfUpdate;
    if (!api || typeof api.prepare !== 'function') {
      setError('Self-update is unavailable in this build.');
      return;
    }
    var res;
    try {
      res = await api.prepare(ui);
    } catch (e) {
      setError('Update error: ' + (e && e.message ? e.message : String(e)));
      return;
    }
    if (!modalOpen) return; // user dismissed mid-flight; staged artifacts are harmless

    if (res && res.outcome === 'up-to-date') {
      setState('success');
      setProgress(1, '');
      statusEl.innerHTML = 'Brewser is already up to date.';
      closeBtn.innerHTML = 'Close';
      phase = 'done';
      return;
    }
    if (!res || res.outcome === 'error') {
      setError((res && (res.message || res.reason)) || 'Update failed.');
      return;
    }
    // outcome === 'staged'
    stagedPath = res.stagedPath || null;
    phase = 'staged';
    setState('success');
    setProgress(1, '');
    statusEl.innerHTML = 'Update ready' + (res.version ? ' (v' + escapeHtml(res.version) + ')' : '')
      + '. Restart to finish installing.';
    closeBtn.innerHTML = 'Restart Now';
  }

  async function doRestart() {
    if (phase === 'restarting') return;
    var api = globalThis.__brewserSelfUpdate;
    if (!stagedPath || !api || typeof api.applyStaged !== 'function') { close(); return; }
    phase = 'restarting';
    statusEl.innerHTML = 'Restarting Brewser…';
    detailEl.innerHTML = 'Do not power off.';
    try {
      // Never returns on success — the console relaunches into the staged build.
      await api.applyStaged(stagedPath);
    } catch (e) {
      setError('Restart failed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  function open() {
    if (modalOpen) return;
    modalOpen = true;
    phase = 'idle';
    stagedPath = null;
    overlay.classList.add('app-modal-overlay--open');
    // Defer so the modal paints its loading state before prepare()'s first
    // synchronous step (a config/URL error would otherwise flip straight to
    // error before the user sees the modal at all).
    Promise.resolve().then(function () { if (modalOpen) startInstall(); });
  }

  function close() {
    if (!modalOpen) return;
    // Don't allow a dismiss to strand the reboot once it's underway.
    if (phase === 'restarting') return;
    modalOpen = false;
    overlay.classList.remove('app-modal-overlay--open');
    setState('');
  }

  cancelBtn.addEventListener('click', function (e) {
    close();
    if (e && e.stopPropagation) e.stopPropagation();
  });
  closeBtn.addEventListener('click', function (e) {
    if (phase === 'staged') doRestart();
    else close();
    if (e && e.stopPropagation) e.stopPropagation();
  });

  // Backdrop tap → close, but never mid-download / mid-restart.
  overlay.addEventListener('click', function (e) {
    if (e && e.target === overlay && phase !== 'downloading' && phase !== 'restarting') close();
  });

  // Gate flip so B routes through contextmenu (same pattern as sibling modals).
  window.addEventListener('mousedown', function () { /* gate */ });
  window.addEventListener('contextmenu', function (e) {
    if (!modalOpen) return;
    if (phase !== 'downloading' && phase !== 'restarting') {
      close();
      if (e && e.preventDefault) e.preventDefault();
    }
    if (e && e.stopPropagation) e.stopPropagation();
  });
  window.addEventListener('keydown', function (e) {
    if (!modalOpen) return;
    var key = e && e.key;
    if ((key === 'Escape' || key === 'Esc') && phase !== 'downloading' && phase !== 'restarting') {
      close();
      if (e && e.preventDefault) e.preventDefault();
    }
  });

  globalThis.__brewserOpenSelfUpdateModal = function () { open(); };
  console.debug('[self-update-modal] wired');
})();
