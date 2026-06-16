export const RUNTIME_CONFIG_DEFAULTS = {
    telemetry: 'https://brewser.tech/index.php?rest_route=/telemetry/v1/log',
    artifacts: 'https://api.github.com/repos/natureglass/Brewser-apps/contents/artifacts',
    catalogue: 'https://raw.githubusercontent.com/natureglass/Brewser-apps/refs/heads/main/catalogue.json',
    downloads: 'https://raw.githubusercontent.com/natureglass/Brewser-telemetry/refs/heads/main/downloads.json',
    ratings: 'https://raw.githubusercontent.com/natureglass/Brewser-telemetry/refs/heads/main/ratings.json',
    githubOAuthClientId: 'Ov23lizDNGLaaj0OhrGZ',
    googleOAuthClientId: '549999047870-6rahojjhe0ppm42te9uggecbkv3qg3sl.apps.googleusercontent.com',
    twitchOAuthClientId: '',
    microsoftOAuthClientId: '',
};
/** Keys whose user-config value is ignored entirely — the consumer
 * reads the corresponding `RUNTIME_CONFIG_DEFAULTS` field instead.
 * Shared with `saveSettings` so it can strip these keys before writing
 * (otherwise the runtime value gets baked into user config on every
 * save, freezing the bundled URL at whatever was current when the
 * user last clicked Save). */
export const STRICT_PINNED_RUNTIME_KEYS = [
    'telemetry',
    'artifacts',
    'catalogue',
    'downloads',
    'ratings',
];
//# sourceMappingURL=runtime-defaults.js.map