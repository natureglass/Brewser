// DOM Phase 2.4 validation — form widgets.

(function () {
  const r = (globalThis.__d24Results = globalThis.__d24Results || {});
  function ok(k, d) { r[k] = 'OK' + (d ? ' (' + d + ')' : ''); }
  function bad(k, d) { r[k] = 'FAIL: ' + (d || '?'); }

  // Stylesheet for nice-looking widgets.
  const style = document.createElement('style');
  style.textContent = `
    .panel { background: #14202d; color: #e0e8f4; padding: 8; display: flex; flex-direction: row; gap: 8; align-items: center; font-size: 14; }
    .label { color: #9bb1d6; width: 100; font-size: 13; }
    .widget { flex: 1; height: 24; }
    input[type=checkbox] { background: #424242; color: #2cc9ff; }
    input[type=text], input[type=number] { background: #424242; color: #ebebeb; }
    button { background: #1d2c43; color: #e0e8f4; }
    select { background: #424242; color: #ebebeb; }
    input[type=color] { width: 40; }
    [disabled] { opacity: 0.5; }
  `;
  document.head.appendChild(style);

  // ---------- Programmatic assertions ------------------------------
  try {
    const cb = document.createElement('input');
    cb.setAttribute('type', 'checkbox');
    if (cb.tagName === 'INPUT') ok('create_checkbox', 'tag=INPUT');
    else bad('create_checkbox', cb.tagName);
  } catch (e) { bad('create_checkbox', String(e)); }

  try {
    const b = document.createElement('button');
    b.textContent = 'X';
    if (b.tagName === 'BUTTON') ok('create_button');
    else bad('create_button', b.tagName);
  } catch (e) { bad('create_button', String(e)); }

  try {
    const sel = document.createElement('select');
    const o1 = document.createElement('option'); o1.textContent = 'One';
    const o2 = document.createElement('option'); o2.textContent = 'Two';
    sel.appendChild(o1); sel.appendChild(o2);
    if (sel.tagName === 'SELECT' && sel.children.length === 2) ok('create_select');
    else bad('create_select', String(sel.children.length));
  } catch (e) { bad('create_select', String(e)); }

  try {
    const cb = document.createElement('input');
    cb.setAttribute('type', 'checkbox');
    cb.checked = true;
    if (cb.checked === true) ok('checked_prop', 'set+get works');
    else bad('checked_prop', String(cb.checked));
  } catch (e) { bad('checked_prop', String(e)); }

  try {
    const t = document.createElement('input');
    t.setAttribute('type', 'text');
    t.value = 'hello';
    if (t.value === 'hello') ok('value_prop', 'set+get works');
    else bad('value_prop', String(t.value));
  } catch (e) { bad('value_prop', String(e)); }

  try {
    const cb = document.createElement('input');
    cb.setAttribute('type', 'checkbox');
    cb.toggleAttribute('checked', true);
    if (cb.hasAttribute('checked')) ok('checked_attr', 'attribute set');
    else bad('checked_attr', 'attr missing');
  } catch (e) { bad('checked_attr', String(e)); }

  // disabled-blocks-tap is verified by the 'Disabled checkbox' widget below
  // which has a click listener; if tap fires while disabled, we mark FAIL.
  r.disabled_blocks = '(pending tap on disabled checkbox)';

  // ---------- Visual widgets ---------------------------------------
  // A single column container on the right of the screen, with flex
  // rows (label + widget).
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:880;top:30;width:320;display:flex;flex-direction:column;gap:8';
  document.body.appendChild(root);

  function row(labelText, widgetEl, height) {
    const r = document.createElement('div');
    r.className = 'panel';
    r.style.cssText = 'height:' + (height || 36);
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = labelText;
    r.appendChild(l);
    widgetEl.className = (widgetEl.className ? widgetEl.className + ' ' : '') + 'widget';
    r.appendChild(widgetEl);
    return r;
  }

  // Checkbox
  const cb1 = document.createElement('input');
  cb1.setAttribute('type', 'checkbox');
  cb1.style.cssText = 'width:24;height:24';
  let cbTaps = 0;
  cb1.addEventListener('change', function () {
    cbTaps++;
    ok('checkbox_tap', 'toggled ' + cbTaps + 'x, now ' + cb1.checked);
  });
  r.checkbox_tap = '(pending tap)';
  root.appendChild(row('Checkbox:', cb1));

  // Disabled checkbox (for disabled_blocks test)
  const cb2 = document.createElement('input');
  cb2.setAttribute('type', 'checkbox');
  cb2.toggleAttribute('disabled', true);
  cb2.style.cssText = 'width:24;height:24';
  let cb2Taps = 0;
  cb2.addEventListener('change', function () {
    cb2Taps++;
    bad('disabled_blocks', 'tap fired despite disabled');
  });
  // After 3 seconds of no tap-through, mark OK
  setTimeout(function () {
    if (cb2Taps === 0) ok('disabled_blocks', 'no tap-through');
  }, 3000);
  root.appendChild(row('Disabled cb:', cb2));

  // Button
  const btn = document.createElement('button');
  btn.textContent = 'Click me';
  let btnTaps = 0;
  btn.addEventListener('click', function () {
    btnTaps++;
    ok('button_tap', 'clicked ' + btnTaps + 'x');
  });
  r.button_tap = '(pending tap)';
  root.appendChild(row('Button:', btn));

  // Text input
  const txt = document.createElement('input');
  txt.setAttribute('type', 'text');
  txt.value = 'tap me';
  txt.addEventListener('change', function () {
    ok('text_keyboard', 'value=' + txt.value);
  });
  r.text_keyboard = '(pending tap → type → Submit)';
  root.appendChild(row('Text:', txt));

  // Number input
  const num = document.createElement('input');
  num.setAttribute('type', 'number');
  num.value = '42';
  num.addEventListener('change', function () {
    ok('number_keyboard', 'value=' + num.value);
  });
  r.number_keyboard = '(pending tap → type → Submit)';
  root.appendChild(row('Number:', num));

  // Color swatch
  const col = document.createElement('input');
  col.setAttribute('type', 'color');
  col.value = '#ff5555';
  col.addEventListener('change', function () {
    ok('color_cycle', 'value=' + col.value);
  });
  r.color_cycle = '(pending tap)';
  root.appendChild(row('Color:', col));

  // Select
  const sel = document.createElement('select');
  const opts = ['Low', 'Medium', 'High'];
  for (const t of opts) {
    const o = document.createElement('option');
    o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = 'Low';
  sel.addEventListener('change', function () {
    ok('select_cycle', 'value=' + sel.value);
  });
  r.select_cycle = '(pending tap)';
  root.appendChild(row('Select:', sel));
})();
