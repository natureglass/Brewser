/**
 * Generic inline-SVG rasterizer. Walks a parsed SVG subtree and paints
 * its `<rect>` / `<circle>` / `<ellipse>` / `<line>` / `<polyline>` /
 * `<polygon>` / `<path>` / `<g>` children with Canvas2D primitives.
 *
 * Source-agnostic: the caller passes an adapter that knows how to read
 * a node's tag, attribute, and child list. Callers today:
 *   - live-overlay.ts (inline <svg> in live-DOM pages)
 *   - live-dom.ts (rasterising .svg URLs fetched as CSS background-image)
 *
 * 2026-05-31 additions:
 *   - `<defs>` collection — any element with `id` is indexed so refs work.
 *   - `<clipPath>` resolution via `clip-path="url(#id)"` — collected from
 *     defs, applied as ctx.clip() around the host's paint subtree.
 *   - `fill-rule="evenodd"` honored on `<path>`. (Default nonzero.)
 *   - `style="fill:…;stroke:…"` attribute respected alongside the
 *     attribute-form fill / stroke (style wins per CSS spec).
 *
 * Out of scope: `<text>`, `<image>`, `<use>`, gradients, patterns,
 * masks, filters, animations, the elliptical-arc `A/a` path command, and
 * CSS-style transforms beyond `transform="translate(x y)"`.
 */
/** Tags that don't paint anything themselves — they only define ids
 * other elements reference via `url(#id)`. Skipped during the main
 * paint walk so their geometry doesn't render as filled shapes. */
const DEF_TAGS = new Set([
    'defs', 'clippath', 'mask', 'lineargradient', 'radialgradient',
    'pattern', 'symbol', 'marker', 'filter', 'metadata', 'title', 'desc',
]);
export function paintSvgSubtree(ctx, root, adapter) {
    // Pre-pass: index every element with an `id`. This is what lets
    // `clip-path="url(#foo)"` actually find `<clipPath id="foo">…</clipPath>`
    // inside the tree (typically nested under <defs>). Indexed across the
    // entire tree so refs work from anywhere — matches real SVG behavior.
    const idMap = new Map();
    collectIds(root, adapter, idMap);
    for (const child of adapter.children(root)) {
        paintNode(ctx, child, adapter, {}, idMap);
    }
}
function collectIds(node, a, out) {
    const id = a.attr(node, 'id');
    if (id)
        out.set(id, node);
    for (const c of a.children(node))
        collectIds(c, a, out);
}
function paintNode(ctx, node, a, inherited, ids) {
    const tag = a.tag(node).toLowerCase();
    if (DEF_TAGS.has(tag))
        return; // defs / clippath / mask / etc.
    const merged = merge(node, a, inherited);
    // Wrap this node's paint in a clip if it references one. Painted
    // AROUND the body so descendants are clipped too. transform on the
    // host element wraps both clip-establishment and body.
    const clipRef = parseUrlRef(a.attr(node, 'clip-path'));
    const transform = a.attr(node, 'transform');
    const needSave = !!clipRef || !!transform;
    if (needSave)
        ctx.save();
    try {
        if (transform)
            applyTransform(ctx, transform);
        if (clipRef) {
            const def = ids.get(clipRef);
            if (def)
                applyClipPath(ctx, def, a, merged);
        }
        paintBody(ctx, node, tag, a, merged, ids);
    }
    finally {
        if (needSave)
            ctx.restore();
    }
}
function paintBody(ctx, node, tag, a, merged, ids) {
    switch (tag) {
        case 'g':
        case 'svg':
            for (const c of a.children(node))
                paintNode(ctx, c, a, merged, ids);
            return;
        case 'rect': return paintRect(ctx, node, a, merged);
        case 'circle': return paintCircle(ctx, node, a, merged);
        case 'ellipse': return paintEllipse(ctx, node, a, merged);
        case 'line': return paintLine(ctx, node, a, merged);
        case 'polyline': return paintPoly(ctx, node, a, merged, false);
        case 'polygon': return paintPoly(ctx, node, a, merged, true);
        case 'path': return paintPath(ctx, node, a, merged);
    }
}
/** Establish a clipping path from a `<clipPath>` def's child shapes.
 * Each child draws its geometry into the current path; ctx.clip() then
 * confines all subsequent drawing to that union. */
