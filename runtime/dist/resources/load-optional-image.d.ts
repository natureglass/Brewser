/// <reference types="@nx.js/runtime" />
/**
 * Tiny image loader that resolves to `null` when the path is empty
 * instead of throwing or logging. Used by the boot splash + (future)
 * theme code that wants "show this image if it loads, otherwise just
 * skip" semantics.
 *
 * Extracted from the old `chrome-icons.ts` 2026-06-14 when the
 * engine-drawn toolbar (and its icon set) was ripped out in favour
 * of HTML-driven themes that embed their own `<img src>` tags. The
 * `<img>` decode + chrome paint path is gone; this helper survives
 * for callers that still want a one-off image load.
 */
export declare function loadOptionalImage(src: string): Promise<Image | null>;
//# sourceMappingURL=load-optional-image.d.ts.map