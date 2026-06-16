/**
 * Tier-1 `getComputedStyle(el)` polyfill for the swb live-DOM.
 *
 * Page scripts that read computed values for layout-dependent
 * behaviour (theme switches, responsive UI libraries, framework
 * computed-prop reads) need this. Standard reads:
 *   getComputedStyle(el).getPropertyValue('background-color')
 *   getComputedStyle(el).getPropertyValue('--custom-prop')
 *   getComputedStyle(el).width    // CSSStyleDeclaration field
 *
 * The returned object wraps the element's cascaded ComputedLiveStyle
 * (from `live-css.ts`). Tier-1 supports:
 *   - Custom properties (`--foo`) — exact read from the customProps
 *     bag merged by the cascade (parent + stylesheet + inline)
 *   - Common visual properties via `getPropertyValue`: color,
 *     background, background-color (extracts color portion), width,
 *     height, font-size, font-family, padding-*, margin-*, opacity,
 *     display, cursor, line-height
 *   - Camel-case field-style access for the same set
 *
 * Tier-1 NOT supported (best-effort fallback to empty string / undef):
 *   - Pseudo-element second arg (`getComputedStyle(el, ':before')`)
 *   - `cssText` serialisation of the whole style
 *   - `length` / index access
 *   - Length serialisation in `px` (numbers come back as bare strings;
 *     real browsers always append `px`)
 *
 * itch.io compat roadmap A3.
 */
/** Define `globalThis.getComputedStyle`. Call once at app startup
 * BEFORE any page script reads it. */
export declare function installGetComputedStyle(): void;
//# sourceMappingURL=css-computed.d.ts.map