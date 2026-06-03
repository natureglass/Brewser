# switch-web-browser

Future browser shell for Nintendo Switch homebrew. Built on top of
[`@switch-web/runtime`](../switch-web-runtime).

> **Status: scaffold + `brewser://` pipeline + soft-keyboard address bar.**
> Launching the NRO routes through
> `WebView.load({ url: "brewser://new-tab/" })`, which runs the request
> through the runtime fetch wrapper, hits `BrowserResourceLoader`, and
> executes the returned JS body inside an app session. A chrome strip
> at the top of the canvas shows the current URL.
>
> **Controls (shell):**
> - **ZR** (single press) or **tap the URL bar** — open the on-canvas
>   keyboard.
> - **B** — back. **X** — forward. **Y** — reload. (No-op when there's
>   nothing in that direction.)
> - **L + R + Minus** held ~1s — exit the shell. Same combo as the player.
>
> **Controls (while keyboard is open):**
> - D-pad / left stick moves focus, **A** activates the focused key,
>   **Y** backspaces, **B** cancels, **+** submits. Touch the keys to tap
>   them.
>
> The keyboard is rendered entirely inside the app's 1280×720 canvas
> (bottom half, fully bounded) — the native `navigator.virtualKeyboard`
> applet is **not** used, because Citron can't reliably render the OS-side
> swkbd overlay and its geometry isn't controllable from JS.
>
> Bare hosts (e.g. `example.com`) are normalized to `https://example.com/`.
> Network access (`http(s)://`) is **denied by default** in
> `BrowserPermissionPolicy` — the runtime would evaluate the fetched body
> as JS and crash, and on Citron the OS-level fetch attempt hangs the
> shell entirely. With the deny in place, network URLs short-circuit to a
> 403 and the shell falls back to `brewser://error/`. Pass
> `{ allowNetwork: true }` to the policy once an HTML rendering path
> exists (growth step 5). No tabs, bookmarks, or persistent history yet.

## Build

```powershell
cd D:\Workspace\switch-web-browser
npm install
npm run build         # esbuild emits romfs/main.js
npm run nro           # @nx.js/nro packages romfs + nacp into switch-web-browser.nro
npm run typecheck     # optional, uses sibling runtime's tsc
```

`npm run build` must run before `npm run nro` — the packager reads
`romfs/main.js` from the previous step.

### NACP / Title ID

`package.json` sets `nacp.id` to `01f5905036d20000` (one above the player's
`01f5905036d10000`). If you have another homebrew with the same ID
installed on your Switch / Citron, change this field and rebuild — Title IDs
are 16 hex digits ending in `0000`.

### Icon

If `D:\Workspace\switch-web-browser\icon.jpg` is present, `nxjs-nro` uses
it. Otherwise the default nx.js icon is bundled. Drop a 256×256 JPEG at
that path when you have artwork.

### Deploying to Citron

Copy `switch-web-browser.nro` into the Citron homebrew menu's NRO folder
(usually `%APPDATA%\citron\sdmc\switch\` on Windows). On real hardware,
copy to the SD card's `/switch/` directory.

## Dependency direction

```text
nxjs-source           (native Switch homebrew layer)
   ↑
@switch-web/runtime   (shared WebView, shims, fetch, permissions)
   ↑
switch-web-browser    (this repo: browser shell)
```

`switch-web-browser` **does not** import from `switch-webapp-player`. The
player and the browser are siblings that both depend on
`@switch-web/runtime`.

## Repo layout

```text
switch-web-browser/
├─ package.json
├─ tsconfig.json
├─ README.md
├─ assets/
│  ├─ icons/                      # browser UI icons (stub)
│  ├─ fonts/                      # custom fonts (stub)
│  └─ default-pages/              # built-in pages
│     ├─ new-tab.html
│     ├─ error.html
│     └─ about.html
├─ docs/
│  ├─ browser-architecture.md
│  ├─ navigation.md
│  ├─ browser-ui.md
│  ├─ storage-and-profiles.md
│  └─ security-model.md
├─ scripts/
│  ├─ build.ts                    # placeholder; npm run build uses esbuild directly
│  ├─ copy-to-sd.ts               # placeholder
│  └─ clean.ts                    # placeholder
└─ src/
   ├─ main.ts                     # thin entry → BrowserShell.run()
   ├─ browser-shell.ts            # constructs WebView + loader; calls webView.load(home)
   ├─ browser-ui.ts               # stub
   ├─ browser-config.ts           # constants (exit combo, default URL, etc.)
   ├─ navigation/
   │  ├─ browser-navigation.ts    # wraps runtime NavigationController
   │  ├─ history-store.ts         # stub
   │  └─ bookmarks-store.ts       # stub
   ├─ input/
   │  ├─ address-bar-input.ts     # stub
   │  ├─ keyboard-overlay.ts      # stub
   │  └─ controller-shortcuts.ts  # Minus-hold exit
   ├─ profile/
   │  ├─ browser-profile.ts       # stub
   │  ├─ cookie-store.ts          # stub
   │  ├─ local-storage-store.ts   # stub
   │  └─ cache-store.ts           # stub
   ├─ permissions/
   │  └─ browser-permission-policy.ts
   ├─ resources/
   │  └─ browser-resource-loader.ts  # serves brewser://new-tab/, error/, about/
   └─ pages/
      ├─ new-tab-page.ts          # JS bundle string for brewser://new-tab/
      ├─ error-page.ts            # JS bundle string for brewser://error/
      └─ about-page.ts            # JS bundle string for brewser://about/
```

## Next milestones

See [`docs/browser-architecture.md`](docs/browser-architecture.md) for the
intended growth path:

1. ~~Wire `BrowserResourceLoader` for `brewser://` pages and load
   `brewser://new-tab/` via `WebView.load()`.~~ **Done.**
2. ~~Add address-bar input (keyboard overlay + controller shortcuts).~~
   **Done.** ZR (or tap the URL bar) opens the on-canvas keyboard;
   submit hands the typed text to `AddressBarInput.resolve()` →
   `BrowserNavigation.navigate()`.
3. ~~Add `NavigationController` integration for back/forward/reload.~~
   **Done.** B / X / Y trigger `BrowserNavigation.goBack` / `.goForward`
   / `.reload`. The history stack is held by the runtime's
   `NavigationController` and pushed on every navigate.
4. Add `BrowserProfile` + cookie/local-storage/cache stores.
5. Add tabs.
