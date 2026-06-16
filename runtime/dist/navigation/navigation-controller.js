/**
 * Minimal history-stack navigation primitive. The player only needs the
 * current URL accessor, but brewser will use back/forward and
 * reload, so the API is defined here once.
 */
export class NavigationController {
    history = [];
    index = -1;
    get currentURL() {
        return this.index >= 0 ? this.history[this.index] : null;
    }
    get canGoBack() {
        return this.index > 0;
    }
    get canGoForward() {
        return this.index >= 0 && this.index < this.history.length - 1;
    }
    navigate(url) {
        if (this.index < this.history.length - 1) {
            this.history = this.history.slice(0, this.index + 1);
        }
        this.history.push(url);
        this.index = this.history.length - 1;
    }
    reload() {
        return this.currentURL;
    }
    goBack() {
        if (!this.canGoBack) {
            return null;
        }
        this.index -= 1;
        return this.currentURL;
    }
    goForward() {
        if (!this.canGoForward) {
            return null;
        }
        this.index += 1;
        return this.currentURL;
    }
    clear() {
        this.history = [];
        this.index = -1;
    }
}
//# sourceMappingURL=navigation-controller.js.map