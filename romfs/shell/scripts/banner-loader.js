// banner-loader.js — lazy promotion of app-card banners.
//
// The shell emits every app-card banner as `<img class="app-banner"
// data-src="…">` with NO `src`, so the engine's <img> loader never fetches it
// at parse time. This module promotes `data-src` → `src` on demand, so the
// network only ever pulls the banners actually on screen (the whole point of
// the pagination work: a big catalogue must not fetch every remote
// appbanner.jpg up front).
//
// Two callers, selected by `<body data-lazy-banners>`:
//   - "auto" (home.html): the home teaser is a single, server-capped page, so
//     every rendered banner is visible — promote them all once on load.
//   - "paged" (apps.html): apps-pagination.js owns promotion per page + tab and
//     calls `__brewserPromoteBanners(container)` as pages become visible; this
//     file only exposes that helper there (no auto pass).
//
// Idempotent: an <img> that already has a real `src` is skipped, so re-running
// over an already-shown page costs nothing.
//
// Offline (e.g. Citron) the promoted remote banner simply fails to load and the
// engine falls back to download.png via the card's `data-fallback-src` — the
// promotion itself is a pure DOM write with no network dependency, so this runs
// fine with no internet.
(function () {
  'use strict';

  // Promote a single deferred <img> (has `data-src`, no `src` yet).
  function promoteImg(img) {
    if (!img || !img.getAttribute) return;
    if (img.getAttribute('src')) return; // already promoted
    var src = img.getAttribute('data-src');
    if (src) img.setAttribute('src', src);
  }

  // Promote every deferred banner within `container` (a card, grid, panel, or
  // the whole <body>). Prefers the attribute-selector querySelectorAll path
  // that LiveElement supports; falls back to a manual child-walk if it's
  // unavailable on this node.
  function promoteWithin(container) {
    if (!container) return;
    var imgs = null;
    try {
      if (typeof container.querySelectorAll === 'function') {
        imgs = container.querySelectorAll('[data-src]');
      }
    } catch (_) {
      imgs = null;
    }
    if (imgs && typeof imgs.length === 'number') {
      for (var i = 0; i < imgs.length; i++) promoteImg(imgs[i]);
      return;
    }
    walk(container);
  }

  // Depth-first fallback traversal via `.children` (always supported).
  function walk(el) {
    if (!el) return;
    if (el.getAttribute && el.getAttribute('data-src')) promoteImg(el);
    var kids = el.children;
    if (!kids) return;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  }

  globalThis.__brewserPromoteBanners = promoteWithin;

  var body = globalThis.document && document.body;
  var mode = (body && body.getAttribute && body.getAttribute('data-lazy-banners')) || '';
  if (mode === 'auto') {
    promoteWithin(body);
  }
  console.debug('[banner-loader] ready (mode=' + (mode || 'none') + ')');
})();
