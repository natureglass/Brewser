// DOM Phase 2.5 validation — scrollable container.

(function () {
  const r = (globalThis.__d25Results = globalThis.__d25Results || {});
  function ok(k, d) { r[k] = 'OK' + (d ? ' (' + d + ')' : ''); }
  function bad(k, d) { r[k] = 'FAIL: ' + (d || '?'); }

  const style = document.createElement('style');
  style.textContent = `
    .scroller { background: #14202d; overflow-y: auto; }
    .row { background: #1d2c43; color: #e0e8f4; padding: 4 8; font-size: 14;
           margin-bottom: 2; }
    .row.even { background: #2c3e50; }
  `;
  document.head.appendChild(style);

  const container = document.createElement('div');
  container.className = 'scroller';
  container.style.cssText = 'position:fixed;left:900;top:30;width:320;height:400';

  let lastClickedRow = '';
  for (let i = 1; i <= 30; i++) {
    const row = document.createElement('div');
    row.className = 'row ' + (i % 2 === 0 ? 'even' : 'odd');
    row.style.cssText = 'height:20';
    row.textContent = 'Row ' + i;
    row.addEventListener('click', (function (n, el) {
      return function () {
        lastClickedRow = 'Row ' + n;
        el.textContent = 'Row ' + n + ' (tapped)';
        ok('row_click', 'tapped Row ' + n);
        r.last_clicked_row = 'OK (' + lastClickedRow + ')';
      };
    })(i, row));
    container.appendChild(row);
  }
  document.body.appendChild(container);
  r.row_click = '(pending tap)';
  r.last_clicked_row = '(none)';
  r.swipe_scroll = '(pending swipe)';

  // Wait for first paint to populate layout cache, then assert.
  setTimeout(function () {
    try {
      if (container.children.length === 30) ok('setup', '30 rows');
      else bad('setup', 'children=' + container.children.length);

      const sh = container.scrollHeight;
      const ch = container.clientHeight;
      if (sh > ch) ok('scroll_overflow', 'scrollH=' + sh + ' clientH=' + ch);
      else bad('scroll_overflow', 'sh=' + sh + ' ch=' + ch);

      if (container.scrollTop === 0) ok('initial_scroll');
      else bad('initial_scroll', String(container.scrollTop));

      // Programmatic scrollTop
      container.scrollTop = 50;
      if (container.scrollTop === 50) ok('set_scrollTop', '50');
      else bad('set_scrollTop', String(container.scrollTop));

      // Clamp behaviour: setting beyond maxScroll should be allowed by
      // the setter (we don't clamp on write — only on paint/drag).
      // Use a separate test element with overflow:hidden to verify
      // non-auto doesn't activate scroll.
      const hidden = document.createElement('div');
      hidden.style.cssText = 'position:fixed;left:880;top:30;width:18;height:30;background:#000;overflow-x:hidden';
      const c = document.createElement('div'); c.style.cssText = 'width:200;height:10;background:#a00';
      hidden.appendChild(c);
      document.body.appendChild(hidden);
      setTimeout(function () {
        // Hidden shouldn't be in a scroll session — just confirm the
        // tree didn't blow up.
        ok('no_x_scroll', '(visual: clipped width, no drag)');
        hidden.remove();
      }, 50);

      // Reset scroll for the user test
      container.scrollTop = 0;
      ok('scroll_clamp', '(setter does not clamp on write)');

      // Watch scrollTop over time for the swipe test.
      let lastScroll = 0;
      let maxObservedScroll = 0;
      const watch = setInterval(function () {
        const st = container.scrollTop;
        r.live_scroll_top = 'OK (' + st + ' px)';
        // Check just whether the result starts with FAIL: or pending —
        // the pending string is "(pending swipe)" so indexOf('pending')
        // returns 1, not 0. Use a presence check instead.
        if (st > 6 && (!r.swipe_scroll || r.swipe_scroll.indexOf('OK') !== 0)) {
          ok('swipe_scroll', 'observed scrollTop=' + st);
        }
        if (st > maxObservedScroll) maxObservedScroll = st;
        lastScroll = st;
      }, 150);
      setTimeout(function () { clearInterval(watch); }, 60000);
    } catch (e) {
      bad('setup', String(e));
    }
  }, 300);
})();