function applyClipPath(ctx, def, a, inherited) {
    ctx.beginPath();
    for (const child of a.children(def)) {
        tracePathFor(ctx, child, a, inherited);
    }
    // clip-rule on the host or on the child shape decides fill rule for
    // the clip; default nonzero matches SVG spec.
    const clipRule = inherited.clipRule ?? 'nonzero';
    ctx.clip(clipRule);
}
/** Add the geometry of one SVG shape node to the CURRENT path (no
 * begin/fill/stroke). Used by clip-path establishment. */
function tracePathFor(ctx, node, a, inherited) {
    const tag = a.tag(node).toLowerCase();
    switch (tag) {
        case 'g':
            for (const c of a.children(node))
                tracePathFor(ctx, c, a, inherited);
            return;
        case 'rect': {
            const x = num(node, a, 'x');
            const y = num(node, a, 'y');
            const w = num(node, a, 'width');
            const h = num(node, a, 'height');
            if (w > 0 && h > 0)
                ctx.rect(x, y, w, h);
            return;
        }
        case 'circle': {
            const cx = num(node, a, 'cx');
            const cy = num(node, a, 'cy');
            const r = num(node, a, 'r');
            if (r > 0) {
                ctx.moveTo(cx + r, cy);
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
            }
            return;
        }
        case 'ellipse': {
            const cx = num(node, a, 'cx');
            const cy = num(node, a, 'cy');
            const rx = num(node, a, 'rx');
            const ry = num(node, a, 'ry');
            if (rx > 0 && ry > 0) {
                ctx.moveTo(cx + rx, cy);
                ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            }
            return;
        }
        case 'polygon':
        case 'polyline': {
            const raw = a.attr(node, 'points');
            if (!raw)
                return;
            const nums = raw.trim().split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n));
            if (nums.length < 4)
                return;
            ctx.moveTo(nums[0], nums[1]);
            for (let i = 2; i + 1 < nums.length; i += 2)
                ctx.lineTo(nums[i], nums[i + 1]);
            if (tag === 'polygon')
                ctx.closePath();
            return;
        }
        case 'path': {
            const d = a.attr(node, 'd');
            if (d)
                executePath(ctx, d);
            return;
        }
    }
}
/** Parse `url(#foo)` / `url("#foo")` → `foo`. Returns undefined for
 * non-url-ref values (e.g. `none`, raw color, missing attr). */
