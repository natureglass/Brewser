import type { NxScreenCanvas } from '../graphics/screen.js';
export interface BrowserShimOptions {
    canvas: NxScreenCanvas;
    width: number;
    height: number;
}
export declare function installBrowserShim({ canvas, width, height }: BrowserShimOptions): void;
//# sourceMappingURL=browser-shim.d.ts.map