/**
 * Safe-console redirect — neutralize the text-render-mode flip.
 *
 * nx.js's `console.log` / `.info` / `.warn` / `.error` all call
 * `$.print`, which flips the runtime from canvas-render mode into
 * text-render mode and overwrites whatever was on the visible canvas
 * with the formatted text. Only `console.debug` (and `console.printErr`)
 * route through `$.printErr` — the safe path that writes to the debug
 * log file without touching the framebuffer.
 *
 * Engine code obeys this rule (see `feedback_console_error_switches_render_mode.md`).
 * But page scripts — particularly engine bundles like Cocos Creator that
 * call `console.log('LoadScene db://… took N ms')` from module bodies
 * loaded via SystemJS / indirect-eval — access the GLOBAL `console`
 * object, not the per-script `consoleShim` parameter that
 * `canvas-runner` threads through inline `<script>` invocations. Those
 * calls reach the unsafe path, the canvas freezes / fills with text,
 * and any `copyBridgeToScreen` work the overlay does is immediately
 * overwritten the next time the runtime presents.
 *
 * Fix: capture the original `console.debug` once at swb startup, then
 * overwrite the four unsafe methods so they forward through it. Engine
 * code is unaffected (it already uses `.debug`); page code stops being
 * able to flip the canvas no matter how deeply embedded the call site.
 *
 * Installed before `shell.run()` so the first page nav (and any boot-
 * time eager initialization a page might do) is already protected.
 */
export function installSafeConsoleRedirect() {
    const c = console;
    const origDebug = c.debug.bind(c);
    const route = (...args) => origDebug(...args);
    c.log = route;
    c.info = route;
    c.warn = route;
    c.error = route;
}
//# sourceMappingURL=safe-console.js.map