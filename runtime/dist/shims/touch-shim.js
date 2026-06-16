function defineValue(target, name, value) {
    Object.defineProperty(target, name, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}
function touchRadius(touch) {
    return {
        width: Math.max(1, touch.radiusX * 2 || 1),
        height: Math.max(1, touch.radiusY * 2 || 1),
    };
}
function touchPressure(touch, active) {
    if (!active) {
        return 0;
    }
    return touch.force > 0 ? touch.force : 0.5;
}
function createPointerEvent(type, touch, active) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const radius = touchRadius(touch);
    const clientX = touch.clientX;
    const clientY = touch.clientY;
    const button = type === 'pointermove' ? -1 : 0;
    defineValue(event, 'pointerId', touch.identifier + 1);
    defineValue(event, 'pointerType', 'touch');
    defineValue(event, 'isPrimary', touch.identifier === 0);
    defineValue(event, 'button', button);
    defineValue(event, 'buttons', active ? 1 : 0);
    defineValue(event, 'pressure', touchPressure(touch, active));
    defineValue(event, 'width', radius.width);
    defineValue(event, 'height', radius.height);
    defineValue(event, 'clientX', clientX);
    defineValue(event, 'clientY', clientY);
    defineValue(event, 'pageX', touch.pageX);
    defineValue(event, 'pageY', touch.pageY);
    defineValue(event, 'screenX', touch.screenX);
    defineValue(event, 'screenY', touch.screenY);
    defineValue(event, 'offsetX', clientX);
    defineValue(event, 'offsetY', clientY);
    defineValue(event, 'x', clientX);
    defineValue(event, 'y', clientY);
    return event;
}
function createMouseEvent(type, touch, active) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const clientX = touch.clientX;
    const clientY = touch.clientY;
    const button = type === 'mousemove' ? -1 : 0;
    defineValue(event, 'button', button);
    defineValue(event, 'buttons', active ? 1 : 0);
    defineValue(event, 'clientX', clientX);
    defineValue(event, 'clientY', clientY);
    defineValue(event, 'pageX', touch.pageX);
    defineValue(event, 'pageY', touch.pageY);
    defineValue(event, 'screenX', touch.screenX);
    defineValue(event, 'screenY', touch.screenY);
    defineValue(event, 'offsetX', clientX);
    defineValue(event, 'offsetY', clientY);
    defineValue(event, 'x', clientX);
    defineValue(event, 'y', clientY);
    return event;
}
function cloneTouch(touch, target) {
    return new Touch({
        clientX: touch.clientX,
        clientY: touch.clientY,
        force: touch.force,
        identifier: touch.identifier,
        pageX: touch.pageX,
        pageY: touch.pageY,
        radiusX: touch.radiusX,
        radiusY: touch.radiusY,
        rotationAngle: touch.rotationAngle,
        screenX: touch.screenX,
        screenY: touch.screenY,
        target,
    });
}
function createTouchEvent(type, nativeEvent, target) {
    const touches = Array.from(nativeEvent.touches, (touch) => cloneTouch(touch, target));
    const targetTouches = Array.from(nativeEvent.targetTouches, (touch) => cloneTouch(touch, target));
    const changedTouches = Array.from(nativeEvent.changedTouches, (touch) => cloneTouch(touch, target));
    return new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        changedTouches,
        targetTouches,
        touches,
    });
}
function dispatchToTargets(targets, create) {
    for (const target of targets) {
        try {
            target.dispatchEvent(create(target));
        }
        catch {
            // Swallow per-target throws. Without this, a single bad
            // target (e.g. a page that replaced globalThis.document with
            // a plain object lacking dispatchEvent) would abort the whole
            // forwarding loop — and because nx.js's
            // EventTarget.dispatchEvent doesn't try/catch listener
            // throws, the throw would propagate out of the screen's
            // touch dispatch and stop nx.js's frame loop entirely
            // (no more $.onFrame calls → JS event loop frozen).
        }
    }
}
let touchShimInstalled = false;
function currentDocumentTarget() {
    const doc = globalThis.document;
    // `currentDocumentTarget` is called every touch frame, and pages
    // are free to replace `globalThis.document` with their own shim
    // (e.g. brewser's canvas-runner exposes a per-page
    // `documentShim` that only carries `getElementById`/`querySelector`,
    // not the full EventTarget interface). Filter those out so we
    // don't dispatch into a target without dispatchEvent.
    if (doc && typeof doc.dispatchEvent === 'function') {
        return doc;
    }
    return null;
}
function currentMirroredTargets() {
    const documentTarget = currentDocumentTarget();
    return [window, documentTarget].filter(Boolean);
}
function currentPointerTargets(canvas) {
    const documentTarget = currentDocumentTarget();
    return [canvas, window, documentTarget].filter(Boolean);
}
export function installTouchShim(canvas) {
    if (touchShimInstalled) {
        return;
    }
    touchShimInstalled = true;
    function forwardTouch(type, event) {
        dispatchToTargets(currentMirroredTargets(), (target) => createTouchEvent(type, event, target));
    }
    function forwardPointerAndMouse(pointerType, mouseType, event, active, includeClick = false) {
        for (const touch of event.changedTouches) {
            dispatchToTargets(currentPointerTargets(canvas), () => createPointerEvent(pointerType, touch, active));
            dispatchToTargets(currentPointerTargets(canvas), () => createMouseEvent(mouseType, touch, active));
            if (includeClick) {
                dispatchToTargets(currentPointerTargets(canvas), () => createMouseEvent('click', touch, false));
            }
        }
    }
    canvas.addEventListener('touchstart', (event) => {
        forwardTouch('touchstart', event);
        forwardPointerAndMouse('pointerdown', 'mousedown', event, true);
    });
    canvas.addEventListener('touchmove', (event) => {
        forwardTouch('touchmove', event);
        forwardPointerAndMouse('pointermove', 'mousemove', event, true);
    });
    canvas.addEventListener('touchend', (event) => {
        forwardTouch('touchend', event);
        forwardPointerAndMouse('pointerup', 'mouseup', event, false, true);
    });
}
//# sourceMappingURL=touch-shim.js.map