function parseUrlRef(value) {
    if (!value)
        return undefined;
    const m = /^url\(\s*(['"]?)#([^'")]+)\1\s*\)$/i.exec(value.trim());
    return m ? m[2] : undefined;
}
/** Minimal `transform` parser: handles `translate(x y)` / `translate(x,y)`
 * / `translate(x)` (y=0). Ignores rotate/scale/skew/matrix — most icons
 * use translate-only positioning, and unsupported transforms safely
 * no-op rather than mangle the render. */
function applyTransform(ctx, transform) {
    const t = transform.trim();
    const m = /^translate\(\s*(-?\d+(?:\.\d+)?)(?:[\s,]+(-?\d+(?:\.\d+)?))?\s*\)$/i.exec(t);
    if (m) {
        const tx = parseFloat(m[1]);
        const ty = m[2] ? parseFloat(m[2]) : 0;
        ctx.translate(tx, ty);
    }
}
function merge(node, a, inh) {
    // `style="fill:…;stroke:…"` wins over attribute-form per CSS spec.
    const style = parseStyleAttr(a.attr(node, 'style'));
    const fill = style.fill ?? a.attr(node, 'fill') ?? inh.fill;
    const stroke = style.stroke ?? a.attr(node, 'stroke') ?? inh.stroke;
    const swRaw = style.strokeWidth ?? a.attr(node, 'stroke-width');
    const strokeWidth = swRaw !== undefined ? parseFloat(swRaw) : inh.strokeWidth;
    const fillRule = (style.fillRule ?? a.attr(node, 'fill-rule') ?? inh.fillRule);
    const clipRule = (style.clipRule ?? a.attr(node, 'clip-rule') ?? inh.clipRule);
    return { fill, stroke, strokeWidth, fillRule, clipRule };
}
function parseStyleAttr(s) {
    if (!s)
        return {};
    const out = {};
    for (const decl of s.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0)
            continue;
        const k = decl.slice(0, i).trim().toLowerCase();
        const v = decl.slice(i + 1).trim();
        if (k && v)
            out[k] = v;
    }
    return {
        fill: out['fill'],
        stroke: out['stroke'],
        strokeWidth: out['stroke-width'],
        fillRule: out['fill-rule'],
        clipRule: out['clip-rule'],
    };
}
function applyPaint(ctx, m) {
    const fill = m.fill ?? 'black';
    const stroke = m.stroke ?? 'none';
    const sw = m.strokeWidth ?? 1;
    const didFill = fill !== 'none' && fill !== 'transparent';
    const didStroke = stroke !== 'none' && stroke !== 'transparent' && sw > 0;
    if (didFill)
        ctx.fillStyle = fill;
    if (didStroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
    }
    return { didFill, didStroke };
}
function num(node, a, name, dflt = 0) {
    const raw = a.attr(node, name);
    if (raw === undefined)
        return dflt;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : dflt;
}
function paintRect(ctx, node, a, m) {
    const x = num(node, a, 'x');
    const y = num(node, a, 'y');
    const w = num(node, a, 'width');
    const h = num(node, a, 'height');
    const rx = num(node, a, 'rx');
    const ry = num(node, a, 'ry', rx);
    if (w <= 0 || h <= 0)
        return;
    const { didFill, didStroke } = applyPaint(ctx, m);
    ctx.beginPath();
    if (rx > 0 || ry > 0) {
        const rxC = Math.min(rx, w / 2);
        const ryC = Math.min(ry, h / 2);
        ctx.moveTo(x + rxC, y);
        ctx.lineTo(x + w - rxC, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + ryC);
        ctx.lineTo(x + w, y + h - ryC);
        ctx.quadraticCurveTo(x + w, y + h, x + w - rxC, y + h);
        ctx.lineTo(x + rxC, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - ryC);
        ctx.lineTo(x, y + ryC);
        ctx.quadraticCurveTo(x, y, x + rxC, y);
    }
    else {
        ctx.rect(x, y, w, h);
    }
    if (didFill)
        ctx.fill(m.fillRule ?? 'nonzero');
    if (didStroke)
        ctx.stroke();
}
function paintCircle(ctx, node, a, m) {
    const cx = num(node, a, 'cx');
    const cy = num(node, a, 'cy');
    const r = num(node, a, 'r');
    if (r <= 0)
        return;
    const { didFill, didStroke } = applyPaint(ctx, m);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (didFill)
        ctx.fill(m.fillRule ?? 'nonzero');
    if (didStroke)
        ctx.stroke();
}
function paintEllipse(ctx, node, a, m) {
    const cx = num(node, a, 'cx');
    const cy = num(node, a, 'cy');
    const rx = num(node, a, 'rx');
    const ry = num(node, a, 'ry');
    if (rx <= 0 || ry <= 0)
        return;
    const { didFill, didStroke } = applyPaint(ctx, m);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (didFill)
        ctx.fill(m.fillRule ?? 'nonzero');
    if (didStroke)
        ctx.stroke();
}
function paintLine(ctx, node, a, m) {
    const x1 = num(node, a, 'x1');
    const y1 = num(node, a, 'y1');
    const x2 = num(node, a, 'x2');
    const y2 = num(node, a, 'y2');
    const { didStroke } = applyPaint(ctx, m);
    if (!didStroke)
        return;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
}
function paintPoly(ctx, node, a, m, close) {
    const raw = a.attr(node, 'points');
    if (!raw)
        return;
    const nums = raw.trim().split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n));
    if (nums.length < 4)
        return;
    const { didFill, didStroke } = applyPaint(ctx, m);
    ctx.beginPath();
    ctx.moveTo(nums[0], nums[1]);
    for (let i = 2; i + 1 < nums.length; i += 2)
        ctx.lineTo(nums[i], nums[i + 1]);
    if (close)
        ctx.closePath();
    if (didFill && close)
        ctx.fill(m.fillRule ?? 'nonzero');
    if (didStroke)
        ctx.stroke();
}
function paintPath(ctx, node, a, m) {
    const d = a.attr(node, 'd');
    if (!d)
        return;
    const { didFill, didStroke } = applyPaint(ctx, m);
    ctx.beginPath();
    executePath(ctx, d);
    if (didFill)
        ctx.fill(m.fillRule ?? 'nonzero');
    if (didStroke)
        ctx.stroke();
}
/** Minimal SVG `d` parser. Supports M/m, L/l, H/h, V/v, C/c, S/s,
 * Q/q, T/t, Z/z. The elliptical-arc `A/a` is consumed but renders as a
 * lineTo for now (Tier 3 — needs SVG-arc-to-cubic-bezier reduction). */
