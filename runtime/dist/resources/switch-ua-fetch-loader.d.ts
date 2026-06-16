/// <reference types="@nx.js/runtime" />
import { type ResourceLoader, type ResourceRequest } from './resource-loader.js';
import type { PermissionPolicy } from '../permissions/permission-policy.js';
export type ColorSchemeTheme = 'light' | 'dark';
export interface SwitchUaFetchLoaderOptions {
    nativeFetch: typeof fetch;
    permissionPolicy?: PermissionPolicy;
    /** User-preferred colour scheme. Surfaced to servers as the
     * `Sec-CH-Prefers-Color-Scheme` client hint so they can serve a
     * matching theme without a client-side flash. */
    colorScheme?: ColorSchemeTheme;
}
export declare class SwitchUaFetchLoader implements ResourceLoader {
    private readonly nativeFetch;
    private readonly permissionPolicy;
    private colorScheme;
    private readonly cookieJar;
    constructor(options: SwitchUaFetchLoaderOptions);
    /** Update the colour-scheme hint sent on subsequent requests. Lets
     * the shell flip themes at runtime without rebuilding the loader. */
    setColorScheme(scheme: ColorSchemeTheme): void;
    /** Drop every cookie collected so far. Wire to a future "clear
     * browsing data" / private-browsing toggle. */
    clearCookies(): void;
    canLoad(request: ResourceRequest): boolean;
    load(request: ResourceRequest): Promise<Response>;
}
//# sourceMappingURL=switch-ua-fetch-loader.d.ts.map