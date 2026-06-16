/// <reference types="@nx.js/runtime" />
export declare function hasProtocol(url: string): boolean;
export declare function appRootWithTrailingSlash(appRoot: string): string;
/**
 * Resolve a relative or absolute-style path against an app root, refusing any
 * traversal that would escape that root. Throws if traversal escapes.
 */
export declare function resolveAppPath(appRoot: string, path: string): string;
export declare function getRequestUrl(input: string | URL | Request): string;
export declare function isAppRootRelative(url: string): boolean;
//# sourceMappingURL=path-utils.d.ts.map