/**
 * Bundled runtime configuration defaults — values that ship inside the
 * compiled nx.js bundle (and from there into the NRO binary) rather
 * than the user-editable `<profile>/configs/config.json`.
 *
 * Two policies, applied at the consumer side (brewser's
 * `profile/browser-toolbar.ts loadConfig`):
 *
 *   - **Strict-pinned** fields (`telemetry`, `artifacts`, `catalogue`,
 *     `downloads`, `ratings`): the runtime value is authoritative; user
 *     config is IGNORED for these keys. The on-disk `config.json` may
 *     still carry them from an older seeded copy, but `loadConfig` no
 *     longer reads them and `saveSettings` strips them on write.
 *
 *   - **Override-allowed** fields (the four `*OAuthClientId`s): the
 *     runtime value is a fallback. A non-empty value in user config
 *     wins; an empty or missing value falls back to the value here.
 *     Lets users bring-their-own OAuth app without rebuilding the NRO.
 *
 * Why bundle: the strict-pinned URLs drive what the catalog refresh
 * fetches and where the rating-POST telemetry endpoint lives. A
 * tampered `config.json` on SDMC could otherwise silently redirect
 * either path; baking the values into the runtime means an attacker
 * has to ship a whole replacement NRO instead of editing one JSON
 * file. OAuth client IDs are shipped here for DX (a fresh install has
 * working sign-in without provisioning each provider per developer);
 * they're public identifiers per RFC 8628 anyway, so hiding them
 * isn't the goal.
 */
export interface RuntimeConfigDefaults {
    /** Endpoint the per-app rating POST lands on. Read page-side by
     * `missing-app-modal.js` via the `<body data-telemetry-url>` stamp
     * (so the page doesn't have to fetch `configs/config.json` to find
     * it). Strict-pinned. */
    telemetry: string;
    /** GitHub Contents API endpoint listing per-app artifact manifests.
     * Strict-pinned. */
    artifacts: string;
    /** Remote URL of `catalogue.json` (apps grid source of truth).
     * Drives the apps.html "Check for Updates" button. Strict-pinned. */
    catalogue: string;
    /** Remote URL of `downloads.json` (per-app install counters).
     * Refreshed alongside the catalog. Strict-pinned. */
    downloads: string;
    /** Remote URL of `ratings.json` (per-app rating averages).
     * Refreshed alongside the catalog. Strict-pinned. */
    ratings: string;
    /** GitHub OAuth App client ID for the Device Authorization Grant.
     * Override-allowed. */
    githubOAuthClientId: string;
    /** Google OAuth client ID for the Limited Input Device flow.
     * Override-allowed. */
    googleOAuthClientId: string;
    /** Twitch OAuth application client ID. Override-allowed. */
    twitchOAuthClientId: string;
    /** Microsoft Entra application (client) ID. Override-allowed. */
    microsoftOAuthClientId: string;
}
export declare const RUNTIME_CONFIG_DEFAULTS: RuntimeConfigDefaults;
/** Keys whose user-config value is ignored entirely — the consumer
 * reads the corresponding `RUNTIME_CONFIG_DEFAULTS` field instead.
 * Shared with `saveSettings` so it can strip these keys before writing
 * (otherwise the runtime value gets baked into user config on every
 * save, freezing the bundled URL at whatever was current when the
 * user last clicked Save). */
export declare const STRICT_PINNED_RUNTIME_KEYS: readonly ["telemetry", "artifacts", "catalogue", "downloads", "ratings"];
export type StrictPinnedRuntimeKey = typeof STRICT_PINNED_RUNTIME_KEYS[number];
//# sourceMappingURL=runtime-defaults.d.ts.map