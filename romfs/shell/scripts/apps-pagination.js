// apps-pagination.js — client-side pagination for the Apps library grid.
//
// SCALE MODEL: the shell renders only PAGE 1 of each tab into the live DOM and
// parses the (already-local) catalogue once, holding the sorted library in
// native memory. This script asks the shell's `globalThis.__brewserAppsPager`
// hook to render pages 2…N on demand — each call returns just ~maxPerPage cards'
// HTML, which we swap into the grid. So the live DOM never holds more than one
// page per tab, and a 10,000-app catalogue paginates as fast as a 12-app one:
// no giant DOM, no giant string, memory flat in the page count.
//
// Off-page cards therefore cost NOTHING in the page — they're regenerated from
// the shell's parsed catalogue only when navigated to (the engine drops
// <script>/<template> during live-DOM conversion, so parking inert HTML text in
// the page isn't possible anyway).
//
// Banners stay lazy: cards render with `data-src` and we promote only the
// visible page's banners to `src` (via banner-loader.js). Offline (Citron) the
// cards + paging work from the local catalogue; only remote banners fail and
// fall back to download.png. So pagination is fully verifiable with no network.
//
// DOM notes (LiveElement): off-page cards are REPLACED (grid.innerHTML), never
// hidden. Cards swapped in after load need their modal tap handler re-attached
// (missing-app-modal wires per-card at load), so we call
// `globalThis.__brewserWireAppCards` after every swap. Tab switches are detected
// via `change` on the tab radios (the engine fires it on label tap).
(function () {
  'use strict';

  var doc = globalThis.document;
  if (!doc || !doc.body) {
    console.debug('[apps-pagination] no document/body; aborting');
    return;
  }

  var pagerApi = globalThis.__brewserAppsPager;
  if (!pagerApi || typeof pagerApi.render !== 'function') {
    // No shell hook (older engine) — page 1 is already server-rendered and the
    // pagers stay hidden; nothing to drive. Degrade quietly.
    console.debug('[apps-pagination] __brewserAppsPager unavailable; page-1-only');
  }

  // Tab id → the radio input that drives its CSS `:checked` panel.
  var TAB_RADIO = {
    featured: 'apps-tab-featured',
    recent: 'apps-tab-recent',
    popular: 'apps-tab-popular',
    toprated: 'apps-tab-toprated',
    downloads: 'apps-tab-downloads',
    myapps: 'apps-tab-myapps',
  };

  function readPerPage() {
    var raw = doc.body.getAttribute && doc.body.getAttribute('data-max-per-page');
    var n = parseInt(raw, 10);
    if (!isFinite(n) || n < 1) n = 12;
    if (n > 60) n = 60;
    return n;
  }
  var PER_PAGE = (pagerApi && typeof pagerApi.perPage === 'function')
    ? (pagerApi.perPage() || readPerPage())
    : readPerPage();

  function promoteGrid(grid) {
    if (!grid) return;
    if (typeof globalThis.__brewserPromoteBanners === 'function') {
      globalThis.__brewserPromoteBanners(grid);
      return;
    }
    // Inline fallback if banner-loader.js didn't load.
    var imgs = null;
    try { imgs = grid.querySelectorAll('[data-src]'); } catch (_) { imgs = null; }
    if (!imgs) return;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.getAttribute && !im.getAttribute('src')) {
        var s = im.getAttribute('data-src');
        if (s) im.setAttribute('src', s);
      }
    }
  }

  // Re-attach the modal tap handler to cards swapped in after load.
  function rewireCards() {
    var f = globalThis.__brewserWireAppCards;
    if (typeof f === 'function') f();
  }

  // The `.app-grid` inside a panel (first matching child).
  function gridOf(panel) {
    if (!panel.children) return null;
    for (var i = 0; i < panel.children.length; i++) {
      var c = panel.children[i];
      if (c.classList && c.classList.contains('app-grid')) return c;
    }
    return null;
  }

  // The pager block + its buttons/label inside a panel.
  function pagerOf(panel) {
    var pager = null;
    if (panel.children) {
      for (var i = 0; i < panel.children.length; i++) {
        var c = panel.children[i];
        if (c.classList && c.classList.contains('app-pager')) { pager = c; break; }
      }
    }
    var prevBtn = null, nextBtn = null, label = null;
    if (pager && pager.children) {
      for (var j = 0; j < pager.children.length; j++) {
        var e = pager.children[j];
        if (!e.classList) continue;
        if (e.classList.contains('app-pager__prev')) prevBtn = e;
        else if (e.classList.contains('app-pager__next')) nextBtn = e;
        else if (e.classList.contains('app-pager__label')) label = e;
      }
    }
    return { pager: pager, prevBtn: prevBtn, nextBtn: nextBtn, label: label };
  }

  function toggleDisabled(btn, disabled) {
    if (!btn || !btn.classList) return;
    if (disabled) btn.classList.add('app-pager__btn--disabled');
    else btn.classList.remove('app-pager__btn--disabled');
  }

  function updatePager(ctrl) {
    if (!ctrl.pager || !ctrl.pager.classList) return;
    if (ctrl.pages <= 1) {
      ctrl.pager.classList.add('app-pager--hidden');
      return;
    }
    ctrl.pager.classList.remove('app-pager--hidden');
    if (ctrl.label) ctrl.label.innerHTML = 'Page ' + ctrl.page + ' of ' + ctrl.pages;
    toggleDisabled(ctrl.prevBtn, ctrl.page <= 1);
    toggleDisabled(ctrl.nextBtn, ctrl.page >= ctrl.pages);
  }

  // Snap the whole page back to the top + force a hard repaint. Called after a
  // page change (Prev/Next) AND after a tab switch (Featured → Popular, …), so
  // the newly-shown grid's first row lands at the top of the viewport instead
  // of inheriting the previous view's scroll offset (page scroll is one shared
  // shell-level state, so it carries across both).
  //
  // __swbScrollTop zeroes the shell's scroll offset, nukes the overlay cache +
  // flips the repaint flag so the next loop rebuilds the bake at the top of the
  // page. It's a superset of __swbRepaint (the repaint the updates/download
  // modals use after mutating cards) plus the scroll reset. On an older engine
  // without it, fall back to __swbRepaint (repaint only, no scroll reset).
  function scrollTopAndRepaint() {
    if (typeof globalThis.__swbScrollTop === 'function') {
      try { globalThis.__swbScrollTop(); }
      catch (err) { console.debug('[apps-pagination] __swbScrollTop failed: ' + (err && err.message)); }
    } else if (typeof globalThis.__swbRepaint === 'function') {
      try { globalThis.__swbRepaint(); }
      catch (err) { console.debug('[apps-pagination] __swbRepaint failed: ' + (err && err.message)); }
    }
  }

  // Render + show page `n` of a tab: ask the shell for that page's cards, swap
  // them into the grid, re-wire taps, promote banners, refresh the pager.
  // The page state + pager label are updated FIRST so the "Page X of Y"
  // indicator stays in sync even if a render hiccups; the render is guarded so
  // a bad page can't wedge the pager.
  function showPage(ctrl, n) {
    if (n < 1) n = 1;
    if (n > ctrl.pages) n = ctrl.pages;
    ctrl.page = n;
    updatePager(ctrl);
    if (ctrl.grid && pagerApi && typeof pagerApi.render === 'function') {
      var html = null;
      try { html = pagerApi.render(ctrl.tab, n); } catch (e) {
        console.debug('[apps-pagination] render failed: ' + (e && e.message));
      }
      if (typeof html === 'string') {
        ctrl.grid.innerHTML = html;
        rewireCards();
        promoteGrid(ctrl.grid);
      }
    }
    // Snap back to the top + force a hard repaint. Paging Prev/Next swaps in a
    // fresh grid; without resetting scroll the new page would inherit the old
    // page's scroll offset, dropping the user partway down the new (often
    // shorter) grid instead of at its first row. The in-place grid.innerHTML +
    // pager-label swaps also only bump their local cache versions, so the hard
    // repaint inside scrollTopAndRepaint is what rebuilds the shell's baked body
    // cache from the post-mutation tree (same reason updates/download modals
    // repaint after mutating cards).
    scrollTopAndRepaint();
  }

  var panels = [];
  try { panels = doc.querySelectorAll('[data-tab]'); } catch (_) { panels = []; }

  var controllers = [];
  for (var p = 0; p < panels.length; p++) {
    var panel = panels[p];
    var tab = panel.getAttribute('data-tab');
    var parts = pagerOf(panel);
    var pages = (pagerApi && typeof pagerApi.totalPages === 'function')
      ? pagerApi.totalPages(tab)
      : 1;
    var ctrl = {
      tab: tab,
      panel: panel,
      grid: gridOf(panel),
      page: 1,
      pages: (pages && pages > 0) ? pages : 1,
      pager: parts.pager,
      prevBtn: parts.prevBtn,
      nextBtn: parts.nextBtn,
      label: parts.label,
    };
    controllers.push(ctrl);

    // Prev/Next taps fire `click` (findTapIntent → button). Guard on bounds.
    (function (c) {
      if (c.prevBtn) c.prevBtn.addEventListener('click', function () {
        if (c.page > 1) showPage(c, c.page - 1);
      });
      if (c.nextBtn) c.nextBtn.addEventListener('click', function () {
        if (c.page < c.pages) showPage(c, c.page + 1);
      });
    })(ctrl);

    // Page 1 is already server-rendered live (and modal-wired at load) — just
    // configure the pager UI for it.
    updatePager(ctrl);
  }

  function ctrlFor(tab) {
    for (var i = 0; i < controllers.length; i++) {
      if (controllers[i].tab === tab) return controllers[i];
    }
    return null;
  }

  // A panel is "active" (visible) when its tab radio is checked. A panel with
  // NO matching radio — the home page's single section, which has no tab strip —
  // is always active. This lets ONE controller drive both apps.html
  // (radio-gated tabs) and home.html (one always-on section).
  function isActive(ctrl) {
    var r = doc.getElementById('apps-tab-' + ctrl.tab);
    return r ? r.hasAttribute('checked') : true;
  }

  // Promote each active panel's initial (server-rendered) page-1 banners so the
  // visible page's images load; inactive tabs stay unfetched until shown.
  for (var a = 0; a < controllers.length; a++) {
    if (isActive(controllers[a])) promoteGrid(controllers[a].grid);
  }

  // Tab switches (apps.html only — home has no tab radios, so these listeners
  // never attach there): the engine fires `change` on the newly-checked radio
  // (and the one it deselected). Act only for the one now checked, and promote
  // its current page's banners (the grid already holds that page — server-
  // rendered page 1, or whatever page the user last navigated it to). Then snap
  // to the top: page scroll is shared shell state, so a user scrolled down on
  // Featured would otherwise land mid-grid when switching to Popular. The guard
  // above means this fires once (for the tab now checked), not for the
  // deselected one.
  for (var t in TAB_RADIO) {
    if (!Object.prototype.hasOwnProperty.call(TAB_RADIO, t)) continue;
    (function (tabId) {
      var r = doc.getElementById(TAB_RADIO[tabId]);
      if (!r) return;
      r.addEventListener('change', function () {
        if (!r.hasAttribute('checked')) return;
        var c = ctrlFor(tabId);
        if (c) promoteGrid(c.grid);
        scrollTopAndRepaint();
      });
    })(t);
  }

  console.debug('[apps-pagination] wired; perPage=' + PER_PAGE
    + ' panels=' + controllers.length);
})();
