import { COMBO_BUTTONS } from '../browser-config.js';
import { nxScreen } from '../graphics/screen.js';
import { playClick } from '../audio/click-sound.js';
import { getInternalLiveScrollY, getLiveTreeVersion, hitTestLive, setInternalLiveScrollY, } from '../scripts/live-dom.js';
import { setPseudoActive } from '../scripts/live-css.js';
import { setInputValue } from '../scripts/live-form.js';
import { getKbTreeVersion, getKeyboardLiveRoot, getKeyboardTopY, popKbMutationScope, pushKbMutationScope, setKeyboardOpen, setKeyboardOverlayVisible, } from '../scripts/live-paint-control.js';
import { getCursorPos, syncMouseButtonsToCurrent, tickCursorMovementOnly } from './page-mouse-forwarder.js';
import { getButtonIndexForAction } from './button-router.js';
/** Right-stick Y axis on the standard nx.js gamepad mapping. */
const RIGHT_STICK_Y_AXIS = 3;
const STICK_DEADZONE = 0.15;
/** Max scroll px per pollLoop tick at full right-stick deflection.
 * Poll loop runs at ~16 ms = ~60 Hz, so full deflection ≈ 600 px/s. */
const MAX_SCROLL_PER_TICK = 10;
function readStickScroll(pad) {
    const axis = pad?.axes[RIGHT_STICK_Y_AXIS] ?? 0;
    const abs = Math.abs(axis);
    if (abs < STICK_DEADZONE)
        return 0;
    const normalized = (abs - STICK_DEADZONE) / (1 - STICK_DEADZONE);
    return Math.sign(axis) * Math.round(normalized * normalized * MAX_SCROLL_PER_TICK);
}
function activePad() {
    return navigator.getGamepads().find((g) => g && g.connected) ?? null;
}
function readButtons() {
    const pad = activePad();
    const button = (i) => Boolean(pad?.buttons[i]?.pressed);
    // `a` (activate hovered key) and `b` (cancel) follow `config.json buttonMapping`
    // via the button router so the user's remaps apply uniformly. `+` (Plus)
    // always submits; not user-remappable.
    const leftClickIdx = getButtonIndexForAction('leftClick');
    const rightClickIdx = getButtonIndexForAction('rightClick');
    return {
        a: leftClickIdx >= 0 ? button(leftClickIdx) : false,
        b: rightClickIdx >= 0 ? button(rightClickIdx) : false,
        plus: button(COMBO_BUTTONS.plus),
    };
}
function rising(prev, next, name) {
    return next[name] && !prev[name];
}
/** Repaint callback the shell registers at startup. See JSDoc on
 * `setKeyboardRepaintDriver` for the rationale — the shell's main
 * loop is suspended on open()'s promise, so the keyboard ticks its
 * own paints during the lifetime of a session. */
let repaintDriver = null;
export function setKeyboardRepaintDriver(cb) {
    repaintDriver = cb;
}
const nativeSetTimeout = setTimeout.bind(globalThis);
/** Lowercase character → uppercase. Used for letter keys when Shift
 * XOR Caps is on. Non-letter keys (numbers / punctuation) go through
 * the shift-symbol map below. */
function toUpper(ch) {
    if (/^[a-z]$/.test(ch))
        return ch.toUpperCase();
    return ch;
}
/** Original page-script's shift-symbol map. Mirrors a US QWERTY layout. */
const SHIFT_SYMBOLS = {
    '`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
    ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
};
function shiftSymbol(ch) {
    return SHIFT_SYMBOLS[ch] ?? ch;
}
/** Walk parent chain to find the nearest element with `class="key"`.
 * Returns `null` if `el` isn't inside a key (e.g. tap landed on the
 * `.kb` panel bg between keys). */
function findKey(el) {
    for (let n = el; n; n = n.parent) {
        const cls = n.getAttribute?.('class') ?? '';
        if (cls.split(/\s+/).includes('key'))
            return n;
    }
    return null;
}
/** Pull the "base" character to insert for a non-action key. Numeric
 * keys are `<div class="key num"><span class="sup">!</span>1</div>` —
 * the displayed digit is the LAST text node. Plain letter / symbol
 * keys hold their character as the only text child. `data-char` wins
 * if present (used by the space bar so its visible glyph can be
 * `&nbsp;` while the inserted char is a real space). */
