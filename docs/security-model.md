# Security model

`switch-web-browser` runs untrusted web content on top of nx.js homebrew
APIs. The security model is enforced by `BrowserPermissionPolicy`
(`src/permissions/browser-permission-policy.ts`), consulted by the runtime
before any privileged action.

## Origin types

| Origin family                | Examples                                 | Trust level                          |
| ---------------------------- | ---------------------------------------- | ------------------------------------ |
| `browser://`                 | `browser://new-tab/`, `browser://error/` | Built-in. Bundled, signed by us.     |
| `nx-internal://`             | `nx-internal://error/`                   | Reserved for future runtime pages.   |
| `http://`                    | `http://example.test/`                   | Untrusted. Insecure transport.       |
| `https://`                   | `https://example.com/`                   | Untrusted. Secure transport.         |

## Permission matrix

| Capability                         | `browser://` / `nx-internal://` | `http(s)://` |
| ---------------------------------- | ------------------------------- | ------------ |
| `allowLocalFile(path)`             | bundled assets only             | denied       |
| `allowNetworkURL(url)`             | n/a                             | allowed by default (opt-out via `allowNetwork: false` — see below) |
| `allowGamepad()`                   | allowed                         | allowed      |
| `allowTouch()`                     | allowed                         | allowed      |
| `allowWebGL()`                     | allowed                         | allowed      |
| `allowPersistentStorage(origin)`   | allowed                         | allowed per-origin |

### Why network is allowed by default

`WebView` now sniffs the response `Content-Type`. `text/html` /
`application/xhtml+xml` is routed to `WebViewDelegate.onHtmlResponse`
and rendered through the browser's HTML pipeline rather than eval'd as
JS. So a real HTML page from `https://example.com/` no longer crashes
the session — the shell's delegate parses it, lays it out, and paints
it. The Citron emulator separately fails any `http(s)` request at the
TCP socket layer (it doesn't implement `$.connect`); the request never
reaches a remote host. On real hardware the path works end-to-end.

Setting `allowNetwork: false` in the policy turns the gate back off —
`NativeFetchLoader` short-circuits to 403 before the native fetch is
called, and `BrowserNavigation` falls back to `browser://error/`.

Currently `BrowserPermissionPolicy` is uniform across origins because the
shell has no notion of "which origin is currently active" yet. Once the
shell loads real pages through a `WebView`, the policy is recreated per
page load with the active origin baked in, or the policy is given an
"active origin" setter.

### Runtime shims that protect the network path

Two nx.js traps would otherwise leak failures into the user's face — the
runtime shims them so the browser never has to handle them:

- `navigator.userAgent` is shimmed to a static `'@switch-web/runtime'`
  string in `installBrowserShim`. The native getter calls
  `nacpGetLanguageEntry` which throws on Citron (and some real-device
  NACPs). nx.js's `fetchHttp` reads `navigator.userAgent` to set the UA
  header; without the shim, every HTTP request would throw before any
  byte left the JS thread.
- The runtime fetch wrapper is `installRuntimeFetch`-installed per
  app session and restored on session end via `trackAppCleanup`, so
  successive page loads never inherit each other's fetch overrides.

## Privileged APIs

The following Switch / nx.js APIs must never be exposed to `http(s)://`
pages:

- raw filesystem access (`Switch.readFileSync`, `Switch.readDirSync`, etc.)
- `Switch.exit`, `Switch.applet*`
- low-level WebGL extensions that expose host buffers without copy
- gamepad raw-button / device-type readouts (the standard mapping is fine)

The runtime's browser shim already isolates pages from `Switch.*` by not
exposing it on `window`. Browser-side code must also avoid leaking
shell-only helpers (e.g. `BrowserProfile`) into the page's scope.

## Mixed-content / cross-origin

Not modeled yet. The first time real `http(s)` pages render, we need to:

- Block requests from `https://` pages to `http://` resources.
- Apply same-origin for `localStorage`, cookies, and cache lookups.
- Apply CORS to `fetch()` from page JS (the runtime's
  `installRuntimeFetch` is page-scope today; for the browser it has to
  observe the page's origin, not the shell's).

These are explicit non-goals for the minimal scaffold and are tracked in
`docs/browser-architecture.md`.

## Status

The shell loads `browser://` JS bundle pages, in-process HTML fixtures
served as `text/html`, and (on real hardware) live `http(s)` HTML. The
HTML pipeline does not run any JS from rendered pages (`<script>` is
stripped at parse time), so the practical security surface for HTML
content is the parser/layout/paint code in `src/html/*` plus
`@switch-web/runtime` and the nx.js native layer underneath.
