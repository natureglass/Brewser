/// <reference types="@nx.js/runtime" />
import type { PermissionPolicy } from '../permissions/permission-policy.js';
import { type ResourceLoader, type ResourceRequest } from './resource-loader.js';
export interface LocalResourceLoaderOptions {
    /** Absolute path on the SD card pointing at the app root, e.g. `sdmc:/switch/webapps/default/`. */
    appRoot: string;
    /** Optional permission policy. When set, `allowLocalFile(path)` is consulted before reading. */
    permissionPolicy?: PermissionPolicy;
    /** Override or extend the default extension -> MIME type map. */
    mimeTypes?: Record<string, string>;
}
export declare class LocalResourceLoader implements ResourceLoader {
    readonly appRoot: string;
    private readonly permissionPolicy;
    private readonly mimeTypes;
    constructor(options: LocalResourceLoaderOptions);
    canLoad(request: ResourceRequest): boolean;
    load(request: ResourceRequest): Promise<Response>;
}
//# sourceMappingURL=local-resource-loader.d.ts.map