import { nxScreen } from '../graphics/screen.js';
import { getLiveRoot, getLiveWindow } from '../scripts/live-dom.js';
import { isKeyboardOpen } from '../scripts/live-paint-control.js';
// Inline-canvas page games (Cocos Creator, Three.js demos, hand-rolled
// WebGL) register touch listeners on either `window` or the page's
// primary `<canvas>` element. The browser-chrome touch handler in
// `controller-shortcuts.ts` dispatches the touch to the LiveElement at
// the hit point via `hitTestLive`, which works well for the chrome UI
// and live-DOM widgets — but for full-screen inline-canvas games the
// hit-test path is gated on layout boxes that aren't always populated
// for the page's primary canvas (the page sets `canvas.width/height`
// imperatively without ever triggering swb's layout pass).
//
// This forwarder runs ALONGSIDE the chrome handler: it observes the
// same touch events on `nxScreen()` and unconditionally forwards them
// to (a) every CANVAS LiveElement in the live root and (b) the live
// window. PointerEvent equivalents are dispatched on the same targets
// so engines that prefer the unified Pointer API also see input.
//
// Coords pass through unchanged — the page's canvas in inline-canvas
// mode is sized to match the screen (the pvzge canvas log reports
// 1280×720 at (0,0) on a 1280×720 screen), so screen-space ≡ canvas-
// space. If a future page renders into a smaller off-center canvas
// we'll add a per-canvas layout-box translation here.
let installed = false;
let nextPointerId = 1;
const pointerIdByTouchId = new Map();
function collectCanvases(root, out) {
    if (root.tagName === 'CANVAS')
        out.push(root);
    for (const child of root.children)
        collectCanvases(child, out);
}
function toSynthTouch(t, target) {
    return {
        clientX: t.clientX,
        clientY: t.clientY,
        pageX: t.clientX,
        pageY: t.clientY,
        screenX: t.screenX,
        screenY: t.screenY,
        identifier: t.identifier,
        radiusX: t.radiusX ?? 1,
        radiusY: t.radiusY ?? 1,
        rotationAngle: t.rotationAngle ?? 0,
        force: 1,
        target,
    };
}
function dispatchTouchTo(target, type, touches, changedTouches) {
    target.dispatchEvent({
        type,
        touches,
        changedTouches,
        targetTouches: touches,
        bubbles: true,
        cancelable: true,
        target,
        currentTarget: target,
        isTrusted: true,
        preventDefault: () => { },
        stopPropagation: () => { },
    });
}
function dispatchPointerTo(target, type, touch) {
    let pointerId = pointerIdByTouchId.get(touch.identifier);
    if (pointerId === undefined) {
        pointerId = nextPointerId++;
        pointerIdByTouchId.set(touch.identifier, pointerId);
    }
    target.dispatchEvent({
        type,
        clientX: touch.clientX,
        clientY: touch.clientY,
        pageX: touch.pageX,
        pageY: touch.pageY,
        screenX: touch.screenX,
        screenY: touch.screenY,
        pointerId,
        pointerType: 'touch',
        isPrimary: touch.identifier === 0,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        width: (touch.radiusX || 1) * 2,
        height: (touch.radiusY || 1) * 2,
        pressure: type === 'pointerup' ? 0 : 0.5,
        tangentialPressure: 0,
        tiltX: 0,
        tiltY: 0,
        twist: 0,
        bubbles: true,
        cancelable: true,
        target,
        currentTarget: target,
        isTrusted: true,
        preventDefault: () => { },
        stopPropagation: () => { },
    });
    if (type === 'pointerup' || type === 'pointercancel') {
        pointerIdByTouchId.delete(touch.identifier);
    }
}
function forward(touchType, pointerType, ev) {
    // 2026-06-14 kb-input lag fix: while the on-canvas keyboard is open,
    // the touch belongs entirely to the keyboard (controller-shortcuts'
    // own listener routes it through `__brewserKeyboardHandleTap`).
    // Page games (Cocos, Three.js) registered touch handlers on
    // `window`/canvas before the keyboard opened; dispatching to them
    // here makes their touch processing run synchronously on top of the
    // kb tick's repaint. On Cocos pages the page-side touch handling
    // alone took long enough to keep the JS thread busy past the next
    // HID poll, dropping the user's NEXT keystroke. Skip forwarding
    // entirely while the kb is up — the page won't receive any touch
    // events during keyboard input, which matches what the user expects
    // (the kb owns the screen).
    if (isKeyboardOpen())
        return;
    const canvases = [];
    collectCanvases(getLiveRoot(), canvases);
    const primaryCanvas = canvases.length ? canvases[canvases.length - 1] : null;
    const liveWindow = getLiveWindow();
    const touches = [];
    for (let i = 0; i < ev.touches.length; i++) {
        touches.push(toSynthTouch(ev.touches[i], primaryCanvas));
    }
    const changed = [];
    for (let i = 0; i < ev.changedTouches.length; i++) {
        changed.push(toSynthTouch(ev.changedTouches[i], primaryCanvas));
    }
    if (primaryCanvas) {
        dispatchTouchTo(primaryCanvas, touchType, touches, changed);
        for (const t of changed)
            dispatchPointerTo(primaryCanvas, pointerType, t);
    }
    dispatchTouchTo(liveWindow, touchType, touches, changed);
    for (const t of changed)
        dispatchPointerTo(liveWindow, pointerType, t);
}
export function installPageTouchForwarder() {
    if (installed)
        return;
    installed = true;
    const screen = nxScreen();
    screen.addEventListener('touchstart', (ev) => {
        forward('touchstart', 'pointerdown', ev);
    });
    screen.addEventListener('touchmove', (ev) => {
        forward('touchmove', 'pointermove', ev);
    });
    screen.addEventListener('touchend', (ev) => {
        forward('touchend', 'pointerup', ev);
    });
}
//# sourceMappingURL=page-touch-forwarder.js.map