export function fullscreenRect(width, height) {
    return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
    };
}
export function canvasSize(canvas) {
    return { width: canvas.width, height: canvas.height };
}
//# sourceMappingURL=canvas.js.map