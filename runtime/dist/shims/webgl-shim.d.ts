import type { NxScreenCanvas } from '../graphics/screen.js';
type NativeGetContext = (contextId: string, ...args: unknown[]) => unknown;
type WebGLContextRequest = {
    canvas: NxScreenCanvas;
    contextId: string;
    attributes: unknown[];
    nativeGetContext: NativeGetContext;
};
export declare function isWebGLContextId(contextId: string): boolean;
export declare function getWebGLContext(request: WebGLContextRequest): unknown;
export declare function resetWebGLContext(): void;
export {};
//# sourceMappingURL=webgl-shim.d.ts.map