function executePath(ctx, d) {
    let i = 0;
    const n = d.length;
    const skipSep = () => { while (i < n && (d.charCodeAt(i) <= 32 || d[i] === ','))
        i++; };
    const isNumChar = (c) => (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46;
    const readNum = () => {
        skipSep();
        const start = i;
        if (d[i] === '+' || d[i] === '-')
            i++;
        while (i < n) {
            const c = d.charCodeAt(i);
            if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69)
                i++;
            else
                break;
        }
        const v = parseFloat(d.slice(start, i));
        return Number.isFinite(v) ? v : 0;
    };
    let cmd = null;
    let cx = 0, cy = 0;
    let startX = 0, startY = 0;
    let prevCtrlX = 0, prevCtrlY = 0;
    let prevQCtrlX = 0, prevQCtrlY = 0;
    let lastCmd = '';
    while (i < n) {
        skipSep();
        if (i >= n)
            break;
        const c = d[i];
        if (!isNumChar(d.charCodeAt(i))) {
            cmd = c;
            i++;
            skipSep();
        }
        if (cmd === null)
            break;
        const cmdStr = cmd;
        const rel = cmdStr === cmdStr.toLowerCase() && cmdStr !== 'z';
        switch (cmd) {
            case 'M':
            case 'm': {
                let x = readNum(), y = readNum();
                if (rel) {
                    x += cx;
                    y += cy;
                }
                ctx.moveTo(x, y);
                cx = x;
                cy = y;
                startX = x;
                startY = y;
                cmd = rel ? 'l' : 'L';
                break;
            }
            case 'L':
            case 'l': {
                let x = readNum(), y = readNum();
                if (rel) {
                    x += cx;
                    y += cy;
                }
                ctx.lineTo(x, y);
                cx = x;
                cy = y;
                break;
            }
            case 'H':
            case 'h': {
                let x = readNum();
                if (rel)
                    x += cx;
                ctx.lineTo(x, cy);
                cx = x;
                break;
            }
            case 'V':
            case 'v': {
                let y = readNum();
                if (rel)
                    y += cy;
                ctx.lineTo(cx, y);
                cy = y;
                break;
            }
            case 'C':
            case 'c': {
                let x1 = readNum(), y1 = readNum();
                let x2 = readNum(), y2 = readNum();
                let x = readNum(), y = readNum();
                if (rel) {
                    x1 += cx;
                    y1 += cy;
                    x2 += cx;
                    y2 += cy;
                    x += cx;
                    y += cy;
                }
                ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
                prevCtrlX = x2;
                prevCtrlY = y2;
                cx = x;
                cy = y;
                break;
            }
            case 'S':
            case 's': {
                let x2 = readNum(), y2 = readNum();
                let x = readNum(), y = readNum();
                if (rel) {
                    x2 += cx;
                    y2 += cy;
                    x += cx;
                    y += cy;
                }
                const refl = lastCmd === 'C' || lastCmd === 'c' || lastCmd === 'S' || lastCmd === 's';
                const x1 = refl ? 2 * cx - prevCtrlX : cx;
                const y1 = refl ? 2 * cy - prevCtrlY : cy;
                ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
                prevCtrlX = x2;
                prevCtrlY = y2;
                cx = x;
                cy = y;
                break;
            }
            case 'Q':
            case 'q': {
                let x1 = readNum(), y1 = readNum();
                let x = readNum(), y = readNum();
                if (rel) {
                    x1 += cx;
                    y1 += cy;
                    x += cx;
                    y += cy;
                }
                ctx.quadraticCurveTo(x1, y1, x, y);
                prevQCtrlX = x1;
                prevQCtrlY = y1;
                cx = x;
                cy = y;
                break;
            }
            case 'T':
            case 't': {
                let x = readNum(), y = readNum();
                if (rel) {
                    x += cx;
                    y += cy;
                }
                const refl = lastCmd === 'Q' || lastCmd === 'q' || lastCmd === 'T' || lastCmd === 't';
                const x1 = refl ? 2 * cx - prevQCtrlX : cx;
                const y1 = refl ? 2 * cy - prevQCtrlY : cy;
                ctx.quadraticCurveTo(x1, y1, x, y);
                prevQCtrlX = x1;
                prevQCtrlY = y1;
                cx = x;
                cy = y;
                break;
            }
            case 'Z':
            case 'z':
                ctx.closePath();
                cx = startX;
                cy = startY;
                break;
            default:
                // Unknown / unsupported (A/a) — drain numbers to next letter
                // so we don't infinite-loop.
                while (i < n && isNumChar(d.charCodeAt(i)))
                    readNum();
                break;
        }
        lastCmd = cmd;
        skipSep();
    }
}
//# sourceMappingURL=svg-painter.js.map