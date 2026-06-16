/**
 * Tier-1 Web Storage API (`localStorage`) for brewser.
 *
 * The nx.js runtime ships its own `localStorage` lazy getter at
 * `globalThis.localStorage`, but it (a) returns `undefined` when the
 * app's NACP `userAccountSaveDataSize` is 0 (swb's is), and (b) ties
 * persistence to Switch per-user save data — wrong granularity for a
 * web browser that needs per-page-origin storage.
 *
 * This module redefines `globalThis.localStorage` BEFORE any page
 * script runs, backed by a single JSON file under
 * `<profile.storageRoot>localStorage/default.json` for the `default`
 * namespace, `<profile.storageRoot><ns>/localStorage/default.json`
 * for any other namespace (e.g. `dev`). The active namespace is picked
 * by `profile.pickStorageNamespace(currentUrl)` on every access — the
 * shell typically routes `brewser://dev/...` to the `dev` namespace
 * to keep test artifacts out of real user storage, but the runtime
 * stays agnostic. Reloads on namespace change so reads always see the
 * file for the active page's namespace.
 *
 * Tier-1 limitation: ALL pages share one namespace per profile. itch.io
 * games can collide with each other's save data. Tier-2 work would
 * partition by page origin (extract from current URL on each access)
 * and write to `localStorage/<origin-slug>.json`. Adequate for verifying
 * the api-probe + unblocking simple game persistence today.
 */
import { type StorageInstallOptions } from '../profile/storage-profile.js';
/**
 * Define `globalThis.localStorage` as a Proxy-wrapped file-backed
 * Storage. Call once at app startup BEFORE any page script reads
 * `localStorage`. The runtime's own lazy getter is `configurable:true`,
 * so this override replaces it cleanly.
 *
 * `opts.profile` injects the on-disk root + namespace picker. Pass the
 * shell's `BrowserProfile` (which implements {@link StorageProfileLike})
 * to get `brewser://dev/...` writes sandboxed to a `dev/` subdir.
 * Omitting the profile leaves storage on the single-namespace
 * {@link DEFAULT_STORAGE_PROFILE}.
 *
 * `opts.getCurrentUrl` reads the active page URL on each storage
 * access so the namespace can change when navigation crosses
 * production / dev pages. Pass `BrowserShell.getCurrentPageUrl.bind(shell)`
 * (or an arrow wrapping it). Without it, the picker receives `''` —
 * which the default picker maps to `'default'`.
 */
export declare function installLocalStorage(opts?: StorageInstallOptions): void;
//# sourceMappingURL=local-storage.d.ts.map