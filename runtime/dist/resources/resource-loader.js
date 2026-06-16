export function notFoundResponse(path) {
    return new Response(`Not found: ${path}`, {
        status: 404,
        statusText: 'Not Found',
        headers: {
            'content-type': 'text/plain; charset=utf-8',
        },
    });
}
export function deniedResponse(path, reason = 'Access denied') {
    return new Response(`${reason}: ${path}`, {
        status: 403,
        statusText: 'Forbidden',
        headers: {
            'content-type': 'text/plain; charset=utf-8',
        },
    });
}
//# sourceMappingURL=resource-loader.js.map