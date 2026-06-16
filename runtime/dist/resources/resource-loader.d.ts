/// <reference types="@nx.js/runtime" />
export interface ResourceRequest {
    url: string;
    init?: RequestInit;
    origin: string;
}
export interface ResourceLoader {
    /** Return true if this loader is willing to handle the given request. */
    canLoad(request: ResourceRequest): boolean;
    /** Resolve the request to a Response. Should not throw for ordinary 404s. */
    load(request: ResourceRequest): Promise<Response>;
}
export declare function notFoundResponse(path: string): Response;
export declare function deniedResponse(path: string, reason?: string): Response;
//# sourceMappingURL=resource-loader.d.ts.map