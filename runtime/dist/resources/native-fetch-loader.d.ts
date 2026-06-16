/// <reference types="@nx.js/runtime" />
import type { PermissionPolicy } from '../permissions/permission-policy.js';
import { type ResourceLoader, type ResourceRequest } from './resource-loader.js';
export interface NativeFetchLoaderOptions {
    /**
     * The underlying network fetch (typically the original `globalThis.fetch`
     * captured before any local override is installed).
     */
    nativeFetch: typeof fetch;
    /** Optional permission policy. When set, `allowNetworkURL(url)` is consulted. */
    permissionPolicy?: PermissionPolicy;
}
export declare class NativeFetchLoader implements ResourceLoader {
    private readonly nativeFetch;
    private readonly permissionPolicy;
    constructor(options: NativeFetchLoaderOptions);
    canLoad(request: ResourceRequest): boolean;
    load(request: ResourceRequest): Promise<Response>;
}
//# sourceMappingURL=native-fetch-loader.d.ts.map