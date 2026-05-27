/**
 * Generic inline-SVG rasterizer. Walks a parsed SVG subtree and paints
 * its `<rect>` / `<circle>` / `<ellipse>` / `<line>` / `<polyline>` /
 * `<polygon>` / `<path>` / `<g>` children with Canvas2D primitives.
 *
 * Source-agnostic: the caller passes an adapter that knows how to read
 * a node's tag, attribute, and child list. Today the only caller is
 * the live-DOM path (`scripts/live-overlay.ts`); the adapter pattern
 * is preserved for future callers.
 *
 * Out of scope: `<text>`, `<image>`, `<use>`, `<defs>`, gradients,
 * patterns, masks, filters, animations, the elliptical-arc `A/a` path
 * command, and CSS-style transforms.
 */

export interface SvgNodeAdapter<N> {
	tag(n: N): string;
	attr(n: N, name: string): string | undefined;
	children(n: N): N[];
}

interface SvgInherited {
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
}

export function paintSvgSubtree<N>(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	root: N,
	adapter: SvgNodeAdapter<N>,
): void {
	for (const child of adapter.children(root)) {
		paintNode(ctx as CanvasRenderingContext2D, child, adapter, {});
	}
}

function paintNode<N>(
	ctx: CanvasRenderingContext2D,
	node: N,
	a: SvgNodeAdapter<N>,
	inherited: SvgInherited,
): void {
	const tag = a.tag(node).toLowerCase();
	const merged = merge(node, a, inherited);
	switch (tag) {
		case 'g':
			for (const c of a.children(node)) paintNode(ctx, c, a, merged);
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

function merge<N>(node: N, a: SvgNodeAdapter<N>, inh: SvgInherited): SvgInherited {
	const fill = a.attr(node, 'fill') ?? inh.fill;
	const stroke = a.attr(node, 'stroke') ?? inh.stroke;
	const swRaw = a.attr(node, 'stroke-width');
	const strokeWidth = swRaw !== undefined ? parseFloat(swRaw) : inh.strokeWidth;
	return { fill, stroke, strokeWidth };
}

function applyPaint(ctx: CanvasRenderingContext2D, m: SvgInherited): { didFill: boolean; didStroke: boolean } {
	const fill = m.fill ?? 'black';
	const stroke = m.stroke ?? 'none';
	const sw = m.strokeWidth ?? 1;
	const didFill = fill !== 'none' && fill !== 'transparent';
	const didStroke = stroke !== 'none' && stroke !== 'transparent' && sw > 0;
	if (didFill) ctx.fillStyle = fill;
	if (didStroke) {
		ctx.strokeStyle = stroke;
		ctx.lineWidth = sw;
	}
	return { didFill, didStroke };
}

function num<N>(node: N, a: SvgNodeAdapter<N>, name: string, dflt = 0): number {
	const raw = a.attr(node, name);
	if (raw === undefined) return dflt;
	const v = parseFloat(raw);
	return Number.isFinite(v) ? v : dflt;
}

function paintRect<N>(ctx: CanvasRenderingContext2D, node: N, a: SvgNodeAdapter<N>, m: SvgInherited): void {
	const x = num(node, a, 'x');
	const y = num(node, a, 'y');
	const w = num(node, a, 'width');
	const h = num(node, a, 'height');
	const rx = num(node, a, 'rx');
	const ry = num(node, a, 'ry', rx);
	if (w <= 0 || h <= 0) return;
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
	} else {
		ctx.rect(x, y, w, h);
	}
	if (didFill) ctx.fill();
	if (didStroke) ctx.stroke();
}

function paintCircle<N>(ctx: CanvasRenderingContext2D, node: N, a: SvgNodeAdapter<N>, m: SvgInherited): void {
	const cx = num(node, a, 'cx');
	const cy = num(node, a, 'cy');
	const r = num(node, a, 'r');
	if (r <= 0) return;
	const { didFill, didStroke } = applyPaint(ctx, m);
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, Math.PI * 2);
	if (didFill) ctx.fill();
	if (didStroke) ctx.stroke();
}

function paintEllipse<N>(ctx: CanvasRenderingContext2D, node: N, a: SvgNodeAdapter<N>, m: SvgInherited): void {
	const cx = num(node, a, 'cx');
	const cy = num(node, a, 'cy');
	const rx = num(node, a, 'rx');
	const ry = num(node, a, 'ry');
	if (rx <= 0 || ry <= 0) return;
	const { didFill, didStroke } = applyPaint(ctx, m);
	ctx.beginPath();
	ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	if (didFill) ctx.fill();
	if (didStroke) ctx.stroke();
}

function paintLine<N>(ctx: CanvasRenderingContext2D, node: N, a: SvgNodeAdapter<N>, m: SvgInherited): void {
	const x1 = num(node, a, 'x1');
	const y1 = num(node, a, 'y1');
	const x2 = num(node, a, 'x2');
	const y2 = num(node, a, 'y2');
	const { didStroke } = applyPaint(ctx, m);
	if (!didStroke) return;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
}

