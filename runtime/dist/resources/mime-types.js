export const DEFAULT_MIME_TYPES = {
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.rgba': 'application/octet-stream',
    '.raw': 'application/octet-stream',
    '.txt': 'text/plain',
};
export function contentTypeFor(path, table = DEFAULT_MIME_TYPES) {
    const dotIndex = path.lastIndexOf('.');
    if (dotIndex === -1) {
        return 'application/octet-stream';
    }
    const extension = path.slice(dotIndex).toLowerCase();
    return table[extension] || 'application/octet-stream';
}
//# sourceMappingURL=mime-types.js.map