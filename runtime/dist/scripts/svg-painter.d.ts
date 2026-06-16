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
/// <reference types="@nx.js/runtime" />
export interface SvgNodeAdapter<N> {
    tag(n: N): string;
    attr(n: N, name: string): string | undefined;
    children(n: N): N[];
}
export declare function paintSvgSubtree<N>(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, root: N, adapter: SvgNodeAdapter<N>): void;
//# sourceMappingURL=svg-painter.d.ts.map