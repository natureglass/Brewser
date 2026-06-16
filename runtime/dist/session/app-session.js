let appSessionActive = false;
let cleanups = [];
export function beginAppSession() {
    endAppSession();
    appSessionActive = true;
}
export function endAppSession() {
    appSessionActive = false;
    const pending = cleanups;
    cleanups = [];
    for (let i = pending.length - 1; i >= 0; i--) {
        try {
            pending[i]();
        }
        catch (error) {
            console.debug(`[switch-web/runtime] app cleanup failed: ${error}`);
        }
    }
}
export function trackAppCleanup(cleanup) {
    if (appSessionActive) {
        cleanups.push(cleanup);
    }
}
export function isAppSessionActive() {
    return appSessionActive;
}
//# sourceMappingURL=app-session.js.map