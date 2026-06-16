import type { NxScreenCanvas } from './screen.js';
export interface CanvasRect {
    x: number;
    y: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}
export declare function fullscreenRect(width: number, height: number): CanvasRect;
export declare function canvasSize(canvas: NxScreenCanvas): {
    width: number;
    height: number;
};
//# sourceMappingURL=canvas.d.ts.map