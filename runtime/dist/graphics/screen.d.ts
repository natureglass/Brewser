/// <reference types="@nx.js/runtime" />
export type NxScreenCanvas = EventTarget & {
    width: number;
    height: number;
    getContext(contextId: '2d'): CanvasRenderingContext2D;
    getContext(contextId: string, ...args: unknown[]): unknown;
    addEventListener(type: 'touchstart' | 'touchmove' | 'touchend', listener: (event: TouchEvent) => void, options?: boolean | AddEventListenerOptions): void;
    setCursorOverlay(x: number, y: number, rgba: ArrayBuffer | ArrayBufferView, w: number, h: number): void;
    setCursorOverlayPosition(x: number, y: number): void;
    clearCursorOverlay(): void;
};
export declare function nxScreen(): NxScreenCanvas;
//# sourceMappingURL=screen.d.ts.map