/**
 * Profile-like surface the runtime's storage drivers consult to decide
 * on-disk paths. Lets `installLocalStorage` + `installIndexedDB` stay
 * agnostic to the brewser shell's concrete `BrowserProfile` class — the
 * shell injects an implementation, and runtime code talks to the
 * interface.
 *
 * Phase 4 reason for existing: the storage modules previously hard-coded
 * a `url.startsWith('brewser://dev/')` check to decide between the
 * `default` and `dev` on-disk namespaces. That tied runtime storage to
 * a shell-side URL convention. The picker lives on the profile now, so
 * embedding consumers (test harness, future non-brewser apps) can pick
 * any namespacing scheme they want without editing runtime code.
 */
export interface StorageProfileLike {
    /** Profile root on disk, with trailing slash. Storage paths are
     * built as `<storageRoot>localStorage/...` for the `default`
     * namespace, `<storageRoot><ns>/localStorage/...` for any other
     * namespace. */
    readonly storageRoot: string;
    /** Map a page URL to a namespace label. Return `'default'` (or
     * empty string — the storage driver treats both as the default) for
     * the production namespace; return any other label (e.g. `'dev'`,
     * `'sandbox'`, …) to route writes into a sub-directory under the
     * profile root. */
    pickStorageNamespace(currentUrl: string): string;
}
/** Options accepted by `installLocalStorage` / `installIndexedDB`.
 * Both are optional so embedding consumers without a shell can call
 * `installXxx()` and get sensible single-namespace defaults. */
export interface StorageInstallOptions {
    /** Profile that supplies the on-disk root + namespace picker. When
     * omitted, storage falls back to the {@link DEFAULT_STORAGE_PROFILE}
     * (everything goes under `default/` at the brewser root). */
    profile?: StorageProfileLike;
    /** Read the active page URL on each access. The result is passed
     * to `profile.pickStorageNamespace`. When omitted, the picker
     * receives `''` — which the default profile maps to `'default'`. */
    getCurrentUrl?: () => string;
}
/** Single-namespace fallback profile. Used when no shell wires up
 * `installXxx`; everything writes to `<DEFAULT_PROFILE_ROOT>localStorage/`
 * / `<DEFAULT_PROFILE_ROOT>indexedDB/`. */
export declare const DEFAULT_STORAGE_PROFILE: StorageProfileLike;
//# sourceMappingURL=storage-profile.d.ts.map