function readKeyChar(key) {
    const dataChar = key.getAttribute('data-char');
    if (dataChar !== null && dataChar !== undefined)
        return dataChar;
    // Walk children for the last text node — handles both the `.num`
    // case (sup span + digit text) and plain letter keys (single text
    // node).
    for (let i = key.children.length - 1; i >= 0; i--) {
        const child = key.children[i];
        if (child.tagName === '#text') {
            const t = child.data ?? '';
            const trimmed = t.trim();
            if (trimmed)
                return trimmed;
        }
    }
    return '';
}
/** Shift super-script for `.num` keys (the `<span class="sup">` child).
 * Returns the sup char, or null if none. */
function readKeySup(key) {
    for (const child of key.children) {
        const cls = child.getAttribute?.('class') ?? '';
        if (cls.split(/\s+/).includes('sup')) {
            for (const grand of child.children) {
                if (grand.tagName === '#text') {
                    const t = grand.data ?? '';
                    const trimmed = t.trim();
                    if (trimmed)
                        return trimmed;
                }
            }
        }
    }
    return null;
}
/** Locate the `<input id="urlInput">` inside the keyboard root so we
 * can mirror typed input there via `setInputValue`. Returns null if
 * the kb root is missing the field (defensive — the seeded
 * keyboard.html always has it). */
function findUrlInput(root) {
    const visit = (n) => {
        if (n.getAttribute?.('id') === 'urlInput')
            return n;
        for (const c of n.children) {
            const f = visit(c);
            if (f)
                return f;
        }
        return null;
    };
    return visit(root);
}
/** Walk the kb tree collecting every `<div class="key letter">` so the
 * case-rewrite pass can flip them all in one go on shift / caps
 * toggles. Cheap (~26 elements) and only runs at session start. */
function findLetterKeys(root) {
    const out = [];
    const visit = (n) => {
        const cls = n.getAttribute?.('class') ?? '';
        const tokens = cls.split(/\s+/);
        if (tokens.includes('key') && tokens.includes('letter')) {
            out.push(n);
        }
        for (const c of n.children)
            visit(c);
    };
    visit(root);
    return out;
}
/** Find the action key by `data-action` value (e.g. `'caps'` or
 * `'shift'`). Used to toggle the `held` class so the user can see
 * latch state. */
function findActionKey(root, action) {
    const visit = (n) => {
        if (n.getAttribute?.('data-action') === action)
            return n;
        for (const c of n.children) {
            const f = visit(c);
            if (f)
                return f;
        }
        return null;
    };
    return visit(root);
}
/** Locate the FIRST `#text` descendant of `key` whose data is a single
 * a-z (or A-Z) letter — that's the displayed character. Returns null
 * if the key's content is something else (e.g. action keys whose only
 * child is `<svg>`). */
function findLetterTextNode(key) {
    const visit = (n) => {
        if (n.tagName === '#text') {
            const t = (n.data ?? '').trim();
            if (t.length === 1 && /^[a-zA-Z]$/.test(t))
                return n;
        }
        for (const c of n.children) {
            const f = visit(c);
            if (f)
                return f;
        }
        return null;
    };
    return visit(key);
}
/** Apply the current case (shift XOR caps) to every letter key in
 * `letterKeys`. Pure text-node mutation — no class toggle, no CSS rule
 * dependency. Called whenever shift or caps changes, and on session
 * open() to sync with the initial state. */
function applyLetterCase(letterKeys, upper) {
    for (const key of letterKeys) {
        const tn = findLetterTextNode(key);
        if (!tn)
            continue;
        const cur = (tn.data ?? '');
        const next = upper ? cur.toUpperCase() : cur.toLowerCase();
        if (next !== cur) {
            tn.data = next;
        }
    }
}
/**
 * HTML-driven virtual keyboard. Replaces the on-canvas keyboard that
 * lived in this file pre-2026-06-11. The keyboard's visible markup
 * lives in the file named by `config.json`'s `keyboard` field
 * (`keyboards/<file>.html` relative to the app root) and is parsed into a
 * SECOND live-DOM root at shell startup (see
 * `BrowserShell.loadHtmlKeyboard` / `paintKeyboardOverlay`).
 *
 * Open/close lifecycle:
 *   - `open()` flips `setKeyboardOpen(true)` (input-dispatch gate) +
 *     `setKeyboardOverlayVisible(true)` (paint gate), seeds the
 *     `<input>` with `initial`, registers the global submit/cancel/tap
 *     hooks, and starts an internal repaint tick.
 *   - Touch lands inside the kb panel area → controller-shortcuts
 *     calls `globalThis.__brewserKeyboardHandleTap(el)`. The handler
 *     processes the key (insert / backspace / nav / shift / caps /
 *     submit / etc.) and updates the visible `<input>` text via
 *     `setInputValue`.
 *   - Submit (tap `#submitBtn`, or external `__brewserKeyboardSubmit`)
 *     resolves with the typed value. Cancel (tap above panel, or
 *     external `__brewserKeyboardCancel`) resolves with `null`.
 */
