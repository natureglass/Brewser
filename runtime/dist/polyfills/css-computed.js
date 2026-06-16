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
import { getComputedLiveStyle } from '../scripts/live-css.js';
/** Read `<number>px` (or unitless number) as a string. CSS spec
 * always serialises lengths with the `px` unit attached. */
function serializePx(n) {
    if (n === undefined || n === null || Number.isNaN(n))
        return '';
    return n + 'px';
}
/** Extract the color portion from a `background:` shorthand value.
 * Real `background-color` parsing is non-trivial; we cheat by
 * looking for `rgb(...)` / `#xxx` / `<color-keyword>` substrings.
 * Falls back to the whole value if no recognisable color is found. */
function extractBackgroundColor(bg) {
    if (!bg)
        return '';
    const rgb = bg.match(/rgba?\([^)]+\)/i);
    if (rgb)
        return rgb[0];
    const hex = bg.match(/#[0-9a-f]{3,8}\b/i);
    if (hex)
        return hex[0];
    // Color keyword fallback — common names. Spec has ~140; cover the
    // ones page scripts actually compare against.
    const kw = bg.match(/\b(red|green|blue|black|white|transparent|yellow|cyan|magenta|gray|grey|silver|orange|purple|pink|brown)\b/i);
    if (kw)
        return kw[0];
    return bg;
}
class LiveCSSStyleDeclaration {
    #computed;
    constructor(computed) { this.#computed = computed; }
    getPropertyValue(name) {
        if (!name)
            return '';
        // Custom properties — case-sensitive per spec.
        if (name.startsWith('--')) {
            return this.#computed.customProps?.[name] ?? '';
        }
        const c = this.#computed;
        switch (name.toLowerCase()) {
            case 'color': return c.color ?? '';
            case 'background': return c.background ?? '';
            case 'background-color':
                return extractBackgroundColor(c.background ?? '');
            case 'font-family': return c.fontFamily ?? '';
            case 'font-size': return serializePx(c.fontSize);
            case 'font-weight':
                return c.fontWeight === undefined ? '' : String(c.fontWeight);
            case 'font-style': return c.fontStyle ?? '';
            case 'text-align': return c.textAlign ?? '';
            case 'line-height':
                return c.lineHeight === undefined ? '' : String(c.lineHeight);
            case 'cursor': return c.cursor ?? '';
            case 'opacity':
                return c.opacity === undefined ? '' : String(c.opacity);
            case 'display': return c.display ?? '';
            case 'width': return serializePx(c.width);
            case 'height': return serializePx(c.height);
            case 'padding-top': return serializePx(c.paddingTop);
            case 'padding-right': return serializePx(c.paddingRight);
            case 'padding-bottom': return serializePx(c.paddingBottom);
            case 'padding-left': return serializePx(c.paddingLeft);
            case 'margin-top': return serializePx(c.marginTop);
            case 'margin-right': return serializePx(c.marginRight);
            case 'margin-bottom': return serializePx(c.marginBottom);
            case 'margin-left': return serializePx(c.marginLeft);
            default: return '';
        }
    }
    // Best-effort camelCase field access. Most page scripts use
    // `getPropertyValue`, but a few (lit-html / older jQuery) read
    // fields directly. Mirrors what getPropertyValue returns for
    // the same logical property.
    get color() { return this.getPropertyValue('color'); }
    get background() { return this.getPropertyValue('background'); }
    get backgroundColor() { return this.getPropertyValue('background-color'); }
    get fontFamily() { return this.getPropertyValue('font-family'); }
    get fontSize() { return this.getPropertyValue('font-size'); }
    get width() { return this.getPropertyValue('width'); }
    get height() { return this.getPropertyValue('height'); }
    get display() { return this.getPropertyValue('display'); }
    get opacity() { return this.getPropertyValue('opacity'); }
}
let installed = false;
/** Define `globalThis.getComputedStyle`. Call once at app startup
 * BEFORE any page script reads it. */
export function installGetComputedStyle() {
    if (installed)
        return;
    installed = true;
    const fn = (el, _pseudo) => {
        // Pseudo-element second arg is accepted but ignored (Tier-1).
        // Returns an "empty" declaration for null / undefined elements.
        const computed = el ? getComputedLiveStyle(el) : {};
        return new LiveCSSStyleDeclaration(computed);
    };
    Object.defineProperty(globalThis, 'getComputedStyle', {
        value: fn,
        writable: false,
        configurable: true,
        enumerable: true,
    });
}
//# sourceMappingURL=css-computed.js.map