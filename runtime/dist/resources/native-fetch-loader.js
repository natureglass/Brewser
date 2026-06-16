import { hasProtocol } from './path-utils.js';
import { deniedResponse, } from './resource-loader.js';
export class NativeFetchLoader {
    nativeFetch;
    permissionPolicy;
    constructor(options) {
        this.nativeFetch = options.nativeFetch;
        this.permissionPolicy = options.permissionPolicy;
    }
    canLoad(request) {
        return hasProtocol(request.url) && !request.url.startsWith('/');
    }
    async load(request) {
        if (this.permissionPolicy && !this.permissionPolicy.allowNetworkURL(request.url)) {
            console.debug(`[switch-web/runtime] network fetch denied: ${request.url}`);
            return deniedResponse(request.url, 'Network access denied');
        }
        return this.nativeFetch(request.url, request.init);
    }
}
//# sourceMappingURL=native-fetch-loader.js.map