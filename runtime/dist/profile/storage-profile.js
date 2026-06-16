import { DEFAULT_PROFILE_ROOT } from '../browser-config.js';
/** Single-namespace fallback profile. Used when no shell wires up
 * `installXxx`; everything writes to `<DEFAULT_PROFILE_ROOT>localStorage/`
 * / `<DEFAULT_PROFILE_ROOT>indexedDB/`. */
export const DEFAULT_STORAGE_PROFILE = {
    storageRoot: DEFAULT_PROFILE_ROOT,
    pickStorageNamespace: () => 'default',
};
//# sourceMappingURL=storage-profile.js.map