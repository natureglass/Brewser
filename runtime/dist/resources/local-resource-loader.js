import { contentTypeFor, DEFAULT_MIME_TYPES } from './mime-types.js';
import { isAppRootRelative, resolveAppPath } from './path-utils.js';
import { deniedResponse, notFoundResponse, } from './resource-loader.js';
export class LocalResourceLoader {
    appRoot;
    permissionPolicy;
    mimeTypes;
    constructor(options) {
        this.appRoot = options.appRoot;
        this.permissionPolicy = options.permissionPolicy;
        this.mimeTypes = options.mimeTypes ?? DEFAULT_MIME_TYPES;
    }
    canLoad(request) {
        return isAppRootRelative(request.url);
    }
    async load(request) {
        let resolvedPath;
        try {
            resolvedPath = resolveAppPath(this.appRoot, request.url);
        }
        catch (error) {
            console.debug(`[switch-web/runtime] local fetch path error: ${error}`);
            return notFoundResponse(request.url);
        }
        if (this.permissionPolicy && !this.permissionPolicy.allowLocalFile(resolvedPath)) {
            console.debug(`[switch-web/runtime] local fetch denied: ${resolvedPath}`);
            return deniedResponse(resolvedPath);
        }
        const buffer = Switch.readFileSync(resolvedPath);
        if (buffer === null) {
            console.debug(`[switch-web/runtime] local fetch 404: ${resolvedPath}`);
            return notFoundResponse(resolvedPath);
        }
        return new Response(buffer, {
            status: 200,
            headers: {
                'content-type': contentTypeFor(resolvedPath, this.mimeTypes),
                'x-switch-app-root': this.appRoot,
            },
        });
    }
}
//# sourceMappingURL=local-resource-loader.js.map