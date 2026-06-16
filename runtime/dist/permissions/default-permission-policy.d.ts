import type { PermissionPolicy } from './permission-policy.js';
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
export declare class DefaultPermissionPolicy implements PermissionPolicy {
    allowLocalFile(_path: string): boolean;
    allowNetworkURL(_url: string): boolean;
    allowGamepad(): boolean;
    allowTouch(): boolean;
    allowWebGL(): boolean;
    allowPersistentStorage(_origin: string): boolean;
}
//# sourceMappingURL=default-permission-policy.d.ts.map