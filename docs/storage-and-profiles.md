# Storage and profiles

`BrowserProfile` (`src/profile/browser-profile.ts`) is the per-user
container that scopes cookies, local-storage, cache, history, and
bookmarks to one storage root on the SD card.

## Status

`BrowserProfile` is constructed at shell startup and creates its root
directory under `sdmc:/switch/webprofiles/default/` on first launch.
`HistoryStore` is wired and persists user-initiated navigations to
`history.jsonl` (append-only, dedupe + 100-entry cap). The new-tab
page fetches `browser://history/` (served as JSON by
`BrowserHistoryLoader`) and renders the most recent entries as "Recent".

The other stores below are still stubs.

## Profile root

Configured in `src/browser-config.ts`:

```ts
export const DEFAULT_PROFILE_ROOT = 'sdmc:/switch/webprofiles/';
```

Per-profile data lives under `<DEFAULT_PROFILE_ROOT><profile-name>/`. The
default profile is `default`, so paths look like:

```text
sdmc:/switch/webprofiles/default/
  pages/
    welcome.html
    about.html
    html-experiments/
      ...
  assets/
    home.png
    ...
  Templates/
    default.json
    ...
  example.com/
    cookies.json
    local-storage.json
    cache/
      <hash>.bin
  history.jsonl
  bookmarks.json
  config.json
  templates.json
```

`browser://X/Y/` URLs map to `pages/X/Y.html` inside the profile
root — see `BrowserProfile.pagePath` and `BrowserResourceLoader`.
Seeded once from `romfs:/pages/` on first launch; the seeder never
overwrites, so edits persist and deleting a file restores the
default next launch.

Per-origin paths use the runtime's `storagePathForOrigin(origin, profileRoot)`
helper, which sanitizes the origin into a filesystem-safe segment.

## Stores

- `HistoryStore` — **live**. Append-only `history.jsonl` at the profile
  root. User-initiated navigations record on success; `browser://new-tab/`
  and `browser://error/` are excluded so they never clutter "Recent".
- `CookieStore` — stub. Planned: RFC 6265-ish cookie jar, persisted JSONL
  per origin.
- `LocalStorageStore` — stub. Planned: per-origin key/value, persisted
  JSON per origin.
- `CacheStore` — stub. Planned: HTTP cache, persisted as `<hash>.bin`
  + index.
- `BookmarksStore` — stub. Planned: single `bookmarks.json` at the
  profile root with a `browser://bookmarks/` JSON loader and UI page.

Each store is constructed from a `BrowserProfile` reference so that
profile-switch and profile-wipe are atomic at the profile boundary.

## Permission integration

`BrowserPermissionPolicy.allowPersistentStorage(origin)` gates storage on
a per-origin basis. The current policy returns `true` for everything; once
real storage exists, "private browsing" or per-origin opt-out can flip
this to `false`.

`BrowserPermissionPolicy.allowLocalFile(_path)` is currently always
`false`. Web pages from `http(s)` origins must never reach the SD card
directly; only the browser's own `BrowserResourceLoader` may resolve paths
inside `assets/default-pages/`.