export class KeyboardOverlay {
    async open(initial = '', callbacks = {}) {
        const root = getKeyboardLiveRoot();
        // Defensive: if the kb root failed to load (file missing or
        // parse error at boot), fall back to returning the initial
        // value so the caller doesn't deadlock waiting for input we
        // can't accept. Surface in the diag log so it's debuggable.
        if (!root) {
            console.debug('[keyboard-overlay] open() called but kb live root is null — returning initial value');
            return initial;
        }
        const onScroll = callbacks.onScroll;
        const validate = callbacks.validate;
        /** Submit is allowed when no validator is supplied or the
         * validator accepts the current buffer. Gates the Return key
         * action, the `+` gamepad shortcut, and the external
         * `__brewserKeyboardSubmit` hook so all three honor the same
         * rule (mirrors the old canvas kb's spec: a `<input type=number>`
         * with letter junk in the buffer can't be Submitted). */
        const isSubmittable = (v) => !validate || validate(v);
        // Per-session state. Lives in the closure so `__brewserKeyboardHandleTap`
        // and the resolve path see the same value.
        const state = {
            value: initial,
            shift: false,
            caps: false,
        };
        // 2026-06-14 kb-input lag fix: wrap every keyboard-tree mutation
        // (initial sync here, per-tap mutations in handleTap, deferred
        // flash-clear timers) in a `pushKbMutationScope` / `popKbMutationScope`
        // pair so the bumps route to `kbTreeVersion` instead of the
        // shared `liveTreeVersion`. The host page's `liveCacheOffscreen`
        // stays warm across keystrokes; only the small kb cache rebuilds.
        // See `live-paint-control.ts` for the full rationale.
        pushKbMutationScope();
        const urlInput = findUrlInput(root);
        if (urlInput)
            setInputValue(urlInput, state.value);
        // Cache the latch keys + letter-key list once per session so
        // shift / caps toggles + case-rewrite passes don't re-walk the
        // tree on every keypress.
        const capsKey = findActionKey(root, 'caps');
        const shiftKey = findActionKey(root, 'shift');
        const letterKeys = findLetterKeys(root);
        // Sync visual case to the initial state (both flags are false
        // so this lowercases anything that drifted from a prior session
        // — defensive; mutations from a prior session would have been
        // reset when the kb root was re-populated on navigation).
        applyLetterCase(letterKeys, false);
        if (capsKey)
            capsKey.classList.toggle('held', false);
        if (shiftKey)
            shiftKey.classList.toggle('held', false);
        popKbMutationScope();
        setKeyboardOpen(true);
        setKeyboardOverlayVisible(true);
        if (repaintDriver)
            repaintDriver();
        return new Promise((resolve) => {
            let settled = false;
            let running = true;
            const globals = globalThis;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                running = false;
                setKeyboardOpen(false);
                setKeyboardOverlayVisible(false);
                // Sync the mouse forwarder's `prevButtons` to the CURRENT
                // physical button state before the shell loop resumes. The
                // shell's `tickMouseInput` last sampled buttons BEFORE the
                // kb opened, so without this sync, any button held at the
                // moment of close (typically B itself, which the user just
                // pressed to cancel) would appear as a spurious rising
                // edge on the next post-kb tick and dispatch
                // mousedown/contextmenu (or click via `endLivePress` if
                // the held button was A) on whatever sits under the
                // cursor — e.g. an app card → modal opens. See
                // `syncMouseButtonsToCurrent` JSDoc.
                syncMouseButtonsToCurrent();
                // Clear hooks so a stray external caller after close
                // doesn't reach into a stale closure.
                globals.__brewserKeyboardSubmit = undefined;
                globals.__brewserKeyboardCancel = undefined;
                globals.__brewserKeyboardHandleTap = undefined;
                globals.__brewserKeyboardForwardScroll = undefined;
                if (repaintDriver)
                    repaintDriver();
                // Defer the resolve by a macrotask — the same trick the
                // old canvas keyboard used so navigation that runs
                // against the typed value doesn't start INSIDE the
                // touch-event dispatch frame.
                nativeSetTimeout(() => resolve(result), 0);
            };
            const refreshUrlInput = () => {
                if (urlInput)
                    setInputValue(urlInput, state.value);
            };
            const insertChar = (ch) => {
                state.value += ch;
                if (state.shift)
                    state.shift = false;
                refreshUrlInput();
            };
            const backspace = () => {
                if (state.value.length === 0)
                    return;
                state.value = state.value.slice(0, -1);
                refreshUrlInput();
            };
            globals.__brewserKeyboardSubmit = (v) => {
                // Honor the validator gate even when an external caller
                // drives the submit (e.g. a test fixture). Without the
                // gate a number-only input could commit letter junk
                // via the back door.
                if (!isSubmittable(v))
                    return;
                finish(v);
            };
            globals.__brewserKeyboardCancel = () => {
                finish(null);
            };
            // Above-panel swipes forward dy here. Set by the kb-routing
            // branch in `controller-shortcuts.ts` once a kb-swipe session
            // opens (touchstart above topY); the touchmove handler calls
            // this on every move event, and onScroll forwards to the
            // shell's handleScroll. Untouched when no callback is wired
            // — the URL bar / search paths supply one, the live-form
            // input path doesn't (it locks the page during edit).
            globals.__brewserKeyboardForwardScroll = (delta) => {
                if (onScroll && delta !== 0)
                    onScroll(delta);
            };
            /** Briefly flash :active on a key so the user sees the tap
             * register even though there's no real touchstart/touchend
             * dispatch flowing through `live-input-dispatch` for kb
             * keys (we own dispatch directly). 120 ms is short enough
             * not to fight rapid typing but long enough that a single
             * frame paint always lands inside the window.
             *
             * The clear must run even AFTER the session resolves —
             * otherwise a tap that ends the session (Close, Submit) leaves
             * its key permanently `:active`, and since the kb root
             * persists across sessions (rebuilt only on navigation), the
             * stuck highlight reappears on the next open. `setPseudoActive`
             * is safe to call on a since-detached element so the
             * always-fire is harmless when the session has already moved
             * on. */
            const flashKey = (key) => {
                setPseudoActive(key, true);
                // 2026-06-14 kb-input lag fix: the deferred clear runs
                // 120 ms later as its own macrotask — by then any
                // `pushKbMutationScope` from `__brewserKeyboardHandleTap`
                // has already popped, so we re-enter the scope here so
                // the `setPseudoActive(key, false)` bump still routes to
                // `kbTreeVersion` and doesn't dirty the host page cache.
                nativeSetTimeout(() => {
                    pushKbMutationScope();
                    setPseudoActive(key, false);
                    popKbMutationScope();
                }, 120);
            };
            /** Recompute "is this typing upper-case?" and sync the
             * visual case across every letter key + the held state
             * of the shift/caps keys. Called whenever shift or caps
             * changes. */
            const syncCaseAndLatch = () => {
                const upper = state.shift !== state.caps;
                applyLetterCase(letterKeys, upper);
                if (capsKey)
                    capsKey.classList.toggle('held', state.caps);
                if (shiftKey)
                    shiftKey.classList.toggle('held', state.shift);
            };
            globals.__brewserKeyboardHandleTap = (target) => {
                if (!running)
                    return;
                // 2026-06-14 kb-input lag fix: scope ALL kb mutations
                // triggered by this tap so they bump `kbTreeVersion`
                // instead of the shared `liveTreeVersion`. The host
                // page's overlay cache stays warm — without this, on
                // heavy pages (settings.html) every keystroke kicked
                // off a full chunked rebuild of the host cache that
                // blocked the JS thread long enough for the next
                // touchstart to be dropped by Switch's HID poll.
                pushKbMutationScope();
                try {
                    handleTapInner(target);
                }
                finally {
                    popKbMutationScope();
                }
            };
            const handleTapInner = (target) => {
                // Top-row dedicated affordances:
                //   - Close (id=closeBtn): dismiss the kb without
                //     committing — same outcome as the gamepad B button
                //     and the above-panel tap-cancel gesture.
                //   - Clear (id=clearBtn): wipe the current buffer but
                //     keep the kb open so the user can keep typing.
                // Submission still lives on the Return key + gamepad `+`,
                // both validator-gated so a number-only input can't be
                // committed with letter junk.
                let walker = target;
                let topRowBtn = null;
                let topRowBtnId = null;
                while (walker) {
                    const id = walker.getAttribute?.('id');
                    if (id === 'closeBtn' || id === 'clearBtn') {
                        topRowBtn = walker;
                        topRowBtnId = id;
                        break;
                    }
                    walker = walker.parent;
                }
                if (topRowBtn && topRowBtnId === 'closeBtn') {
                    flashKey(topRowBtn);
                    playClick();
                    finish(null);
                    return;
                }
                if (topRowBtn && topRowBtnId === 'clearBtn') {
                    flashKey(topRowBtn);
                    playClick();
                    state.value = '';
                    refreshUrlInput();
                    return;
                }
                const key = findKey(target);
                if (!key)
                    return; // tap on .kb panel bg between keys — ignore
                flashKey(key);
                playClick();
                const action = key.getAttribute('data-action');
                // 2026-06-14 kb-input lag fix: track whether shift was
                // ACTUALLY consumed by this keypress so we only re-sync
                // the visual case + latch state when something changed.
                // Previously `syncCaseAndLatch()` ran on every tap and
                // called `classList.toggle('held', state.caps)` + ditto
                // for shift; the token-list notify fires even when the
                // token state is unchanged, so each unrelated keypress
                // was bumping the tree version twice for nothing.
                const wasShift = state.shift;
                if (action) {
                    switch (action) {
                        case 'backspace':
                            backspace();
                            return;
                        case 'tab':
                            insertChar('\t');
                            break;
                        case 'return':
                            // Same validator gate as `+` / __brewserKeyboardSubmit:
                            // a non-submittable buffer (e.g. letters in a
                            // number-only input) silently swallows the press
                            // so the user can't escape the type constraint
                            // via Return.
                            if (isSubmittable(state.value))
                                finish(state.value);
                            return;
                        case 'left': return; // single-line: no caret nav for now
                        case 'right': return;
                        case 'up': return;
                        case 'caps':
                            state.caps = !state.caps;
                            syncCaseAndLatch();
                            return;
                        case 'shift':
                            state.shift = !state.shift;
                            syncCaseAndLatch();
                            return;
                    }
                    // Insert actions (tab) need the post-insert shift
                    // clear-down — fall through to the same path the
                    // character branch uses.
                }
                else {
                    // Character key. .num keys carry both base + sup; letter
                    // keys carry a single char; data-char keys (space) carry
                    // the explicit insert char.
                    const cls = key.getAttribute('class') ?? '';
                    const isNum = cls.split(/\s+/).includes('num');
                    const isLetter = cls.split(/\s+/).includes('letter');
                    let ch = readKeyChar(key);
                    if (!ch)
                        return;
                    if (isNum && state.shift) {
                        const sup = readKeySup(key);
                        if (sup)
                            ch = sup;
                    }
                    else if (isLetter) {
                        if (state.shift !== state.caps)
                            ch = toUpper(ch);
                    }
                    else if (state.shift) {
                        ch = shiftSymbol(ch);
                    }
                    insertChar(ch);
                }
                // Only re-sync when shift went from on → off (i.e. this
                // keypress consumed the one-shot shift latch). Caps /
                // shift toggles already returned above with their own
                // syncCaseAndLatch call.
                if (wasShift && !state.shift) {
                    syncCaseAndLatch();
                }
            };
            // Internal poll loop. Drives repaints AND samples the
            // gamepad each tick — the shell's main `waitForControllerInput`
            // loop is suspended on this promise so its own A/B/+ polling
            // doesn't fire. Mirrors the old canvas keyboard's pollLoop
            // shape (mouse + touch only; no D-pad nav).
            let prev = readButtons();
            // 2026-06-14 kb-input lag fix: track the host + kb tree
            // versions across ticks so we can skip the per-tick
            // `repaintDriver()` when nothing actually needs repainting.
            // Calling repaintContent on every tick (60×/s) was the
            // dominant CPU cost while the keyboard was open — on heavy
            // host pages it took long enough that Switch's per-frame
            // HID poll missed fast successive taps. We still tick
            // repaintDriver when (a) the kb tree mutated (key flash,
            // urlInput value change, latch toggle), (b) the host tree
            // mutated (page rAF / video / Canvas2D activity), (c) the
            // cursor moved.
            let lastPaintedLiveVersion = getLiveTreeVersion();
            let lastPaintedKbVersion = getKbTreeVersion();
            const tick = () => {
                if (!running)
                    return;
                const next = readButtons();
                // B (rightClick) — cancel. Rising edge so a held B from a
                // prior screen doesn't auto-cancel on first tick.
                if (rising(prev, next, 'b')) {
                    prev = next;
                    finish(null);
                    return;
                }
                // + (Plus) — submit, validator-gated. Swallowed silently
                // when the buffer is unsubmittable so an invalid value
                // the user can't tap-Return can't be Plus-submitted
                // either (matches the same affordance promise the
                // disabled-Submit UI used to give in the canvas era).
                if (rising(prev, next, 'plus')) {
                    if (isSubmittable(state.value)) {
                        prev = next;
                        finish(state.value);
                        return;
                    }
                }
                // A (leftClick) — hit-test cursor position against kb
                // root, dispatch tap on the key under the cursor. Same
                // code path as a touch — handleTap handles the click
                // sound, :active flash, and state mutation.
                if (rising(prev, next, 'a')) {
                    const { x, y } = getCursorPos();
                    // Only act when the cursor lies over the kb panel area;
                    // outside-panel A-presses don't cancel (use B for that)
                    // so a user mousing around above the panel doesn't lose
                    // their typed buffer to a stray A.
                    if (y >= getKeyboardTopY() && globals.__brewserKeyboardHandleTap) {
                        const hit = hitTestKbAt(root, x, y);
                        if (hit)
                            globals.__brewserKeyboardHandleTap(hit);
                    }
                }
                // Right-stick Y → page scroll behind the keyboard. The
                // shell's main-loop scroll handler is suspended on this
                // promise, so we sample here and forward to onScroll.
                let scrolled = false;
                if (onScroll) {
                    const delta = readStickScroll(activePad());
                    if (delta !== 0) {
                        onScroll(delta);
                        scrolled = true;
                    }
                }
                // Keep the software cursor alive while we own the loop —
                // movement-only variant since A is hit-tested above as a
                // keyboard activation, not dispatched as a page click.
                const cursorMoved = tickCursorMovementOnly();
                const liveVer = getLiveTreeVersion();
                const kbVer = getKbTreeVersion();
                const dirty = liveVer !== lastPaintedLiveVersion
                    || kbVer !== lastPaintedKbVersion;
                const needsPaint = dirty || cursorMoved || scrolled;
                if (needsPaint && repaintDriver) {
                    lastPaintedLiveVersion = liveVer;
                    lastPaintedKbVersion = kbVer;
                    repaintDriver();
                }
                prev = next;
                // Drop the delay to 0 when the cursor moved this tick so
                // stick-driven cursor motion doesn't visibly drag (matches
                // the old canvas kb's cadence).
                nativeSetTimeout(tick, cursorMoved ? 0 : 16);
            };
            nativeSetTimeout(tick, 16);
        });
    }
}
/** Module-local hit-test against the kb root. Used by the gamepad A
 * path inside the poll loop. Mirrors the touch path in
 * `controller-shortcuts.ts` (zero out the host scroll so the kb's
 * non-scrolling boxes hit-test correctly), but kept here so the
 * keyboard module owns the gamepad-side dispatch end-to-end. */
function hitTestKbAt(root, x, y) {
    const screen = nxScreen();
    const topY = getKeyboardTopY();
    const viewport = {
        x: 0, y: topY,
        width: screen.width,
        height: Math.max(0, screen.height - topY),
    };
    // Same scroll-zero trick as the touch path — hitTestLive subtracts
    // the host's scroll from non-fixed candidates, but the kb root
    // doesn't scroll. See the checkpoint-3 fix in controller-shortcuts
    // for the longer explanation.
    const saved = getInternalLiveScrollY();
    setInternalLiveScrollY(0);
    try {
        return hitTestLive(root, x, y, viewport);
    }
    finally {
        setInternalLiveScrollY(saved);
    }
}
//# sourceMappingURL=keyboard-overlay.js.map