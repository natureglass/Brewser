export function hasProtocol(url) {
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url);
}
export function appRootWithTrailingSlash(appRoot) {
    return appRoot.endsWith('/') ? appRoot : `${appRoot}/`;
}
/**
 * Resolve a relative or absolute-style path against an app root, refusing any
 * traversal that would escape that root. Throws if traversal escapes.
 */
export function resolveAppPath(appRoot, path) {
    const withoutFragment = path.split('#', 1)[0];
    const withoutQuery = withoutFragment.split('?', 1)[0];
    const cleanPath = withoutQuery.replaceAll('\\', '/');
    if (hasProtocol(cleanPath)) {
        return cleanPath;
    }
    const parts = [];
    for (const part of cleanPath.replace(/^\/+/, '').split('/')) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            if (parts.length === 0) {
                throw new Error(`Path escapes app root: ${path}`);
            }
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return `${appRootWithTrailingSlash(appRoot)}${parts.join('/')}`;
}
export function getRequestUrl(input) {
    if (typeof input === 'string') {
        return input;
    }
    return input instanceof Request ? input.url : input.toString();
}
export function isAppRootRelative(url) {
    return !hasProtocol(url) || url.startsWith('/');
}
//# sourceMappingURL=path-utils.js.map