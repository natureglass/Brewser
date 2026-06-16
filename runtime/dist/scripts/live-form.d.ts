/// <reference types="@nx.js/runtime" />
import { type ComputedLiveStyle } from './live-css.js';
import { type LiveElement } from './live-dom.js';
import { type LayoutBox } from './live-layout.js';
/** Per-call options the shell-registered opener forwards to the
 * KeyboardOverlay. `validate` gates the Submit key + `+`-press so
 * `<input type="number">` taps can reject letter-laden input the way
 * real browsers paint a disabled Enter on their numeric soft keyboard. */
export interface KeyboardOpenOptions {
    validate?: (value: string) => boolean;
}
type KeyboardOpener = (initial: string, options?: KeyboardOpenOptions) => Promise<string | null>;
export declare function setKeyboardOpener(fn: KeyboardOpener | null): void;
export declare function setLiveFormColorScheme(_scheme: 'light' | 'dark'): void;
export declare function getInputValue(el: LiveElement): string;
export declare function setInputValue(el: LiveElement, v: string): void;
export declare function getInputChecked(el: LiveElement): boolean;
export declare function setInputChecked(el: LiveElement, v: boolean): void;
/** Does this tag draw via the form-widget painter (instead of the
 * generic text/bg painter)? SUMMARY + LABEL aren't really form widgets,
 * but they share the "tap → default action" contract that controller-
 * shortcuts routes through `handleFormTap`. SUMMARY toggles its parent
 * details; LABEL forwards the tap to its `for=` target. Without
 * inclusion in this set, tapping them would only dispatch a click event
 * without firing the default action. */
export declare function isFormWidget(el: LiveElement): boolean;
/** Paint a form widget element given its computed style + layout box.
 * Returns true if the element was handled (caller skips the generic
 * painter); false to fall through to the regular div/text path. */
export declare function paintFormWidget(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, el: LiveElement, cs: ComputedLiveStyle, box: LayoutBox, 
/** When true, the caller already painted the box background +
 * border + shadow (rich CSS bg path), so the widget should draw
 * only its foreground (label / value text). */
skipBg?: boolean): boolean;
/** Returns true if `el` is a form widget and the tap was consumed
 * (caller should not fire a generic `click` after this). False means
 * the caller should fall through to the normal click dispatch.
 *
 * `tapX` (optional, screen space) is used by `<input type=range>` to
 * compute the new value from the tap position. Callers that don't have
 * a tap position (e.g. synthetic click from a label-for forward) can
 * omit it — range falls back to bumping the value by one step.
 *
 * Phase 1.5+1.6 follow-up (2026-05-25): every consumed tap flags
 * `requestFullRepaint()` so the shell's `onTick` (in browser-shell.ts)
 * notices and refreshes the screen even when the page has no rAF loop
 * driving paints. Without this, the live-overlay cache rebuilds happen
 * on the NEXT scroll instead of immediately — taps "feel dead." */
export declare function handleFormTap(el: LiveElement, tapX?: number, clickAlreadyFired?: boolean): Promise<boolean>;
export declare function openKeyboardAndApply(el: LiveElement): Promise<boolean>;
/** Walk up from `start` to the enclosing `<form>` (or `null` if none).
 * Used to resolve a submit-button tap to its owning form. */
export declare function findEnclosingForm(start: LiveElement): LiveElement | null;
/** Build the URL a `<form>` would navigate to when submitted by
 * `submitter` (a submit button / submit input — null if the form was
 * submitted by some other means, e.g. an Enter keypress on a text
 * field). Returns `null` when the form has no `action` AND no enclosing
 * page to default it against — in that case the caller should skip
 * navigation.
 *
 * GET method: serialise every named, non-disabled, successful control
 * into the action URL's query string per HTML's
 * application/x-www-form-urlencoded algorithm. The action itself can be
 * relative — the shell resolves it against the current page URL the
 * same way it does for `<a href>`.
 *
 * POST method: we don't yet have a request-body navigation path, so we
 * navigate to the action URL with no body. The result will be wrong
 * for sites that expect form data in a POST, but it won't crash and it
 * leaves the door open for a real POST-navigation slice later.
 */
export declare function buildFormSubmitUrl(form: LiveElement, submitter: LiveElement | null): string | null;
export {};
//# sourceMappingURL=live-form.d.ts.map