function paintPoly<N>(ctx: CanvasRenderingContext2D, node: N, a: SvgNodeAdapter<N>, m: SvgInherited, close: boolean): void {
	const raw = a.attr(node, 'points');
	if (!raw) return;
	const nums = raw.trim().split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n));
	if (nums.length < 4) return;
	const { didFill, didStroke } = applyPaint(ctx, m);
	ctx.beginPath();
	ctx.moveTo(nums[0], nums[1]);
	for (let i = 2; i + 1 < nums.length; i += 2) ctx.lineTo(nums[i], nums[i + 1]);
	if (close) ctx.closePath();
	if (didFill && close) ctx.fill();
	if (didStroke) ctx.stroke();
}

function paintPath<N>(ctx: CanvasRenderingContext2D, node: N, a: SvgNodeAdapter<N>, m: SvgInherited): void {
	const d = a.attr(node, 'd');
	if (!d) return;
	const { didFill, didStroke } = applyPaint(ctx, m);
	ctx.beginPath();
	executePath(ctx, d);
	if (didFill) ctx.fill();
	if (didStroke) ctx.stroke();
}

/** Minimal SVG `d` parser. Supports M/m, L/l, H/h, V/v, C/c, S/s,
 * Q/q, T/t, Z/z. The elliptical-arc `A/a` is consumed but renders as a
 * lineTo for now (Tier 3 — needs SVG-arc-to-cubic-bezier reduction). */
function executePath(ctx: CanvasRenderingContext2D, d: string): void {
	let i = 0;
	const n = d.length;
	const skipSep = () => { while (i < n && (d.charCodeAt(i) <= 32 || d[i] === ',')) i++; };
	const isNumChar = (c: number) => (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46;
	const readNum = (): number => {
		skipSep();
		const start = i;
		if (d[i] === '+' || d[i] === '-') i++;
		while (i < n) {
			const c = d.charCodeAt(i);
			if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69) i++;
			else break;
		}
		const v = parseFloat(d.slice(start, i));
		return Number.isFinite(v) ? v : 0;
	};
	let cmd: string | null = null;
	let cx = 0, cy = 0;
	let startX = 0, startY = 0;
	let prevCtrlX = 0, prevCtrlY = 0;
	let prevQCtrlX = 0, prevQCtrlY = 0;
	let lastCmd = '';
	while (i < n) {
		skipSep();
		if (i >= n) break;
		const c = d[i];
		if (!isNumChar(d.charCodeAt(i))) {
			cmd = c;
			i++;
			skipSep();
		}
		if (cmd === null) break;
		const rel = cmd === cmd.toLowerCase() && cmd !== 'z';
		switch (cmd) {
			case 'M': case 'm': {
				let x = readNum(), y = readNum();
				if (rel) { x += cx; y += cy; }
				ctx.moveTo(x, y);
				cx = x; cy = y;
				startX = x; startY = y;
				cmd = rel ? 'l' : 'L';
				break;
			}
			case 'L': case 'l': {
				let x = readNum(), y = readNum();
				if (rel) { x += cx; y += cy; }
				ctx.lineTo(x, y);
				cx = x; cy = y;
				break;
			}
			case 'H': case 'h': {
				let x = readNum();
				if (rel) x += cx;
				ctx.lineTo(x, cy);
				cx = x;
				break;
			}
			case 'V': case 'v': {
				let y = readNum();
				if (rel) y += cy;
				ctx.lineTo(cx, y);
				cy = y;
				break;
			}
			case 'C': case 'c': {
				let x1 = readNum(), y1 = readNum();
				let x2 = readNum(), y2 = readNum();
				let x  = readNum(), y  = readNum();
				if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
				ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
				prevCtrlX = x2; prevCtrlY = y2;
				cx = x; cy = y;
				break;
			}
			case 'S': case 's': {
				let x2 = readNum(), y2 = readNum();
				let x  = readNum(), y  = readNum();
				if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
				const refl = lastCmd === 'C' || lastCmd === 'c' || lastCmd === 'S' || lastCmd === 's';
				const x1 = refl ? 2 * cx - prevCtrlX : cx;
				const y1 = refl ? 2 * cy - prevCtrlY : cy;
				ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
				prevCtrlX = x2; prevCtrlY = y2;
				cx = x; cy = y;
				break;
			}
			case 'Q': case 'q': {
				let x1 = readNum(), y1 = readNum();
				let x  = readNum(), y  = readNum();
				if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; }
				ctx.quadraticCurveTo(x1, y1, x, y);
				prevQCtrlX = x1; prevQCtrlY = y1;
				cx = x; cy = y;
				break;
			}
			case 'T': case 't': {
				let x = readNum(), y = readNum();
				if (rel) { x += cx; y += cy; }
				const refl = lastCmd === 'Q' || lastCmd === 'q' || lastCmd === 'T' || lastCmd === 't';
				const x1 = refl ? 2 * cx - prevQCtrlX : cx;
				const y1 = refl ? 2 * cy - prevQCtrlY : cy;
				ctx.quadraticCurveTo(x1, y1, x, y);
				prevQCtrlX = x1; prevQCtrlY = y1;
				cx = x; cy = y;
				break;
			}
			case 'Z': case 'z':
				ctx.closePath();
				cx = startX; cy = startY;
				break;
			default:
				// Unknown / unsupported (A/a) — drain numbers to next letter
				// so we don't infinite-loop.
				while (i < n && isNumChar(d.charCodeAt(i))) readNum();
				break;
		}
		lastCmd = cmd;
		skipSep();
	}
}
