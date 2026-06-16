/**
 * Minimal history-stack navigation primitive. The player only needs the
 * current URL accessor, but brewser will use back/forward and
 * reload, so the API is defined here once.
 */
export declare class NavigationController {
    private history;
    private index;
    get currentURL(): string | null;
    get canGoBack(): boolean;
    get canGoForward(): boolean;
    navigate(url: string): void;
    reload(): string | null;
    goBack(): string | null;
    goForward(): string | null;
    clear(): void;
}
//# sourceMappingURL=navigation-controller.d.ts.map