// DOM reference validation page. Uses canonical patterns:
//   - <style> tag with :root custom properties + var() consumption
//     on the same element ( .panel { background: var(--bg) } )
//   - position:fixed via class-based cascade (not inline style)
//   - flex column container holding flex row children
//   - flex shrink:0 label + flex:1 widget pattern
//   - one of each form widget type (text, number, checkbox, color,
//     select, button) via document.createElement + setAttribute
//   - click handlers at three nesting levels (button -> row -> panel)
//     to validate event bubbling
//   - scrollable container with overflow-y:auto for swipe-drag
//
// Results accumulate in globalThis.__refResults so the index.html
// status canvas can render the pass/fail grid.

(function () {
  const r = (globalThis.__refResults = globalThis.__refResults || {});
  function ok(k, d) { r[k] = 'OK' + (d ? ' (' + d + ')' : ''); }
  function bad(k, d) { r[k] = 'FAIL: ' + (d || '?'); }

  // ---------- Style ------------------------------------------------
  try {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        --bg: #1f1f1f;
        --fg: #ebebeb;
        --accent: #2cc9ff;
        --label-color: #9bb1d6;
        --row-h: 28px;
      }
      .panel {
        position: fixed;
        right: 16px;
        top: 30px;
        width: 280px;
        background: var(--bg);
        color: var(--fg);
        display: flex;
        flex-direction: column;
        padding: 8px;
        gap: 6px;
      }
      .panel .title {
        font-weight: bold;
        color: var(--accent);
        padding: 2px 0 4px 0;
      }
      .row {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
        height: 28px;
      }
      .row .label {
        flex-shrink: 0;
        width: 90px;
        color: var(--label-color);
        font-size: 14px;
      }
      .row .widget {
        flex: 1;
        height: 24px;
      }
      .row input[type=checkbox] {
        width: 24px;
        height: 24px;
        flex: none;
      }
      .row input[type=color] {
        height: 24px;
      }
      .row button {
        background: #2c3e50;
        color: #ffffff;
        height: 24px;
      }
      .list-panel {
        position: fixed;
        right: 16px;
        top: 320px;
        width: 280px;
        max-height: 220px;
        background: var(--bg);
        color: var(--fg);
        padding: 6px;
        overflow-y: auto;
      }
      .list-item {
        background: #2c3e50;
        color: #ffffff;
        padding: 4px 8px;
        margin-bottom: 2px;
        height: 22px;
        font-size: 13px;
      }
    `;
    document.head.appendChild(style);
    ok('style_set', 'rules registered');
  } catch (e) { bad('style_set', String(e)); }

  // ---------- Helper: make a labelled row --------------------------
  function makeRow(labelText, widgetEl) {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = labelText;
    widgetEl.className = (widgetEl.className ? widgetEl.className + ' ' : '') + 'widget';
    r.appendChild(l);
    r.appendChild(widgetEl);
    return r;
  }

  // ---------- Settings panel ---------------------------------------
  let panel = null;
  try {
    panel = document.createElement('div');
    panel.className = 'panel';
    // Level-3 click handler at the panel itself (validates bubble).
    panel.addEventListener('click', function () {
      ok('bubble_panel', 'panel click fired');
    });

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Settings';
    panel.appendChild(title);

    // -- Text input
    const tin = document.createElement('input');
    tin.setAttribute('type', 'text');
    tin.value = 'hello';
    tin.addEventListener('change', function () {
      ok('text_event', 'value="' + tin.value + '"');
    });
    panel.appendChild(makeRow('Text:', tin));
    r.text_event = '(pending tap → keyboard)';

    // -- Number input
    const nin = document.createElement('input');
    nin.setAttribute('type', 'number');
    nin.value = '42';
    nin.addEventListener('change', function () {
      ok('number_event', 'value=' + nin.value);
    });
    panel.appendChild(makeRow('Number:', nin));
    r.number_event = '(pending tap → keyboard)';

    // -- Checkbox
    const cb = document.createElement('input');
    cb.setAttribute('type', 'checkbox');
    cb.addEventListener('change', function () {
      ok('checkbox_event', 'checked=' + cb.checked);
    });
    panel.appendChild(makeRow('Checkbox:', cb));
    r.checkbox_event = '(pending tap)';

    // -- Color
    const col = document.createElement('input');
    col.setAttribute('type', 'color');
    col.value = '#7eda9f';
    col.addEventListener('change', function () {
      ok('color_event', 'value=' + col.value);
    });
    panel.appendChild(makeRow('Color:', col));
    r.color_event = '(pending tap)';

    // -- Select
    const sel = document.createElement('select');
    ['low', 'medium', 'high'].forEach(function (v) {
      const opt = document.createElement('option');
      opt.textContent = v;
      sel.appendChild(opt);
    });
    sel.value = 'medium';
    sel.addEventListener('change', function () {
      ok('select_event', 'value=' + sel.value);
    });
    panel.appendChild(makeRow('Select:', sel));
    r.select_event = '(pending tap)';

    // -- Button (drives the 3-level bubble assertions)
    const btn = document.createElement('button');
    btn.textContent = 'Click';
    btn.addEventListener('click', function () {
      ok('button_event', 'click fired');
      ok('bubble_button', 'level 1 (button)');
    });
    const btnRow = makeRow('Button:', btn);
    // Level-2 click handler on the row.
    btnRow.addEventListener('click', function () {
      ok('bubble_row', 'level 2 (row)');
    });
    panel.appendChild(btnRow);
    r.button_event = '(pending tap)';
    r.bubble_button = '(pending tap on button)';
    r.bubble_row = '(pending tap on button)';
    r.bubble_panel = '(pending tap on button)';

    document.body.appendChild(panel);
    ok('panel_made', 'title + 6 rows');
  } catch (e) {
    bad('panel_made', String(e));
  }

  // ---------- Scrollable list --------------------------------------
  let list = null;
  try {
    list = document.createElement('div');
    list.className = 'list-panel';
    for (let i = 1; i <= 20; i++) {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.textContent = 'Item #' + i;
      item.addEventListener('click', (function (n, el) {
        return function () {
          el.textContent = 'Item #' + n + ' (tapped)';
          ok('list_click', 'tapped Item #' + n);
        };
      })(i, item));
      list.appendChild(item);
    }
    document.body.appendChild(list);
    ok('list_made', '20 items');
    r.list_click = '(pending tap on item)';
    r.list_scroll = '(pending swipe)';

    setInterval(function () {
      if (list.scrollTop > 6 && (r.list_scroll || '').indexOf('OK') !== 0) {
        ok('list_scroll', 'scrollTop=' + list.scrollTop);
      }
    }, 200);
  } catch (e) {
    bad('list_made', String(e));
  }

  // ---------- body.children sanity --------------------------------
  try {
    const hasPanel = panel && document.body.children.indexOf(panel) >= 0;
    const hasList = list && document.body.children.indexOf(list) >= 0;
    if (hasPanel && hasList) ok('body_children', 'both attached');
    else bad('body_children', 'panel=' + !!hasPanel + ' list=' + !!hasList);
  } catch (e) { bad('body_children', String(e)); }
})();
