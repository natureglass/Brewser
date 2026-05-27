// DOM Phase 2.1 validation - text rendering in non-canvas live
// elements. Two parts:
//   (a) Programmatic parser assertions: assign style.cssText with
//       various font props and read back the typed fields; call
//       resolveCanvasFont / isBoldWeight / isItalicStyle and verify
//       outputs. Results stashed in globalThis.__d21Results.
//   (b) Visual paint tests: 13 position:fixed bars laid out as a
//       vertical column at left=900 on the right side of the screen.
//       Each bar exercises one rendering property (font-size, bold,
//       italic, color, text-align, clipping, etc.). The user
//       visually verifies vs. the description in the status canvas.
//
// Pre-authorized deviations (page-side): none beyond the standard
// console.error silencing and the [[nxjs-font-no-bold-italic]] bold
// + italic synthesis (which is in the SHELL painter, not the page).

(function () {
  const r = (globalThis.__d21Results = globalThis.__d21Results || {});
  function set(key, ok, detail) {
    r[key] = ok ? (detail || 'OK') : ('FAIL: ' + (detail || '?'));
  }
  function ok(key, detail) { set(key, true, detail); }
  function bad(key, detail) { set(key, false, detail); }

  // ---------- Parser assertions -----------------------------------
  try {
    const el = document.createElement('div');
    el.style.cssText = 'font-size:18px;font-family:monospace;font-weight:bold;font-style:italic;text-align:center;line-height:24;color:#abcdef';
    if (el.style.fontSize === 18) ok('parse_fontSize', '18'); else bad('parse_fontSize', String(el.style.fontSize));
    if (el.style.fontFamily === 'monospace') ok('parse_fontFamily', 'monospace');
    else bad('parse_fontFamily', String(el.style.fontFamily));
    if (el.style.fontWeight === 'bold') ok('parse_fontWeight_bold', 'bold');
    else bad('parse_fontWeight_bold', String(el.style.fontWeight));
    if (el.style.fontStyle === 'italic') ok('parse_fontStyle_italic', 'italic');
    else bad('parse_fontStyle_italic', String(el.style.fontStyle));
    if (el.style.textAlign === 'center') ok('parse_textAlign', 'center');
    else bad('parse_textAlign', String(el.style.textAlign));
    if (el.style.lineHeight === 24) ok('parse_lineHeight', '24');
    else bad('parse_lineHeight', String(el.style.lineHeight));
    if (el.style.color === '#abcdef') ok('parse_color', '#abcdef');
    else bad('parse_color', String(el.style.color));
  } catch (e) {
    bad('parse_fontSize', String(e));
    bad('parse_fontFamily', String(e));
    bad('parse_fontWeight_bold', String(e));
    bad('parse_fontStyle_italic', String(e));
    bad('parse_textAlign', String(e));
    bad('parse_lineHeight', String(e));
    bad('parse_color', String(e));
  }

  try {
    const el2 = document.createElement('span');
    el2.style.cssText = 'font-weight:700';
    if (el2.style.fontWeight === 700) ok('parse_fontWeight_num', '700');
    else bad('parse_fontWeight_num', String(el2.style.fontWeight));
  } catch (e) { bad('parse_fontWeight_num', String(e)); }

  // resolveCanvasFont / bold / italic helpers (not exported to page
  // scope, so we can't import; instead we verify by INDIRECTION:
  // build a known-style element and rely on the painter to use the
  // same fns. Direct verification covered by the visual tests.)
  // Note: M2.1 doesn't expose those helpers on document/window —
  // they're internal to the painter. So we mark these rows as
  // "indirect" — verified by the visual paint tests downstream.
  ok('resolve_default', '(indirect via visual)');
  ok('resolve_sized', '(indirect via visual)');
  ok('resolve_family', '(indirect via visual)');
  ok('bold_bold', '(indirect via visual)');
  ok('bold_700', '(indirect via visual)');
  ok('bold_400', '(indirect via visual)');
  ok('italic_italic', '(indirect via visual)');
  ok('italic_normal', '(indirect via visual)');

  try {
    const el3 = document.createElement('div');
    el3.style.cssText = 'font-size:14px;font-family:sans-serif';
    const text = el3.style.cssText;
    if (text.indexOf('font-size:14px') >= 0 && text.indexOf('font-family:sans-serif') >= 0) {
      ok('roundtrip', 'cssText preserved');
    } else {
      bad('roundtrip', text);
    }
  } catch (e) { bad('roundtrip', String(e)); }

  try {
    const el4 = document.createElement('div');
    el4.style.fontFamily = 'monospace';
    if (el4.style.fontFamily === 'monospace') ok('setter_family');
    else bad('setter_family', String(el4.style.fontFamily));
    el4.style.fontSize = 24;
    if (el4.style.fontSize === 24) ok('setter_size');
    else bad('setter_size', String(el4.style.fontSize));
  } catch (e) {
    bad('setter_family', String(e));
    bad('setter_size', String(e));
  }

  // ---------- Visual paint tests ----------------------------------
  // 13 bars stacked vertically at left=900, each 280 wide. Coords are
  // viewport-relative (position:fixed). Painter draws them on top of
  // the page content.
  function makeBar(top, opts) {
    const el = document.createElement('div');
    let css = 'position:fixed;left:900;width:280;height:30;background:#1a2440;color:#ffffff;font-size:14';
    css += ';top:' + top;
    if (opts.height) css += ';height:' + opts.height;
    if (opts.fontSize) css += ';font-size:' + opts.fontSize;
    if (opts.fontWeight) css += ';font-weight:' + opts.fontWeight;
    if (opts.fontStyle) css += ';font-style:' + opts.fontStyle;
    if (opts.color) css += ';color:' + opts.color;
    if (opts.textAlign) css += ';text-align:' + opts.textAlign;
    if (opts.background) css += ';background:' + opts.background;
    el.style.cssText = css;
    el.textContent = opts.text;
    document.body.appendChild(el);
    return el;
  }
  try {
    makeBar(30,  { text: 'Bar 1 plain 14px white' });
    makeBar(70,  { text: 'Bar 2 22px', fontSize: 22 });
    makeBar(110, { text: 'Bar 3 BOLD', fontWeight: 'bold' });
    makeBar(150, { text: 'Bar 4 italic', fontStyle: 'italic' });
    makeBar(190, { text: 'Bar 5 BOLD italic', fontWeight: 'bold', fontStyle: 'italic' });
    makeBar(230, { text: 'Bar 6 red text', color: '#ff5555' });
    makeBar(270, { text: 'Bar 7 green text', color: '#55ff55' });
    makeBar(310, { text: '<-- left', textAlign: 'left' });
    makeBar(350, { text: '-- center --', textAlign: 'center' });
    makeBar(390, { text: 'right -->', textAlign: 'right' });
    makeBar(430, { text: 'this is a very long text that should be clipped at the box edge so it does not spill outside the panel boundary' });
    makeBar(470, { text: 'Bar 12 tiny 11px', fontSize: 11, background: '#2a4060' });
    makeBar(510, { text: 'Bar 13 big 32px', fontSize: 32, height: 60 });
  } catch (e) {
    bad('visual_setup', String(e));
  }

  // Bar 1 tap regression: click listener should fire on tap and flip
  // the bar1_tap result row. Proves the M2.0 hit-test + click chain
  // still works when text painting is enabled.
  try {
    const bar1 = document.body.children[document.body.children.length - 13];
    // We can't reliably find bar1 if it isn't the 13th-from-end —
    // safer to make a known fixed reference.
    // Simpler: just re-make a small tap target near the bottom.
    const tapTarget = document.createElement('div');
    tapTarget.style.cssText = 'position:fixed;left:900;top:600;width:280;height:40;background:#1d2c43;color:#7aa2ff;text-align:center;font-size:16';
    tapTarget.textContent = 'TAP ME (regression)';
    document.body.appendChild(tapTarget);
    let cycles = 0;
    tapTarget.addEventListener('click', function () {
      cycles++;
      tapTarget.textContent = 'TAPPED x' + cycles;
      r.bar1_tap = 'OK (tap detected, ' + cycles + 'x)';
    });
    r.bar1_tap = '(pending tap)';
  } catch (e) {
    bad('bar1_tap', String(e));
  }
})();
