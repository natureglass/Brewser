// forwarder-modal.js — the "Create shortcut" (app forwarder) dialog.
//
// Opened by missing-app-modal.js from the app modal's "Create shortcut" button
// (installed apps only) via globalThis.__brewserOpenForwarderModal(detail).
// Two phases in one card (reusing the download modal's progress/status/error
// CSS): a confirmation slot (explanation + "include a copy" checkbox, default
// OFF) then generation progress. All privileged work is done by the shell seam
// globalThis.__brewserCreateForwarder (probe + create); this script is only UI.
(function () {
  var overlay = document.getElementById('forwarder-modal-overlay');
  var card = document.getElementById('forwarder-modal-card');
  var titleEl = document.getElementById('forwarder-modal-title');
  var confirmEl = document.getElementById('forwarder-modal-confirm');
  var explainEl = document.getElementById('forwarder-modal-explain');
  var embedRow = document.getElementById('forwarder-modal-embed-row');
  var embedCb = document.getElementById('forwarder-modal-embed');
  var embedLabel = document.getElementById('forwarder-modal-embed-label');
  var embedNote = document.getElementById('forwarder-modal-embed-note');
  var progressEl = document.getElementById('forwarder-modal-progress');
  var fillEl = document.getElementById('forwarder-modal-progress-fill');
  var errorEl = document.getElementById('forwarder-modal-error');
  var statusEl = document.getElementById('forwarder-modal-status');
  var cancelBtn = document.getElementById('forwarder-modal-cancel');
  var createBtn = document.getElementById('forwarder-modal-create');
  var closeBtn = document.getElementById('forwarder-modal-close');
  if (!overlay || !card || !createBtn || !confirmEl) return;

  var modalOpen = false;
  var currentId = null;
  var currentTitle = '';
  var busy = false;

  function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function setCardState(state) {
    card.classList.remove(
      'download-modal-card--loading',
      'download-modal-card--success',
      'download-modal-card--error'
    );
    if (state) card.classList.add('download-modal-card--' + state);
  }

  function toConfirm() {
    setCardState('');
    show(confirmEl, true); show(progressEl, false); show(errorEl, false);
    statusEl.textContent = '';
    createBtn.classList.remove('app-modal-btn--hidden');
    cancelBtn.classList.remove('app-modal-btn--hidden');
    closeBtn.classList.add('app-modal-btn--hidden');
  }
  function toLoading() {
    setCardState('loading');
    show(confirmEl, false); show(progressEl, true); show(errorEl, false);
    createBtn.classList.add('app-modal-btn--hidden');
    cancelBtn.classList.add('app-modal-btn--hidden');
    closeBtn.classList.add('app-modal-btn--hidden');
  }
  function toSuccess(msg) {
    setCardState('success');
    show(confirmEl, false); show(progressEl, false); show(errorEl, false);
    statusEl.textContent = msg;
    createBtn.classList.add('app-modal-btn--hidden');
    cancelBtn.classList.add('app-modal-btn--hidden');
    closeBtn.classList.remove('app-modal-btn--hidden');
  }
  function toError(msg) {
    setCardState('error');
    show(confirmEl, false); show(progressEl, false); show(errorEl, true);
    if (errorEl) errorEl.textContent = msg;
    statusEl.textContent = 'Couldn’t create the shortcut.';
    createBtn.classList.add('app-modal-btn--hidden');
    cancelBtn.classList.add('app-modal-btn--hidden');
    closeBtn.classList.remove('app-modal-btn--hidden');
  }

  function close() {
    if (busy) return; // never dismiss mid-generation
    overlay.classList.remove('app-modal-overlay--open');
    modalOpen = false;
  }

  async function open(detail) {
    if (modalOpen) return;
    var id = detail && detail.id;
    if (!id) return;
    currentId = id;
    currentTitle = (detail && detail.name) || id;
    var name = currentTitle;

    titleEl.textContent = 'Create shortcut';
    explainEl.textContent =
      'Create a shortcut for ' + name + ' in your Homebrew Menu. Launch it ' +
      'there to open ' + name + ' straight from Brewser — it always runs the ' +
      'version you have installed.';
    embedCb.checked = false;
    embedCb.disabled = true; // enabled after the probe confirms embed is possible
    embedRow.style.opacity = '0.6';
    embedLabel.textContent = 'Include a copy of ' + name + '.';
    embedNote.textContent = '';
    toConfirm();
    overlay.classList.add('app-modal-overlay--open');
    modalOpen = true;

    var api = globalThis.__brewserCreateForwarder;
    if (!api || typeof api.probe !== 'function') return; // link-only still works
    try {
      var p = await api.probe(id);
      if (!modalOpen || currentId !== id) return;
      if (p && p.canEmbed) {
        embedCb.disabled = false;
        embedRow.style.opacity = '1';
        embedLabel.textContent = 'Include a copy of ' + name + ' (~' + mb(p.embedSizeBytes) + ')';
        embedNote.textContent = 'Lets the shortcut reinstall ' + name + ' if you ever delete it.';
      } else {
        embedCb.disabled = true;
        embedCb.checked = false;
        embedRow.style.opacity = '0.6';
        embedLabel.textContent = 'Include a copy of ' + name;
        embedNote.textContent = (p && p.reason === 'no-inventory')
          ? 'Re-download ' + name + ' in Brewser first to include a copy.'
          : '';
      }
    } catch (e) {
      // Probe failed → leave embed disabled; the link-only shortcut still works.
      embedCb.disabled = true;
      embedRow.style.opacity = '0.6';
    }
  }

  function friendlyError(res) {
    var reason = res && res.reason;
    if (reason === 'NO_SPACE') return 'Your SD card is full. Nothing was changed.';
    if (reason === 'NO_INVENTORY') return 'Re-download ' + currentTitle + ' in Brewser first to include a copy.';
    if (reason === 'INCOMPLETE') return 'Some of ' + currentTitle + '’s files are missing — re-download it first.';
    if (reason === 'NOT_INSTALLED') return currentTitle + ' isn’t installed.';
    return 'Something went wrong and nothing was changed.';
  }

  async function doCreate() {
    if (busy) return;
    var api = globalThis.__brewserCreateForwarder;
    if (!api || typeof api.create !== 'function') {
      toError('Shortcuts aren’t available in this version of Brewser.');
      return;
    }
    busy = true;
    toLoading();
    statusEl.textContent = 'Working…';
    if (fillEl) fillEl.style.width = '0%';
    var ui = {
      status: function (m) { statusEl.textContent = m; },
      progress: function (frac) {
        if (!fillEl) return;
        if (typeof frac === 'number' && frac >= 0) {
          fillEl.style.width = Math.round(frac * 100) + '%';
        } else {
          fillEl.style.width = '100%'; // indeterminate → full bar
        }
      }
    };
    var res;
    try {
      res = await api.create({ appId: currentId, embed: !!embedCb.checked }, ui);
    } catch (e) {
      res = { outcome: 'error' };
    }
    busy = false;
    if (!res || res.outcome !== 'ok') { toError(friendlyError(res)); return; }
    toSuccess('Done — close Brewser and look for ' + currentTitle + ' in your Homebrew Menu.');
  }

  cancelBtn.addEventListener('click', function (e) { close(); if (e && e.stopPropagation) e.stopPropagation(); });
  closeBtn.addEventListener('click', function (e) { close(); if (e && e.stopPropagation) e.stopPropagation(); });
  createBtn.addEventListener('click', function (e) { doCreate(); if (e && e.stopPropagation) e.stopPropagation(); });
  overlay.addEventListener('click', function (e) { if (e && e.target === overlay) close(); });

  globalThis.__brewserOpenForwarderModal = function (detail) { open(detail || {}); };
})();
