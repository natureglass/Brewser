# Storage and profiles

`BrowserProfile` (`src/profile/browser-profile.ts`) owns two related
roots: an **app-level root** (`appRoot`) that holds data shared across
profiles (config, templates, logs, history, bookmarks), and a
**per-profile root** (`storageRoot`) that holds profile-scoped data
(pages, assets, future per-origin cookies/local-storage/cache).

## Status

`BrowserProfile` is constructed at shell startup and creates its app
+ profile dir trees if missing. `HistoryStore` is wired and persists
user-initiated navigations to `history.jsonl` (append-only, dedupe +
100-entry cap) at the app-level root. The new-tab page fetches
`brewser://history/` (served as JSON by `BrowserHistoryLoader`) and
renders the most recent entries as "Recent".

The other stores below are still stubs.

## Roots

Configured in `src/browser-config.ts`:

```ts
export const BREWSER_APP_ROOT   = 'sdmc:/switch/brewser/';
export const DEFAULT_PROFILE_ROOT = 'sdmc:/switch/brewser/webprofiles/';
```

The default profile is `default`, so storage paths look like:

```text
sdmc:/switch/brewser/                        ← appRoot
  config.json
  templates.json
  apps.json
  search_engines.json
  bookmarks.json
  history.jsonl
  templates/
    default.json
    ...
  logs/
    nxjs-debug.log
    shell-nav-diag.log
    ...
  screenshots/
    screenshot_<timestamp>.png
  apps/                                      ← app catalog (shared)
    mediaplayer/
    ThreeJSDemos/                            ← hoisted from per-profile 2026-06-02
    TikTok/
    twitch/
    sensors/
    speedtest/
    itchio/
  dev/                                       ← test fixtures + Khronos corpora (hoisted from per-profile 2026-06-02)
    home.html-style page-test fixtures (two.html, css.html, …)
    full-webgl1-conformance/
    full-webgl2-conformance/
    nxjs-webgl-demo/
    nxjs-webgl2-demo/
  webprofiles/
    default/                                 ← storageRoot (flat)
      home.html                              ← renamed from welcome.html 2026-06-02
      about.html
      apps.html
      assets/
        home.png
        google_logo.png
        ...
      example.com/                           ← per-origin (stub)
        cookies.json
        local-storage.json
        cache/
          <hash>.bin
```

`brewser://X/Y/` URLs map to `<storageRoot>X/Y.html` (no `pages/` prefix
— the dir was hoisted out on 2026-06-02) — see `BrowserProfile.pagePath`
and `BrowserResourceLoader.resolveContentPath`. Two exceptions route to
`<appRoot>` instead of `<storageRoot>`: URLs that begin with `apps/`
(the app catalog, shared across profiles) and URLs that begin with
`dev/` (the test-fixture tree, also shared, hoisted out of the per-
profile `html-experiments/` dir 2026-06-02). The romfs source tree
keeps a `pages/` grouping for the per-profile pages and a top-level
`apps/` / `dev/` grouping for the app-level surfaces; the seeders write
flat into the appropriate root. None overwrite, so edits persist and
deleting a file restores the default next launch.

Config/template files at the app-level are seeded the same way from
`romfs:/config.json`, `romfs:/templates.json`, etc.

Per-origin paths use the runtime's `storagePathForOrigin(origin, storageRoot)`
helper, which sanitizes the origin into a filesystem-safe segment.

## Stores

- `HistoryStore` — **live**. Append-only `history.jsonl` at the app
  root. User-initiated navigations record on success; `brewser://new-tab/`
  and `brewser://error/` are excluded so they never clutter "Recent".
- `CookieStore` — stub. Planned: RFC 6265-ish cookie jar, persisted JSONL
  per origin under `storageRoot`.
- `LocalStorageStore` — stub. Planned: per-origin key/value, persisted
  JSON per origin under `storageRoot`.
- `CacheStore` — stub. Planned: HTTP cache, persisted as `<hash>.bin`
  + index under `storageRoot`.
- `BookmarksStore` — **live**. Single `bookmarks.json` at the app root,
  rewritten synchronously on every mutation. The toolbar ★ button
  toggles the active page; the bookmarks UI page lives at
  `brewser://bookmarks/` (served as HTML by `BrowserResourceLoader`,
  uses the `<browser-bookmarks>` custom tag for the list). A
  `brewser://bookmarks.json` JSON loader serves the same data for
  scripted consumers.

Each store is constructed from a `BrowserProfile` reference so that
profile-switch and profile-wipe are atomic at the appropriate boundary
(the app-level stores follow the user across profiles; the per-origin
stores live and die with the profile).

## Permission integration

`BrowserPermissionPolicy.allowPersistentStorage(origin)` gates storage on
a per-origin basis. The current policy returns `true` for everything; once
real storage exists, "private browsing" or per-origin opt-out can flip
this to `false`.

`BrowserPermissionPolicy.allowLocalFile(_path)` is currently always
`false`. Web pages from `http(s)` origins must never reach the SD card
directly; only the browser's own `BrowserResourceLoader` may resolve paths
inside `assets/default-pages/`.
