export interface PermissionPolicy {
    /** Allow reading a resolved local file path. */
    allowLocalFile(path: string): boolean;
    /** Allow fetching a fully-qualified network URL. */
    allowNetworkURL(url: string): boolean;
    /** Allow exposing the gamepad shim to the running app. */
    allowGamepad(): boolean;
    /** Allow forwarding touch events to the running app. */
    allowTouch(): boolean;
    /** Allow `canvas.getContext("webgl")` and `experimental-webgl`. */
    allowWebGL(): boolean;
    /** Optionally allow persistent storage scoped to the given origin. */
    allowPersistentStorage?(origin: string): boolean;
}
//# sourceMappingURL=permission-policy.d.ts.map