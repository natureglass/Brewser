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
export function loadOptionalImage(src) {
    if (!src)
        return Promise.resolve(null);
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => {
            console.debug(`[brewser] image load failed: ${src}`);
            resolve(null);
        };
        img.src = src;
    });
}
//# sourceMappingURL=load-optional-image.js.map