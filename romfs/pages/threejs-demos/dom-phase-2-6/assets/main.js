// DOM Phase 2.6 validation — lil-gui drop-in.
// Builds a panel with one of each controller type, wires onChange
// listeners that flip the corresponding status row in
// globalThis.__d26Results, and also instantiates Stats to prove the
// M2.0/M2.1.5 coexistence still holds.

(function () {
  const r = (globalThis.__d26Results = globalThis.__d26Results || {});
  function ok(k, d) { r[k] = 'OK' + (d ? ' (' + d + ')' : ''); }
  function bad(k, d) { r[k] = 'FAIL: ' + (d || '?'); }

  // ---------- lil-gui setup ---------------------------------------
  if (typeof globalThis.lilGui !== 'object') {
    bad('lilgui_loaded', 'globalThis.lilGui missing');
    return;
  }
  ok('lilgui_loaded', 'object present');

  let gui;
  try {
    gui = new globalThis.lilGui.GUI({ title: 'Phase 2.6 Demo' });
    ok('gui_instance', 'created');
  } catch (e) {
    bad('gui_instance', String(e));
    return;
  }

  // Backing object whose properties the controllers read/write.
  const params = {
    iterations: 10,
    speed: 50,
    label: 'hello',
    enabled: true,
    color: '#7eda9f',
    mode: 'B',
    run: function () {
      ok('button_fire', 'fn called at ' + Date.now());
    },
    folderValue: 0.25,
  };

  // r.* tracking — set to pending on each create, OK on onChange.
  r.add_number = '(pending)';
  r.add_slider = '(pending)';
  r.add_string = '(pending)';
  r.add_boolean = '(pending)';
  r.add_color = '(pending)';
  r.add_option = '(pending)';
  r.add_function = '(pending)';
  r.add_folder = '(pending)';
  r.collapse_tap = '(pending tap on title)';
  r.slider_change = '(pending drag)';
  r.checkbox_change = '(pending tap)';
  r.color_change = '(pending tap)';
  r.option_change = '(pending tap)';
  r.button_fire = '(pending tap)';
  r.number_keyboard = '(pending tap → keyboard)';
  r.string_keyboard = '(pending tap → keyboard)';

  try {
    const slider = gui.add(params, 'speed', 0, 100, 1).name('Speed');
    ok('add_slider', 'slider controller');
    slider.onChange(function (v) { ok('slider_change', 'value=' + v); });
  } catch (e) { bad('add_slider', String(e)); }

  try {
    const num = gui.add(params, 'iterations').name('Iterations');
    ok('add_number', 'number controller');
    num.onChange(function (v) { ok('number_keyboard', 'value=' + v); });
  } catch (e) { bad('add_number', String(e)); }

  try {
    const str = gui.add(params, 'label').name('Label');
    ok('add_string', 'string controller');
    str.onChange(function (v) { ok('string_keyboard', 'value=' + v); });
  } catch (e) { bad('add_string', String(e)); }

  try {
    const cb = gui.add(params, 'enabled').name('Enabled');
    ok('add_boolean', 'boolean controller');
    cb.onChange(function (v) { ok('checkbox_change', 'value=' + v); });
  } catch (e) { bad('add_boolean', String(e)); }

  try {
    const col = gui.addColor(params, 'color').name('Color');
    ok('add_color', 'color controller');
    col.onChange(function (v) { ok('color_change', 'value=' + v); });
  } catch (e) { bad('add_color', String(e)); }

  try {
    const opt = gui.add(params, 'mode', ['A', 'B', 'C']).name('Mode');
    ok('add_option', 'option controller');
    opt.onChange(function (v) { ok('option_change', 'value=' + v); });
  } catch (e) { bad('add_option', String(e)); }

  try {
    gui.add(params, 'run').name('Run');
    ok('add_function', 'function controller');
  } catch (e) { bad('add_function', String(e)); }

  try {
    const folder = gui.addFolder('Folder');
    folder.add(params, 'folderValue', 0, 1, 0.01).name('FolderSlider');
    ok('add_folder', 'folder + 1 child');
  } catch (e) { bad('add_folder', String(e)); }

  // ---------- Title-tap collapse tracking -------------------------
  // lil-gui adds an `aria-expanded` attribute on the title. We watch
  // it to detect the user's tap-to-collapse without reaching into
  // lil-gui internals.
  try {
    const titleEl = gui.$title;
    let lastExpanded = titleEl.getAttribute('aria-expanded');
    setInterval(function () {
      const cur = titleEl.getAttribute('aria-expanded');
      if (cur !== lastExpanded) {
        ok('collapse_tap', 'aria-expanded=' + cur);
        lastExpanded = cur;
      }
    }, 200);
  } catch (e) {
    bad('collapse_tap', String(e));
  }

  // ---------- Stats coexistence -----------------------------------
  try {
    if (typeof globalThis.Stats === 'function') {
      const stats = new globalThis.Stats();
      document.body.appendChild(stats.dom);
      r.stats_tap = '(pending tap on Stats panel)';
      stats.dom.addEventListener('click', function () {
        r.stats_tap = 'OK (tap cycled)';
      });
      function statsTick() {
        try { stats.begin(); stats.end(); requestAnimationFrame(statsTick); }
        catch (_) {}
      }
      requestAnimationFrame(statsTick);
    } else {
      bad('stats_tap', 'Stats missing');
    }
  } catch (e) {
    bad('stats_tap', String(e));
  }
})();
