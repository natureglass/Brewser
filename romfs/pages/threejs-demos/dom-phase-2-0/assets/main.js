// DOM Phase 2.0 validation — exhaustive static checks against the
// generic element API surface added in M2.0, plus a Stats coexistence
// test (Phase 1 + 1.5 must keep working). Each check stashes its
// result into `globalThis.__d20Results[key]` so the status canvas in
// index.html can render the pass/fail grid.
//
// Pre-authorized deviations from upstream (none — this is a
// hand-rolled validation page, not a Three.js port).
//
// Mirrored to the Citron profile via [[citron-pages-sync]] as part of
// the M2.0 ship pass; user runs the NRO per [[citron-deploy]].

(function () {
  const r = (globalThis.__d20Results = globalThis.__d20Results || {});
  function set(key, ok, detail) {
    r[key] = ok ? (detail || 'OK') : ('FAIL: ' + (detail || '?'));
  }
  function ok(key, detail) { set(key, true, detail); }
  function bad(key, detail) { set(key, false, detail); }

  // -------- classList -----------------------------------------------
  try {
    const el = document.createElement('div');
    el.classList.add('a', 'b');
    if (el.classList.contains('a') && el.classList.contains('b') && !el.classList.contains('c')) {
      ok('classList_basic', 'a,b');
    } else {
      bad('classList_basic', 'add/contains mismatch');
    }
  } catch (e) { bad('classList_basic', String(e)); }

  try {
    const el = document.createElement('div');
    el.classList.add('x');
    const r1 = el.classList.toggle('x'); // remove → false
    const r2 = el.classList.toggle('x'); // add → true
    if (r1 === false && r2 === true && el.classList.contains('x')) {
      ok('classList_toggle', 'false,true');
    } else {
      bad('classList_toggle', 'r1=' + r1 + ' r2=' + r2);
    }
  } catch (e) { bad('classList_toggle', String(e)); }

  try {
    const el = document.createElement('div');
    el.classList.toggle('x', true);
    const present = el.classList.contains('x');
    el.classList.toggle('x', true); // force=true on present → still present
    const stillPresent = el.classList.contains('x');
    el.classList.toggle('x', false);
    const removed = !el.classList.contains('x');
    if (present && stillPresent && removed) ok('classList_toggle_force', 'force ok');
    else bad('classList_toggle_force', 'p=' + present + ' sp=' + stillPresent + ' r=' + removed);
  } catch (e) { bad('classList_toggle_force', String(e)); }

  try {
    const el = document.createElement('div');
    el.className = 'foo bar baz';
    if (el.classList.contains('foo') && el.classList.contains('bar') && el.classList.contains('baz') &&
        el.className.split(/\s+/).sort().join(' ') === 'bar baz foo') {
      ok('className_roundtrip');
    } else {
      bad('className_roundtrip', el.className);
    }
  } catch (e) { bad('className_roundtrip', String(e)); }

  try {
    const el = document.createElement('div');
    el.setAttribute('class', 'one two');
    if (el.classList.contains('one') && el.classList.contains('two') &&
        el.getAttribute('class') === 'one two') {
      ok('classList_from_setattr');
    } else {
      bad('classList_from_setattr', 'attr=' + el.getAttribute('class'));
    }
  } catch (e) { bad('classList_from_setattr', String(e)); }

  // -------- parentElement / tree -----------------------------------
  try {
    const p = document.createElement('div');
    const c = document.createElement('span');
    p.appendChild(c);
    if (c.parentElement === p && c.parentNode === p && p.firstChild === c && p.lastChild === c) {
      ok('parentElement');
    } else {
      bad('parentElement', 'pe=' + (c.parentElement === p) + ' fc=' + (p.firstChild === c));
    }
  } catch (e) { bad('parentElement', String(e)); }

  try {
    const p = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    const c = document.createElement('span');
    p.appendChild(a); p.appendChild(b); p.appendChild(c);
    if (p.childNodes.length === 3 && p.firstChild === a && p.lastChild === c) {
      ok('children_basic', '3 children');
    } else {
      bad('children_basic', 'len=' + p.childNodes.length);
    }
  } catch (e) { bad('children_basic', String(e)); }

  try {
    const p = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    p.appendChild(a); p.appendChild(b);
    if (a.nextSibling === b && b.previousSibling === a &&
        a.previousSibling === null && b.nextSibling === null) {
      ok('siblings');
    } else {
      bad('siblings', 'a.next=' + (a.nextSibling === b) + ' b.prev=' + (b.previousSibling === a));
    }
  } catch (e) { bad('siblings', String(e)); }

  // -------- insertBefore / replaceChild / remove --------------------
  try {
    const p = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    const c = document.createElement('span');
    p.appendChild(a); p.appendChild(c);
    p.insertBefore(b, c);
    if (p.children[0] === a && p.children[1] === b && p.children[2] === c) {
      ok('insertBefore', 'a,b,c');
    } else {
      bad('insertBefore', 'order off');
    }
  } catch (e) { bad('insertBefore', String(e)); }

  try {
    const p = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    p.appendChild(a);
    p.insertBefore(b, null);
    if (p.children[0] === a && p.children[1] === b) {
      ok('insertBefore_null', 'appended');
    } else {
      bad('insertBefore_null');
    }
  } catch (e) { bad('insertBefore_null', String(e)); }

  try {
    const p = document.createElement('div');
    const a = document.createElement('span');
    const b = document.createElement('span');
    p.appendChild(a);
    p.replaceChild(b, a);
    if (p.children.length === 1 && p.children[0] === b && a.parentElement === null) {
      ok('replaceChild');
    } else {
      bad('replaceChild');
    }
  } catch (e) { bad('replaceChild', String(e)); }

  try {
    const p = document.createElement('div');
    const a = document.createElement('span');
    p.appendChild(a);
    a.remove();
    if (a.parentElement === null && p.children.length === 0) {
      ok('remove');
    } else {
      bad('remove');
    }
  } catch (e) { bad('remove', String(e)); }

  // -------- toggleAttribute -----------------------------------------
  try {
    const el = document.createElement('input');
    const r1 = el.toggleAttribute('disabled');
    const has1 = el.hasAttribute('disabled');
    const r2 = el.toggleAttribute('disabled');
    const has2 = el.hasAttribute('disabled');
    if (r1 === true && has1 === true && r2 === false && has2 === false) {
      ok('toggleAttribute');
    } else {
      bad('toggleAttribute', 'r1=' + r1 + ' h1=' + has1 + ' r2=' + r2 + ' h2=' + has2);
    }
  } catch (e) { bad('toggleAttribute', String(e)); }

  try {
    const el = document.createElement('input');
    el.toggleAttribute('disabled', true);
    const has = el.hasAttribute('disabled');
    el.toggleAttribute('disabled', false);
    const gone = !el.hasAttribute('disabled');
    if (has && gone) ok('toggleAttribute_force');
    else bad('toggleAttribute_force');
  } catch (e) { bad('toggleAttribute_force', String(e)); }

  // -------- textContent / innerHTML ---------------------------------
  try {
    const el = document.createElement('div');
    el.textContent = 'hello';
    if (el.textContent === 'hello' && el.innerHTML === 'hello') {
      ok('textContent');
    } else {
      bad('textContent', el.textContent);
    }
  } catch (e) { bad('textContent', String(e)); }

  try {
    const el = document.createElement('div');
    el.innerHTML = 'lil-gui label';
    if (el.textContent === 'lil-gui label') {
      ok('innerHTML', 'alias works');
    } else {
      bad('innerHTML');
    }
  } catch (e) { bad('innerHTML', String(e)); }

  // -------- getBoundingClientRect -----------------------------------
  // We append a fixed-position element so the painter pushes a viewport
  // into live-dom before the assertion runs. The viewport gets set
  // before the next render path — so the gbcr assertion below depends
  // on at least one prior frame. We defer the check by 200 ms.
  setTimeout(function () {
    try {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:30;left:50;width:120;height:40;background:#444';
      document.body.appendChild(el);
      const rect = el.getBoundingClientRect();
      if (rect && rect.width === 120 && rect.height === 40) {
        ok('gbcr_size', '120x40');
      } else {
        bad('gbcr_size', JSON.stringify(rect));
      }
      // Origin assertion: rect.left must equal viewport.x + 50.
      // Viewport.x is 0 in both normal mode and fullscreen-canvas mode;
      // viewport.y is the top inset in normal mode (typically 36 or 64
      // depending on the template). Accept anything >= 50 for left, and
      // any non-negative top.
      if (rect.left >= 50 && rect.top >= 0) {
        ok('gbcr_origin', 'left=' + rect.left + ' top=' + rect.top);
      } else {
        bad('gbcr_origin', 'left=' + rect.left + ' top=' + rect.top);
      }
      // Don't leave the test fixture on screen — remove it.
      el.remove();
    } catch (e) {
      bad('gbcr_size', String(e));
      bad('gbcr_origin', String(e));
    }
  }, 200);

  // -------- document.head -------------------------------------------
  try {
    if (document.head && document.head.tagName === 'HEAD') ok('doc_head');
    else bad('doc_head', String(document.head && document.head.tagName));
  } catch (e) { bad('doc_head', String(e)); }

  try {
    const s = document.createElement('style');
    document.head.appendChild(s);
    if (s.parentElement === document.head && document.head.children.includes(s)) {
      ok('doc_head_append');
    } else {
      bad('doc_head_append');
    }
    // querySelector for the style we just inserted
    const found = document.querySelector('head style');
    if (found === s) ok('qs_head_style');
    else bad('qs_head_style', String(found && found.tagName));
    // getElementsByTagName('style') should find it
    const styles = document.getElementsByTagName('style');
    if (Array.isArray(styles) && styles.indexOf(s) >= 0) ok('gebtn_head', 'found');
    else bad('gebtn_head', 'len=' + (styles && styles.length));
    // Cleanup
    s.remove();
  } catch (e) {
    bad('doc_head_append', String(e));
    bad('qs_head_style', String(e));
    bad('gebtn_head', String(e));
  }

  // -------- window injection ----------------------------------------
  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      ok('doc_window');
    } else {
      bad('doc_window');
    }
  } catch (e) { bad('doc_window', String(e)); }

  try {
    // Register a probe listener on window and confirm the registry
    // accepts it (we can't easily prove dispatch without faking a tap).
    let called = false;
    const probe = function () { called = true; };
    window.addEventListener('__d20_probe__', probe);
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent({ type: '__d20_probe__' });
    }
    window.removeEventListener('__d20_probe__', probe);
    if (called) ok('window_shadow', 'dispatchEvent fires registered listener');
    else bad('window_shadow', 'listener not called');
  } catch (e) { bad('window_shadow', String(e)); }

  try {
    // window.devicePixelRatio is NOT on LiveWindow; the Proxy must fall
    // through to globalThis where nx.js's installBrowserShim sets it.
    const dpr = window.devicePixelRatio;
    if (typeof dpr === 'number' && dpr > 0) {
      ok('window_fallthrough', 'dpr=' + dpr);
    } else {
      bad('window_fallthrough', 'dpr=' + dpr);
    }
  } catch (e) { bad('window_fallthrough', String(e)); }

  // -------- LiveTokenList value setter -----------------------------
  try {
    const el = document.createElement('div');
    el.classList.add('keep');
    el.className = 'a b c';                    // replaces
    if (!el.classList.contains('keep') &&
        el.classList.contains('a') &&
        el.classList.contains('b') &&
        el.classList.contains('c') &&
        el.classList.length === 3) {
      ok('tokenlist_value', 'a b c');
    } else {
      bad('tokenlist_value', el.className);
    }
  } catch (e) { bad('tokenlist_value', String(e)); }

  // -------- ownerDocument -------------------------------------------
  try {
    const el = document.createElement('div');
    if (el.ownerDocument === document) {
      ok('ownerDocument');
    } else {
      bad('ownerDocument', 'mismatch');
    }
  } catch (e) { bad('ownerDocument', String(e)); }

  // -------- Stats addon coexistence ---------------------------------
  // Phase 1 + 1.5 regression check: Stats should instantiate, mount,
  // and render. Tap-to-cycle is verified by the user touching the
  // panel after page load (sets `stats_tap` via the click listener).
  try {
    if (typeof globalThis.Stats === 'function') {
      const stats = new globalThis.Stats();
      document.body.appendChild(stats.dom);
      r.stats_inst = 'OK';
      r.stats_appended = stats.dom.parentElement === document.body ? 'OK' : 'FAIL: not attached';
      // Drive a few begin/end pairs so the panel has data to show.
      stats.begin();
      stats.end();
      // Tap-to-cycle hook: Stats's own click handler advances the panel.
      // We add a secondary listener that flips our results flag so we
      // can prove the tap reached the LiveElement.
      stats.dom.addEventListener('click', function () {
        r.stats_tap = 'OK (tap detected)';
      });
      r.stats_tap = '(pending tap)';
      // rAF loop driving begin/end so the FPS panel updates while the
      // user looks at the page. Bridges into the same RAF queue Stats
      // would normally hit.
      function tick() {
        try {
          stats.begin();
          stats.end();
          requestAnimationFrame(tick);
        } catch (_) { /* swallow — keep loop alive */ }
      }
      requestAnimationFrame(tick);
    } else {
      bad('stats_inst', 'globalThis.Stats missing');
      bad('stats_appended', 'no stats');
      bad('stats_tap', 'no stats');
    }
  } catch (e) {
    bad('stats_inst', String(e));
    bad('stats_appended', String(e));
    bad('stats_tap', String(e));
  }

  // -------- M2.0 drag-chain test ------------------------------------
  // A second tap target proves the new event chain: tap should
  // dispatch mousedown + click on the element AND wake any window
  // mousemove/mouseup listeners on touchmove/touchend. We can't test
  // mousemove without an actual swipe, so we just register a window
  // mouseup listener that flips a flag on tap-release; the user
  // verifies by tapping the band.
  try {
    const band = document.createElement('div');
    band.style.cssText = 'position:fixed;top:30;left:420;width:200;height:40;background:#1e3a4a';
    document.body.appendChild(band);
    let bandHi = false;
    band.addEventListener('click', function () {
      bandHi = !bandHi;
      band.style.background = bandHi ? '#2cc9ff' : '#1e3a4a';
      band.classList.toggle('hi', bandHi);
    });
    window.addEventListener('mouseup', function () {
      // Cleared per session; this fires on the tap-end that follows
      // every band tap (since the touchstart routed to band).
      r.window_mouse_drag = 'OK (window mouseup fired)';
    });
    r.window_mouse_drag = '(pending tap on cyan band)';
  } catch (e) {
    bad('window_mouse_drag', String(e));
  }
})();
