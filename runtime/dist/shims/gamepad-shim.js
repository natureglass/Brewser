const STANDARD_BUTTON_NAMES = [
    'A',
    'B',
    'X',
    'Y',
    'L',
    'R',
    'ZL',
    'ZR',
    'Minus',
    'Plus',
    'StickL',
    'StickR',
    'Up',
    'Down',
    'Left',
    'Right',
];
// nx.js exposes Switch order: B, A, Y, X, L, R, ZL, ZR...
// Browser-style apps typically expect the first four buttons as A, B, X, Y.
const STANDARD_TO_NX_BUTTON = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
let gamepadShimInstalled = false;
function defineValue(target, name, value) {
    Object.defineProperty(target, name, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}
function cloneButton(button) {
    return {
        pressed: button?.pressed ?? false,
        touched: button?.touched ?? button?.pressed ?? false,
        value: button?.value ?? (button?.pressed ? 1 : 0),
    };
}
function normalizeGamepad(pad) {
    const buttons = STANDARD_TO_NX_BUTTON.map((nativeIndex, index) => {
        const button = cloneButton(pad.buttons[nativeIndex]);
        defineValue(button, 'name', STANDARD_BUTTON_NAMES[index]);
        return button;
    });
    return {
        axes: Array.from(pad.axes),
        buttons,
        connected: pad.connected,
        deviceType: pad.deviceType,
        id: pad.id || `Nintendo Switch Controller ${pad.index}`,
        index: pad.index,
        mapping: 'standard',
        rawButtons: pad.rawButtons,
        styleSet: pad.styleSet,
        timestamp: pad.timestamp,
        vibrationActuator: pad.vibrationActuator,
    };
}
function createGamepadEvent(type, gamepad) {
    if (typeof GamepadEvent === 'function') {
        return new GamepadEvent(type, { gamepad: gamepad });
    }
    return new CustomEvent(type, { detail: { gamepad } });
}
export function installGamepadShim() {
    if (gamepadShimInstalled) {
        return;
    }
    gamepadShimInstalled = true;
    const nativeGetGamepads = navigator.getGamepads.bind(navigator);
    const connected = new Set();
    function getGamepads() {
        return nativeGetGamepads().map((pad) => (pad ? normalizeGamepad(pad) : null));
    }
    defineValue(navigator, 'getGamepads', getGamepads);
    function pollGamepadConnections() {
        for (const pad of getGamepads()) {
            if (!pad) {
                continue;
            }
            if (pad.connected && !connected.has(pad.index)) {
                connected.add(pad.index);
                dispatchEvent(createGamepadEvent('gamepadconnected', pad));
            }
            else if (!pad.connected && connected.has(pad.index)) {
                connected.delete(pad.index);
                dispatchEvent(createGamepadEvent('gamepaddisconnected', pad));
            }
        }
    }
    pollGamepadConnections();
    setInterval(pollGamepadConnections, 250);
}
//# sourceMappingURL=gamepad-shim.js.map