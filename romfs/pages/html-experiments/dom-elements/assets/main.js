// DOM Elements showcase — validation suite for the live-DOM stack.
// Builds one big position:fixed scrollable panel populated with every
// HTML element we want to support. Each demo is a "section" with
//   - a header chip ("<strong>" or "&lt;sup&gt;" etc.)
//   - the live element rendered per UA defaults + author overrides
//   - a small caption explaining what's being shown
//
// Tier-1 / Batch A coverage:
//   br, hr, text-decoration, sup/sub via vertical-align,
//   meter, progress, details/summary, UA defaults for the inline
//   formatting elements + headings + pre/code/kbd/samp + blockquote.
//
// Items intentionally rendered as "not yet" placeholders until later
// batches: img (B), list markers (C), radio (B), range (B), label-for
// (B), table (Tier 2), inline flow (Tier 2.5), svg (Tier 2).
//
// Per [[swb-passthrough-pivot]] / [[threejs-no-silent-deviations]],
// console.error/log/warn/info are routed away from $.print so they
// don't trigger nx.js's text-mode flip ([[console-error-switches-
// render-mode]]). console.debug is fine.

(function () {
  'use strict';
  // ---------- Stylesheet -------------------------------------------
  // Phase 1 (2026-05-25) — body root flows normally with the page scroll.
  // No position:fixed required: paintLiveOverlay lays out body's non-
  // fixed children as block content at (viewport.x, viewport.y - scrollY)
  // and the existing scroll dispatcher drives the offset. .swatch-row
  // keeps flex row because its children have explicit widths (totalBase
  // ≤ mainAvail → no [[live-dom-flex-shrink-trap]]).
  const style = document.createElement('style');
  style.textContent = `
    body {
      background: #14202d;
      color: #e0e8f4;
      padding: 14px 18px;
    }
    .doc-title {
      color: #ffd35e;
      font-weight: bold;
      font-size: 22px;
      margin-bottom: 4px;
    }
    .doc-sub {
      color: #9bb1d6;
      font-size: 13px;
      margin-bottom: 10px;
    }
    .section {
      padding: 8px 0;
      border-bottom: 1px solid #1d2c43;
    }
    .chip {
      color: #7aa2ff;
      font-family: monospace;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .caption {
      color: #9bb1d6;
      font-size: 12px;
      margin-top: 4px;
    }
    .demo {
      color: #e0e8f4;
      font-size: 14px;
    }
    .swatch-row {
      display: flex;
      flex-direction: row;
      gap: 16px;
      align-items: center;
    }
    .placeholder {
      background: #1d2c43;
      color: #ffb18a;
      padding: 4px 8px;
      font-size: 12px;
      font-family: monospace;
    }
  `;
  document.head.appendChild(style);

  // ---------- Build sections directly into <body> ------------------
  // Phase 1: body flows normally with the page scroll. No outer panel.
  const title = document.createElement('div');
  title.className = 'doc-title';
  title.textContent = 'DOM Elements Showcase';
  document.body.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'doc-sub';
  sub.textContent = 'Each block: <tag> chip / live render / caption';
  document.body.appendChild(sub);

  function section(chipText, captionText, demoBuilder) {
    const sec = document.createElement('div');
    sec.className = 'section';
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.textContent = chipText;
    sec.appendChild(chip);
    const demoWrap = document.createElement('div');
    demoWrap.className = 'demo';
    demoBuilder(demoWrap);
    sec.appendChild(demoWrap);
    if (captionText) {
      const cap = document.createElement('div');
      cap.className = 'caption';
      cap.textContent = captionText;
      sec.appendChild(cap);
    }
    document.body.appendChild(sec);
    return sec;
  }

  function block(tag, text) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function placeholder(label) {
    const el = document.createElement('div');
    el.className = 'placeholder';
    el.textContent = label;
    return el;
  }

  // ---------- Headings -------------------------------------------
  section('<h1>..<h6>', 'UA defaults: bold + decreasing font-size.',
    function (root) {
      root.appendChild(block('h1', 'Heading 1'));
      root.appendChild(block('h2', 'Heading 2'));
      root.appendChild(block('h3', 'Heading 3'));
      root.appendChild(block('h4', 'Heading 4'));
      root.appendChild(block('h5', 'Heading 5'));
      root.appendChild(block('h6', 'Heading 6'));
    });

  // ---------- Paragraph ------------------------------------------
  section('<p>',
    'Block; 8 px top/bottom margin. Inline-flow text wraps at the ' +
    'content-box edge (Phase 2.5 / 2026-05-25).',
    function (root) {
      root.appendChild(block('p',
        'A paragraph is a self-contained unit of discourse used to ' +
        'organise prose. This text demonstrates inline flow — words ' +
        'pack left-to-right and wrap to a new line at the right edge ' +
        'of the content box rather than clipping. text-align controls ' +
        'per-line horizontal placement.'));
    });

  // ---------- Mixed inline content (inline-flow showcase) --------
  section('<p> with mixed inline content',
    'document.createTextNode mixed with inline elements — real DOM ' +
    'inline flow. Each run keeps its own cascade-derived styling.',
    function (root) {
      const p = document.createElement('p');
      function appendText(t) { p.appendChild(document.createTextNode(t)); }
      function appendInline(tag, text) {
        const el = document.createElement(tag);
        el.textContent = text;
        p.appendChild(el);
      }
      appendText('The ');
      appendInline('strong', 'quick');
      appendText(' ');
      appendInline('em', 'brown');
      appendText(' ');
      appendInline('a', 'fox');
      appendText(' jumps over the ');
      appendInline('mark', 'lazy');
      appendText(' dog. Trailing punctuation flows alongside an ');
      appendInline('abbr', 'HTML');
      appendText(' abbreviation, a ');
      appendInline('code', '<code>');
      appendText(' span, and a footnote');
      appendInline('sup', '®');
      appendText('. Subscript water H');
      appendInline('sub', '2');
      appendText('O. ');
      appendInline('del', 'Deleted text');
      appendText(' next to ');
      appendInline('ins', 'inserted text');
      appendText('.');
      root.appendChild(p);
    });

  // ---------- Inline formatting ----------------------------------
  section('<strong>', 'UA default: font-weight bold.', function (root) {
    root.appendChild(block('strong', 'Strong indicates strong importance.'));
  });
  section('<em>', 'UA default: font-style italic.', function (root) {
    root.appendChild(block('em', 'Em indicates emphatic stress.'));
  });
  section('<b>', 'UA default: font-weight bold (no semantics).',
    function (root) { root.appendChild(block('b', 'Bold (stylistic).')); });
  section('<i>', 'UA default: font-style italic (alternate voice).',
    function (root) { root.appendChild(block('i', 'Italic (offset voice).')); });
  section('<u>', 'UA default: text-decoration underline.',
    function (root) { root.appendChild(block('u', 'Underlined annotation.')); });
  section('<del>', 'UA default: text-decoration line-through.',
    function (root) { root.appendChild(block('del', 'Deleted from the spec.')); });
  section('<ins>', 'UA default: text-decoration underline.',
    function (root) { root.appendChild(block('ins', 'Inserted in the spec.')); });
  section('<s>', 'UA default: text-decoration line-through.',
    function (root) { root.appendChild(block('s', 'No longer accurate.')); });
  section('<small>', 'UA default: font-size 13px.', function (root) {
    root.appendChild(block('small', 'Small print for legal / footnote text.'));
  });
  section('<mark>', 'UA default: yellow background.', function (root) {
    root.appendChild(block('mark', 'Marked / highlighted span.'));
  });
  section('<sup>', 'UA default: vertical-align super + smaller font.',
    function (root) {
      root.appendChild(block('sup', 'Superscript example ®'));
    });
  section('<sub>', 'UA default: vertical-align sub + smaller font.',
    function (root) {
      root.appendChild(block('sub', 'Subscript example H2O'));
    });
  section('<code>', 'UA default: monospace font-family.',
    function (root) { root.appendChild(block('code', '<div>code</div>')); });
  section('<kbd>', 'UA default: monospace font-family.',
    function (root) { root.appendChild(block('kbd', 'Cmd + Shift + P')); });
  section('<samp>', 'UA default: monospace font-family.',
    function (root) { root.appendChild(block('samp', 'Sample program output.')); });
  section('<var>', 'UA default: italic (math/code variable).',
    function (root) { root.appendChild(block('var', 'x = y + 1')); });
  section('<dfn>', 'UA default: italic (term being defined).',
    function (root) {
      root.appendChild(block('dfn', 'dfn marks the defining instance of a term.'));
    });
  section('<cite>', 'UA default: italic.',
    function (root) { root.appendChild(block('cite', 'A cited work title.')); });
  section('<abbr>',
    'Inline element; renders as text (tooltips not supported on touch).',
    function (root) { root.appendChild(block('abbr', 'HTML — HyperText Markup Language')); });
  section('<q>',
    'Inline element; quote marks not yet inserted (Tier 2.5 inline flow).',
    function (root) { root.appendChild(block('q', 'A short inline quotation.')); });
  section('<time>', 'Inline element; renders as text.',
    function (root) { root.appendChild(block('time', '2026-05-25T12:00')); });

  // ---------- Link ------------------------------------------------
  section('<a>', 'UA default: green color + underline.',
    function (root) {
      root.appendChild(block('a', 'This text would be a link.'));
    });

  // ---------- Blockquote -----------------------------------------
  section('<blockquote>', 'UA default: 24px left/right margin.',
    function (root) {
      const bq = document.createElement('blockquote');
      bq.appendChild(block('p', 'A block quotation is set off from the main text as its own paragraph.'));
      bq.appendChild(block('p', 'It is typically distinguished by indentation.'));
      const cite = document.createElement('cite');
      cite.textContent = '— Said no one, ever.';
      bq.appendChild(cite);
      root.appendChild(bq);
    });

  // ---------- Pre + code ----------------------------------------
  section('<pre>', 'UA default: monospace; preserves layout (no wrap).',
    function (root) {
      const pre = document.createElement('pre');
      pre.textContent = 'P R E F O R M A T T E D';
      root.appendChild(pre);
      const pre2 = document.createElement('pre');
      pre2.textContent = '0 1 2 3 4 5 6 7 8 9';
      root.appendChild(pre2);
      const pre3 = document.createElement('pre');
      pre3.textContent = 'a b c d e f g h i j';
      root.appendChild(pre3);
    });

  // ---------- BR ------------------------------------------------
  section('<br>', 'Empty block of one line-height. Used as separator below.',
    function (root) {
      root.appendChild(block('div', 'Line above the br.'));
      root.appendChild(document.createElement('br'));
      root.appendChild(block('div', 'Line below the br.'));
    });

  // ---------- HR ------------------------------------------------
  section('<hr>', 'Thin horizontal rule centered in a 16px-tall block.',
    function (root) {
      root.appendChild(block('div', 'Content above the rule.'));
      root.appendChild(document.createElement('hr'));
      root.appendChild(block('div', 'Content below the rule.'));
    });

  // ---------- Address -------------------------------------------
  section('<address>',
    'UA default: italic. Mixed text + <a> + <br> demonstrates real ' +
    'inline-flow line breaks (no per-line wrapper div needed).',
    function (root) {
      const addr = document.createElement('address');
      addr.appendChild(document.createTextNode('Written by '));
      const a = document.createElement('a');
      a.textContent = 'Jon Doe';
      addr.appendChild(a);
      addr.appendChild(document.createTextNode('.'));
      addr.appendChild(document.createElement('br'));
      addr.appendChild(document.createTextNode('Box 564, Disneyland'));
      addr.appendChild(document.createElement('br'));
      addr.appendChild(document.createTextNode('USA'));
      root.appendChild(addr);
    });

  // ---------- Definition list -----------------------------------
  section('<dl>/<dt>/<dd>',
    'Block-stacked; dd indent + bold dt come from author CSS (no UA defaults).',
    function (root) {
      const dl = document.createElement('dl');
      const dt = block('dt', 'switch-web-browser');
      dt.style.fontWeight = 'bold';
      dl.appendChild(dt);
      const dd = block('dd', 'A Switch homebrew web browser.');
      dd.style.marginLeft = 24;
      dl.appendChild(dd);
      root.appendChild(dl);
    });

  // ---------- Meter ---------------------------------------------
  section('<meter>',
    'value/min/max → filled track. Three values: 2/10, 7/10, full.',
    function (root) {
      function meter(value, min, max) {
        const m = document.createElement('meter');
        m.setAttribute('value', String(value));
        m.setAttribute('min', String(min));
        m.setAttribute('max', String(max));
        m.style.width = 240;
        m.style.height = 16;
        return m;
      }
      const wrap = document.createElement('div');
      wrap.className = 'swatch-row';
      wrap.appendChild(meter(2, 0, 10));
      wrap.appendChild(meter(7, 0, 10));
      wrap.appendChild(meter(10, 0, 10));
      root.appendChild(wrap);
    });

  // ---------- Progress -------------------------------------------
  section('<progress>',
    'value/max → blue filled track. Last is indeterminate (no value).',
    function (root) {
      function progress(value, max) {
        const p = document.createElement('progress');
        if (value !== null) p.setAttribute('value', String(value));
        p.setAttribute('max', String(max));
        p.style.width = 240;
        p.style.height = 16;
        return p;
      }
      const wrap = document.createElement('div');
      wrap.className = 'swatch-row';
      wrap.appendChild(progress(0.3, 1));
      wrap.appendChild(progress(0.8, 1));
      wrap.appendChild(progress(null, 1)); // indeterminate
      root.appendChild(wrap);
    });

  // ---------- Details / Summary ---------------------------------
  section('<details>/<summary>',
    'Tap summary to expand/collapse. Chevron rotates with state.',
    function (root) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = 'Tap to expand for details';
      det.appendChild(sum);
      const body = block('p',
        'Lorem ipsum dolor sit amet. The hidden text appears when the details '
        + 'element has the `open` attribute set.');
      det.appendChild(body);
      root.appendChild(det);

      // Second variant — pre-opened, can be tapped to collapse.
      const det2 = document.createElement('details');
      det2.setAttribute('open', '');
      const sum2 = document.createElement('summary');
      sum2.textContent = 'Already open — tap to collapse';
      det2.appendChild(sum2);
      det2.appendChild(block('p', 'This block was open by default.'));
      root.appendChild(det2);
    });

  // ---------- Image ----------------------------------------------
  section('<img>',
    'Loaded from romfs:/test-images/snowflake1.png. Width via CSS; ' +
    'height derives from natural aspect ratio if unset.',
    function (root) {
      const img = document.createElement('img');
      img.setAttribute('alt', 'snowflake');
      img.setAttribute('src', 'romfs:/test-images/snowflake1.png');
      img.style.width = 64;
      img.style.height = 64;
      root.appendChild(img);
    });

  // ---------- Figure / figcaption -------------------------------
  section('<figure>/<figcaption>',
    'Block with 24px margin; figcaption italic + center.',
    function (root) {
      const fig = document.createElement('figure');
      const img = document.createElement('img');
      img.setAttribute('alt', 'snowflake');
      img.setAttribute('src', 'romfs:/test-images/snowflake2.png');
      img.style.width = 80;
      img.style.height = 80;
      fig.appendChild(img);
      const cap = document.createElement('figcaption');
      cap.textContent = 'Snowflake #2 from romfs:/test-images/.';
      fig.appendChild(cap);
      root.appendChild(fig);
    });

  // ---------- Lists (Batch C) -----------------------------------
  section('<ul> disc / circle / square',
    'UA default: disc. CSS list-style-type overrides; nested lists inherit.',
    function (root) {
      function mkUl(type, items) {
        const ul = document.createElement('ul');
        if (type) ul.style.listStyleType = type;
        items.forEach(function (t) {
          const li = document.createElement('li');
          li.textContent = t;
          ul.appendChild(li);
        });
        return ul;
      }
      root.appendChild(mkUl(null, ['Disc one', 'Disc two', 'Disc three']));
      root.appendChild(mkUl('circle', ['Circle A', 'Circle B', 'Circle C']));
      root.appendChild(mkUl('square', ['Square X', 'Square Y', 'Square Z']));
    });
  section('<ol> decimal / alpha / roman',
    '<ol type="1|A|a|I|i"> picks the marker style when CSS doesn\'t.',
    function (root) {
      function mkOl(type, items) {
        const ol = document.createElement('ol');
        if (type) ol.setAttribute('type', type);
        items.forEach(function (t) {
          const li = document.createElement('li');
          li.textContent = t;
          ol.appendChild(li);
        });
        return ol;
      }
      root.appendChild(mkOl('1', ['First', 'Second', 'Third']));
      root.appendChild(mkOl('A', ['Upper alpha', 'Continues', 'Three items']));
      root.appendChild(mkOl('a', ['Lower alpha', 'Continues', 'Three items']));
      root.appendChild(mkOl('I', ['Upper roman', 'Two', 'Three', 'Four', 'Five']));
      root.appendChild(mkOl('i', ['Lower roman', 'Two', 'Three', 'Four', 'Five']));
    });

  // ---------- Radio buttons -------------------------------------
  section('<input type=radio>',
    'Tap to select; name-group exclusivity clears the other radios.',
    function (root) {
      function mkRadio(name, value, checked, labelText) {
        const wrap = document.createElement('div');
        wrap.style.marginBottom = 4;
        const lbl = document.createElement('label');
        const radio = document.createElement('input');
        radio.setAttribute('type', 'radio');
        radio.setAttribute('name', name);
        radio.setAttribute('value', value);
        if (checked) radio.setAttribute('checked', '');
        radio.style.width = 18;
        radio.style.height = 18;
        radio.style.marginRight = 8;
        lbl.appendChild(radio);
        const span = document.createElement('span');
        span.textContent = labelText;
        lbl.appendChild(span);
        wrap.appendChild(lbl);
        return wrap;
      }
      root.appendChild(mkRadio('demo-radio', 'A', true, 'Choice A'));
      root.appendChild(mkRadio('demo-radio', 'B', false, 'Choice B'));
      root.appendChild(mkRadio('demo-radio', 'C', false, 'Choice C'));
    });

  // ---------- Range slider --------------------------------------
  section('<input type=range>',
    'Tap anywhere on the track to set the value; min/max/step honored.',
    function (root) {
      const range = document.createElement('input');
      range.setAttribute('type', 'range');
      range.setAttribute('min', '0');
      range.setAttribute('max', '100');
      range.setAttribute('step', '5');
      range.setAttribute('value', '40');
      range.style.width = 240;
      range.style.height = 22;
      root.appendChild(range);
    });

  // ---------- Label for -----------------------------------------
  section('<label for>',
    'Tap the LABEL text — focus / activation forwards to the bound input.',
    function (root) {
      const wrap = document.createElement('div');
      const lbl = document.createElement('label');
      lbl.setAttribute('for', 'demo-label-target');
      lbl.textContent = 'Tap me to toggle the checkbox →  ';
      wrap.appendChild(lbl);
      const cb = document.createElement('input');
      cb.setAttribute('id', 'demo-label-target');
      cb.setAttribute('type', 'checkbox');
      cb.style.width = 22;
      cb.style.height = 22;
      wrap.appendChild(cb);
      root.appendChild(wrap);
    });
  section('<table>',
    'Tier 2. Table layout (rows/cells/auto-width) is its own milestone.',
    function (root) {
      root.appendChild(placeholder('(table not yet — Tier 2)'));
    });
  section('<svg>',
    'Tier 2. Inline SVG (circle / rect primitives) is its own milestone.',
    function (root) {
      root.appendChild(placeholder('(svg not yet — Tier 2)'));
    });
  section('<audio>/<video>/<iframe>',
    'Tier 3. Need media decoder / nested page renderer.',
    function (root) {
      root.appendChild(placeholder('(media + iframe not yet — Tier 3)'));
    });

  // ---------- Existing supported form widgets -------------------
  section('<input type=text/checkbox/color/select>',
    'Shipped in M2.4. Tap each to interact.',
    function (root) {
      const row = document.createElement('div');
      row.className = 'swatch-row';
      const ti = document.createElement('input');
      ti.setAttribute('type', 'text');
      ti.value = 'hello';
      ti.style.width = 120;
      ti.style.height = 22;
      row.appendChild(ti);
      const cb = document.createElement('input');
      cb.setAttribute('type', 'checkbox');
      cb.setAttribute('checked', '');
      cb.style.width = 22;
      cb.style.height = 22;
      row.appendChild(cb);
      const col = document.createElement('input');
      col.setAttribute('type', 'color');
      col.value = '#7eda9f';
      col.style.width = 30;
      col.style.height = 22;
      row.appendChild(col);
      const sel = document.createElement('select');
      ['Low', 'Mid', 'High'].forEach(function (v) {
        const o = document.createElement('option');
        o.textContent = v;
        sel.appendChild(o);
      });
      sel.value = 'Mid';
      sel.style.width = 80;
      sel.style.height = 22;
      row.appendChild(sel);
      const btn = document.createElement('button');
      btn.textContent = 'Button';
      btn.style.height = 22;
      row.appendChild(btn);
      root.appendChild(row);
    });

})();
