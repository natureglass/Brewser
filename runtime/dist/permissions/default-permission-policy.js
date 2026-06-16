/**
 * Conservative default policy.
 *
 * - local file access: denied
 * - network access: denied
 * - gamepad: allowed
 * - touch: allowed
 * - WebGL: allowed
 * - persistent storage: denied unless explicitly enabled by a subclass / wrapper
 */
export class DefaultPermissionPolicy {
    allowLocalFile(_path) {
        return false;
    }
    allowNetworkURL(_url) {
        return false;
    }
    allowGamepad() {
        return true;
    }
    allowTouch() {
        return true;
    }
    allowWebGL() {
        return true;
    }
    allowPersistentStorage(_origin) {
        return false;
    }
}
//# sourceMappingURL=default-permission-policy.js.map