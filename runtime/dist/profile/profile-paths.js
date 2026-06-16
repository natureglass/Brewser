import { DEFAULT_PROFILE_ROOT } from '../browser-config.js';
export { DEFAULT_PROFILE_ROOT };
export function storagePathForOrigin(origin, profileRoot = DEFAULT_PROFILE_ROOT) {
    const safe = origin.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    const base = profileRoot.endsWith('/') ? profileRoot : `${profileRoot}/`;
    return `${base}${safe || 'unknown'}/`;
}
//# sourceMappingURL=profile-paths.js.map