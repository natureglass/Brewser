# Browser architecture

`switch-web-browser` is a browser shell that runs on top of
[`@switch-web/runtime`](../../switch-web-runtime). It shares all the
nx.js-facing glue — browser-like globals, WebGL/touch/gamepad shims, local
fetch wrapper, app-session lifecycle — with `switch-webapp-player`.

## Status

End-to-end HTML **and CSS** rendering against local fixtures. The shell
parses HTML to a tag-soup tolerant tree, applies CSS from inline
`<style>`, external `<link rel="stylesheet">`, and inline `style="..."`
attributes (with full specificity-based cascade), then lays out and
paints the result on the 2D canvas with scrolling and tap-to-navigate.
The shell currently:

1. Constructs a `BrowserPermissionPolicy` (network on, local files off,
   gamepad/touch/WebGL on).
2. Constructs a runtime `WebView` with that policy plus a
   `BrowserHistoryLoader` and `BrowserResourceLoader` registered ahead of
   the auto-built `NativeFetchLoader`. A `WebViewDelegate.onHtmlResponse`
   hook is supplied so HTML responses are routed to the browser's HTML
   pipeline instead of being eval'd as JS.
3. Calls `webView.initialize()` to install the shims (including the
   runtime-level `navigator.userAgent` shim — see below).
4. Paints a boot splash, runs `probeNetwork()` against three targets
   (`https://1.1.1.1/`, `http://1.1.1.1/`, `romfs:/main.js`), and stashes
   the result for the new-tab page to display.
5. Constructs a `BrowserNavigation` wrapping the runtime
   `NavigationController`. Failed loads fall back to `browser://error/`
   with the actual error message + stack stashed on
   `globalThis.__browserLastError` so the error page can show it.
6. Navigates to `browser://welcome/` (the default home page,
   served as HTML from the seeded profile). The user can switch to
   `browser://new-tab/` — the only remaining JS bundle, since it
   uses top-level `await fetch('browser://history/')` to populate
   the "Recent" list.
7. Draws the address-bar chrome strip (back/forward glyphs + URL +
   controller hint) over the top 56 pixels.
8. Enters the input loop. Each iteration is one of:
   - **ZR** or **tap the chrome strip URL area** → on-canvas keyboard.
     Tap a key to type, or tap outside the keyboard panel to dismiss.
     Submit → navigate. Cancel → reload current.
   - **B** / **X** / **Y** or chrome glyph tap → back / forward / reload.
   - **Tap a content link** (anywhere in the page area) → resolve the
     link's href against the current URL and navigate.
   - **Right stick Y** or **D-pad up/down** → scroll the current HTML
     page. Stick is continuous; D-pad steps one line per press.
   - **L + R + Minus** held ~1s → exit.

When `WebView.load()` fetches a `Content-Type: text/html` response
(or `application/xhtml+xml`), the WebView routes the body to
`WebViewDelegate.onHtmlResponse` rather than `new AsyncFunction`-eval'ing
it. The browser's delegate runs the body through the HTML + CSS pipeline
described below and stores the resulting layout for scroll repaints.

## Target layers (bottom up)

```text
+-----------------------------------------------------------------+
| BrowserShell           (src/browser-shell.ts)                   |
|   orchestrates WebView + UI + navigation + profile + scroll     |
+-----------------------------------------------------------------+
| BrowserUI              (src/browser-ui.ts)                      |
|   address bar (back/forward glyphs + URL + hint)                |
+-----------------------------------------------------------------+
| HTML + CSS pipeline    (src/html/*, src/css/*)                  |
|   parseHtml → applyCss → layoutDocument → paintLayout           |
|   collects LinkRects for tap-to-navigate                        |
+-----------------------------------------------------------------+
| Input loop             (src/input/controller-shortcuts.ts)      |
|   gamepad + touch + scroll callback                             |
+-----------------------------------------------------------------+
| BrowserNavigation      (src/navigation/browser-navigation.ts)   |
|   wraps NavigationController; ties navigate/back/forward to     |
|   webView.load() + HistoryStore + error-page fallback           |
+-----------------------------------------------------------------+
| Resource loaders                                                |
|   - BrowserHistoryLoader   (browser://history/  → JSON)         |
|   - BrowserResourceLoader  (browser://*  → JS bundles + HTML    |
|                              fixtures)                          |
|   - NativeFetchLoader      (http/https, supplied by runtime)    |
+-----------------------------------------------------------------+
| BrowserProfile         (src/profile/browser-profile.ts)         |
|   ensures sdmc:/switch/webprofiles/default/; owns history path  |
+-----------------------------------------------------------------+
| BrowserPermissionPolicy (src/permissions/...)                   |
+-----------------------------------------------------------------+
| @switch-web/runtime (WebView, shims, runtime-fetch, session,    |
|   userAgent shim in installBrowserShim)                         |
+-----------------------------------------------------------------+
| nx.js native runtime + Switch homebrew APIs                     |
+-----------------------------------------------------------------+
```

## HTML + CSS pipeline

`src/html/` and `src/css/` together own the entire pipeline from
response body to drawn pixels. The runtime's WebView never touches
HTML directly — it only knows the content type is HTML and hands the
body to the delegate.

```text
WebView.fetchAndExecute → onHtmlResponse(url, html)
   │
   ▼
parseHtml(html)               // src/html/html-parser.ts
   │  tag-soup tolerant, lowercases tags, decodes entities, drops
   │  whitespace-only text nodes outside <pre>, preserves whitespace
   │  verbatim inside <pre>, captures <style> body as a text child
   │  (other raw-text tags are discarded), auto-closes
   │  <p>/<li>/<td>/etc on reopen, attaches parent pointers.
   ▼
applyCss(tree, baseUrl)       // src/css/css-apply.ts  (async)
   │  1. Walk tree in document order; collect every <style>
   │     element's text and every <link rel="stylesheet"> href.
   │  2. Fetch external stylesheets in parallel via the runtime
   │     fetch wrapper (works for romfs:/, sdmc:/, http(s):// on
   │     real hardware).
   │  3. Parse each CSS body with css-tree, walk Rules, expand each
   │     selector list. For each selector, parse into compounds +
   │     combinators, compute specificity [inline, id, class, type],
   │     match against every element, collect (specificity, source,
   │     overrides, elements) entries.
   │  4. Walk every element with a `style="..."` attribute; parse
   │     as a declaration list, push as an entry with specificity
   │     [1, 0, 0, 0] so inline always wins same-specificity ties.
   │  5. Sort entries (specificity ascending, then source ascending)
   │     and apply in order so the highest-specificity / latest
   │     rule wins per property.
   │  6. Propagate inheritable properties (color, font-size, weight,
   │     italic, underline) down the tree into a *separate* inherited
   │     map — `applyCss` returns `{ direct, inherited }` so the
   │     layout can slot tag-specific UA defaults between them in
   │     the cascade. Non-inherited properties (background-color,
   │     margin, padding) stay in `direct` only.
   ▼
layoutDocument(tree, opts)    // src/html/html-layout.ts  (async)
   │  Pass 1: collect every <img src>, resolve, kick off parallel
   │          `new Image()` loads.
   │  Pass 2: synchronous tree walk. Block tags produce LineBoxes
   │          (with inline runs measured via ctx.measureText),
   │          ImageBoxes, or BackgroundBoxes; <hr> → HrBox; ul/ol
   │          indent their children; <li> gets a "• " or "N. "
   │          marker; <a href> stamps isLink+href onto every
   │          contained atom. CSS-resolved color/font/text-decoration
   │          override the block defaults; CSS margin replaces
   │          block-default vertical spacing; CSS padding shifts
   │          content inside the bg.
   ▼
paintLayout(result, opts)     // src/html/html-painter.ts
   │  Clips to content viewport via save+rect+clip+restore. Body's
   │  computed `backgroundColor` is the page-clear color. Two passes:
   │  first paints every BackgroundBox so per-block fills sit behind
   │  text/images; second paints LineBoxes, ImageBoxes, HrBoxes.
   │  Each LineBox offsets by -scrollY. Bold = doubled fillText with
   │  horizontal offset; italic = setTransform skew (nx.js doesn't
   │  synthesize variants — see "Runtime shims" below). Right-edge
   │  scrollbar drawn when contentBottomY > viewport.
   ▼
setContentLinks(result.links) // input/controller-shortcuts.ts
   `setContentScrollY(scrollY)  in layout-space coords; the touch
   handler offsets by current scrollY when hit-testing.
```

Scrolling repaints the same `LayoutResult` with an updated `scrollY`.
Neither parse, CSS apply, nor layout is re-run.

What the pipeline does NOT do (and probably never will at this layer):
no full DOM, no forms or input controls, no tables, no inline `<img>`
inside `<p>` (block-level images only), no progressive paint as images
load, no `visibility: hidden`, no `width`/`height` CSS on blocks.
`display: none` is supported (skips element + descendants);
`display: block`/`inline`/`inline-block` are parsed but do not switch
an element's layout role. Borders draw on the bg rect's edges (half
inside, half outside) and do not displace content — so a thick border
without padding will visually overlap the text inside.

Inline `<script>` execution is supported only for the canvas-drawing
experiment — see "Inline scripts" below. We do **not** run scripts
against a full DOM; the only thing they can reach is the per-`<canvas>`
offscreen surfaces. `<canvas>` without a populating script renders as
a sized placeholder (using its `width` / `height` attrs, or HTML's
300×150 spec defaults, scaled to fit the content area); its
spec-defined fallback children are ignored either way.

## Inline scripts (canvas-drawing experiment)

`src/scripts/canvas-runner.ts` runs once between CSS apply and layout.
For every `<canvas>` it allocates an `OffscreenCanvas` sized from the
element's `width`/`height` attrs (default 300×150). It then walks the
tree and `new Function('document', 'console', body)`-evaluates every
`<script>` body in document order, passing a minimal `document` shim
whose `getElementById` / `querySelector` / `querySelectorAll` /
`getElementsByTagName` only ever return wrappers for `<canvas>`
elements (other elements aren't reachable). The wrapper's
`.getContext('2d')` hands the script the OffscreenCanvas's 2D
context. Drawing must be synchronous — there's no
`requestAnimationFrame`, `setTimeout`, or event loop; the painter
shows whatever the script has drawn by the time the `new Function`
call returns. The runner also supplies a `console` shim that routes
`log`/`info`/`warn`/`error` to `console.debug` so a page script can't
trigger the nx.js render-mode switch (see
`feedback_console_error_switches_render_mode.md`). Errors thrown by a
script are caught and logged via `console.debug` so a broken script
can't take the rest of the page down.

The layout reads the runner's `Map<HtmlElement, OffscreenCanvas>` via
`LayoutOptions.canvasOutputs` — if a `<canvas>` has an entry,
`layoutCanvas` emits an `ImageBox` whose `image` is the offscreen and
the painter blits it with the same `ctx.drawImage` call it uses for
regular `<img>` elements (`CanvasImageSource` covers both
`Image` and `OffscreenCanvas` in nx.js).

Scope: synchronous one-shot only, canvas-element access only, no DOM
manipulation, no event listeners, no network from scripts, no
sandboxing (scripts see the runtime's globals).

`runPageScripts` returns a `PageScriptContext`, not just the outputs
map. The shell keeps it so it can call `ctx.rerun(resizes)` — resize
named offscreens (which clears them per the spec) and re-execute
every script in document order. The fullscreen-canvas mode uses this
to make a responsive canvas redraw at viewport size and then again at
its declared size on exit. `ctx.firstCanvas()` is the picker for that
mode (first `<canvas>` in document order).

## Fullscreen modes

The shell tracks a `BrowserMode` of `normal` / `fullscreen-page` /
`fullscreen-canvas`. Mode transitions are triggered by HTML buttons
in the page (not chrome-strip buttons): a `<button data-action="...">`
whose action string matches `fullscreen-page` or `fullscreen-canvas`
dispatches the corresponding toggle when tapped. The shell silently
drops unknown action strings.

- **`fullscreen-page`** hides the chrome strip, paints the layout
  with `topInset: 0`, and shifts the painted scroll by `CHROME_HEIGHT`
  so the content fills the freed-up area. Max-scroll is recomputed
  for the larger viewport. Gamepad scrolling (right stick / D-pad)
  still works; touch is disabled while in fullscreen since the
  buttons aren't visible to tap.
- **`fullscreen-canvas`** picks the first `<canvas>` on the page,
  asks the runner to resize that offscreen to the viewport and rerun
  all scripts (so a responsive script redraws at full size), then
  blits the offscreen filling the screen. The page layout isn't
  painted in this mode.
- **Exit** is **L + R** (rising edge, *without* Minus to avoid
  conflicting with the L+R+Minus held-1s shell-exit combo). Mode
  also resets to `normal` on every navigation (in `onPageStarted`)
  so the gamepad-driven back/forward can't strand the user.

`setBrowserMode` mirrors the shell's mode into the controller
shortcuts so its touch listener can suppress all tap dispatch (chrome
*and* content) when fullscreen is engaged.

### How `<button>` is wired

The CSS pass has a UA rule giving `<button>` a dark backdrop, bold
white text, and padding. The layout treats `button` as a leaf block:
its text content flows inside the block, and `layoutLeafBlock`
additionally pushes a `ButtonRect` (the bg rect + the `data-action`
string) onto `cursor.buttons`. `LayoutResult.buttons` is handed to
the controller-shortcuts touch dispatcher via `setContentButtons`,
which checks button rects before link rects on every tap. A matching
tap fires `{ kind: 'button-action', action }` and the shell's
`dispatchButtonAction` routes it.

## CSS engine

`src/css/css-apply.ts` is a self-contained CSS engine built on top of
[css-tree](https://github.com/csstree/csstree) (~250 KB minified,
pure-JS, dropped into the esbuild bundle). It doesn't try to be
spec-complete — it covers the subset of CSS that's useful for our
canvas renderer and bails on anything it doesn't recognise.

### Properties

| Property                  | Inherited | Where it lands               |
| ------------------------- | --------- | ---------------------------- |
| `color`                   | yes       | `RunStyle.color`             |
| `font-size` (`Npx` only)  | yes       | `RunStyle.fontSize`          |
| `font-weight` (`bold`, `normal`, `bolder`, `lighter`, numbers — ≥600 = bold) | yes | `RunStyle.weight` |
| `font-style` (`italic`, `oblique`, `normal`) | yes | `RunStyle.italic` |
| `text-decoration` (`underline`, `none`) | yes | `RunStyle.underline` |
| `text-align` (`left`, `right`, `center`, `justify`, `start`/`end` → `left`/`right`) | yes | per-line shift in `flowAtoms` |
| `display` (`none`, `block`, `inline`, `inline-block`) | no | only `'none'` acts: removes element + descendants from layout. Others parsed but ignored. |
| `line-height` (`normal`, unitless `1.4`, `Npx`, `N%`) | yes | per-block line metric in `flowAtoms` |
| `list-style-type` / `list-style` (shorthand picks the type keyword) | yes | `<li>` marker formatting (disc/circle/square/decimal/lower-alpha/upper-alpha/lower-roman/upper-roman/none) |
| `background-color`, `background` (color only) | no | `BackgroundBox.color` |
| `margin{,-top,-right,-bottom,-left}` (1/2/3/4-value shorthand) | no | block layout positioning |
| `padding{,-top,-right,-bottom,-left}` (same)   | no | block layout positioning |
| `border` / `border-{top,right,bottom,left}` shorthand (`Npx <style> <color>` in any order) | no | `BorderBox` strokes, one per non-zero edge |
| `border-width` / `border-style` / `border-color` (single-value; per-edge longhands too) | no | same |

Other property names are recognised by css-tree (so they don't break
parsing) but silently ignored. Value forms outside the listed ones
(`em`/`%` lengths, `rgba()` mixed with named colors, multi-value
`text-decoration`) are mostly tolerated — if a token doesn't parse,
that property just doesn't apply.

### Selectors

| Selector       | Example          | Supported |
| -------------- | ---------------- | --------- |
| Type           | `h1`             | yes       |
| Class          | `.note`          | yes       |
| ID             | `#main`          | yes       |
| Universal      | `*`              | yes       |
| Descendant     | `article p`      | yes       |
| Child          | `ul > li`        | yes       |
| Adjacent sibling | `h2 + p`       | yes       |
| General sibling  | `h2 ~ p`       | yes       |
| Selector list  | `a, button`      | yes       |
| Attribute (has)  | `[lang]`       | yes       |
| Attribute (`=` `~=` `^=` `$=` `*=` `\|=`) | `a[href^="https://"]` | yes |
| `:first-child`, `:last-child`, `:only-child` |     | yes       |
| `:first-of-type`, `:last-of-type`            |     | yes       |
| `:nth-child(...)`, `:nth-last-child(...)`    | `li:nth-child(2n+1)`, `:nth-child(odd)` | yes |
| `:nth-of-type(...)`, `:nth-last-of-type(...)` |    | yes       |
| Other pseudo-classes (`:hover`, `:not`, `:has`, …), pseudo-elements (`::before`) | various | no — selector silently ignored |

A selector that contains any unsupported piece bails out and skips
that one — other selectors in the same `Rule`'s list still apply.
Attribute selectors and pseudo-classes both contribute to the "class"
component of specificity (Selectors Level 3).

### Cascade

Specificity is a 4-tuple `[inline, id, class, type]`. Inline `style="..."`
attributes get `[1, 0, 0, 0]` so they always beat any selector. Within
equal specificity, source order wins (later rule overwrites earlier).
External `<link rel="stylesheet">` rules and inline `<style>` rules
share one source counter assigned by document order, so a `<style>`
block after a `<link>` correctly wins same-specificity ties.

Inheritance runs as a final pass after the cascade resolves: for each
inheritable property (color, font-size, weight, italic, underline) a
top-down walk records — in a *separate* `inherited` map — the values
each descendant would receive from an ancestor. Direct matches are
never overwritten by the inheritance pass, and `applyCss` returns
both maps as `{ direct, inherited }`. Non-inherited properties
(background, margin, padding) live in `direct` only.

The layout layers them as
`DEFAULT_STYLE → inherited → block UA defaults → direct` when computing
a block's base text style. The block UA layer is what gives `<h1>` its
34px font even when `body { font-size: 14px }` reaches the heading via
inheritance — a direct match on the heading itself (`h1 { font-size: …}`)
still wins because it applies last. Inline descent inherits via the
parent block's resolved style, so `collectInline` only applies direct
matches to inline elements.

### Stylesheet sources

In document order:
1. Inline `<style>` element bodies (raw text captured by the parser).
2. External `<link rel="stylesheet" href="...">` — fetched in parallel
   via the runtime fetch wrapper. Works against `romfs:/`, `sdmc:/`,
   and (on real hardware) `http(s)://`. Citron has no TCP sockets so
   the network path can't be validated there — see "Test fixtures"
   below.

Inline `style="..."` attributes are collected last after all
stylesheet rules so the source-order tiebreak works.

### CSS-aware fixtures

Beyond the basic HTML fixtures, there are dedicated CSS exercises:
- `browser://test-html/css/` — box-model and cascade exercises:
  colors, fonts, weight, style, decoration, backgrounds, margin,
  padding, specificity, inline-style overrides.
- `browser://test-html/external-css/` — uses
  `<link rel="stylesheet" href="romfs:/test-css/external.css">`
  and an additional inline `<style>` block to demonstrate the
  source-order tiebreak between external and inline sheets.
- `browser://test-html/inherit/` — exercises the inherited-vs-direct
  split: `body { font-size: 14px }` leaves block defaults intact
  (h1=34px, h2=26px, p=18px) while still inheriting color, and a
  direct `.tiny-heading { font-size: 14px }` rule on an h1 wins.
- `browser://test-html/selectors/` — exercises the structural
  pseudo-classes (`:first-child`, `:last-child`, `:nth-child(odd)`,
  `:first-of-type`, `:last-of-type`), sibling combinators (`+`, `~`),
  and attribute selectors (`[data-flag]`, `[data-flag="hot"]`,
  `a[href^="https://"]`, `span[class~="hl"]`, `span[lang|="en"]`).
- `browser://test-html/align/` — exercises `text-align`: a centered
  h1, right/center/justify paragraphs (with the last-line exception
  for justify), and inheritance through a `.center-block` div with
  one `.opt-out` paragraph that directly overrides back to `left`.
- `browser://test-html/display-none/` — exercises `display: none`:
  a class-targeted hidden paragraph, an inline span hidden mid-
  sentence, an inline-style hidden paragraph, and a hidden `<div>`
  whose descendant rules (red bg + 20px padding) must never render.
- `browser://test-html/line-height/` — exercises `line-height`:
  unitless multipliers (`1.0` / `2.0`), absolute `Npx`, and `N%`,
  all inherited from a wrapper.
- `browser://test-html/list-style/` — exercises `list-style-type`:
  disc / circle / square / none bullets; decimal / lower-alpha /
  upper-alpha / lower-roman / upper-roman ordered markers;
  inheritance from a wrapper `<div>`.
- `browser://test-html/border/` — exercises `border`: solid /
  dashed / dotted / double shorthand, per-edge longhands, mixed
  per-edge styles + colours, border-with-background alignment, and
  the CSS-correct "width without style stays invisible" rule.
- `browser://test-html/canvas/` — exercises `<canvas>` placeholder
  treatment: explicit dimensions, HTML 300×150 defaults, spec-defined
  fallback children (ignored, not double-rendered), and an oversized
  canvas scaled down to the content width.
- `browser://test-html/canvas-script/` — exercises the inline-script
  canvas-drawing experiment: solid fills, lines + path, text on
  canvas, linear gradient, a script that throws (other canvases
  still render), and a no-script canvas that falls back to the
  placeholder.
- `browser://test-html/canvas-responsive/` — exercises fullscreen
  mode: a single responsive canvas whose script reads `canvas.width`
  / `canvas.height` and redraws to fit, plus two HTML
  `<button data-action="...">` toggles (page fullscreen + canvas
  fullscreen). **L + R** exits either fullscreen mode.

### Bundle cost

css-tree adds ~360 KB to the esbuild bundle (browser bundle went from
~100 KB pre-CSS to ~470 KB). Acceptable for an 8 MB NRO. If bundle
size ever bites, css-tree exposes `css-tree/parser`, `css-tree/walker`,
etc. as subentries that may tree-shake better.

## Runtime shims (cross-cutting)

Two non-obvious traps in nx.js that the runtime layer now silently
papers over. Both have memory entries with the diagnostic stacks; the
short version:

- **`navigator.userAgent` throws on Citron and on real-device NACPs
  without a matching language entry.** nx.js's `fetchHttp` reads
  `navigator.userAgent` to set the `User-Agent` header, so the very
  first network fetch blows up before any bytes leave the runtime.
  `installBrowserShim` in `@switch-web/runtime` now redefines
  `navigator.userAgent` with a static `'@switch-web/runtime'` string
  (writable+configurable so example webapps can still override).
- **Bold and italic are silently dropped.** nx.js registers a single
  system-ui FontFace and `findFont` matches family AND style AND
  weight AND stretch strictly. `ctx.font = 'italic bold 18px system-ui'`
  falls through to plain. The HTML painter synthesizes both:
  bold = double-draw shifted by ~0.6–1.3 px; italic = save/translate/
  transform-skew/fillText/restore. Width measurement is unchanged
  (we'd undersize bold runs by ~1 px otherwise, but it stays inside
  the line).

## Test fixtures and the Citron iteration pattern

Citron does not implement Switch's TCP `$.connect` syscall, so
`http(s)://` `fetch()` rejects with an empty `Error` 14–60 ms after
issue. nx.js fetch is fine; only the socket layer is. This is the
fundamental constraint that shaped C2–C5 development.

Workaround: develop and validate the entire HTML + CSS pipeline
against on-disk fixtures served by `BrowserResourceLoader` with
`Content-Type: text/html`. Fixtures live as real HTML files under
`sdmc:/switch/webprofiles/default/pages/` (seeded from
`romfs:/pages/` on first launch by `BrowserProfile.seedBuiltinPages`);
the loader maps `browser://X/Y/.../` to `<profile>/pages/X/Y/....html`.
Available pages:

- `browser://test-html/` — hello / index page; links into the others.
- `browser://test-html/two/` — second page for testing back/forward
  navigation.
- `browser://test-html/images/` — block + inline `<img>` cases.
- `browser://test-html/pre/` — `<pre>` whitespace preservation + inline
  `<code>`.
- `browser://test-html/css/` — CSS cascade, specificity, inline styles,
  margin/padding, backgrounds.
- `browser://test-html/external-css/` — `<link rel="stylesheet">` from
  `romfs:/test-css/external.css`, plus an inline `<style>` block.

The runtime fetch wrapper routes them through the loader chain and the
WebView dispatches them to `onHtmlResponse` exactly like a real HTTP
response. Image assets and external CSS that need to be real binary or
text files go in `romfs/` (under `test-images/` and `test-css/`);
the build packs them into the NRO and the fixture HTML references them
as `romfs:/test-images/...` and `romfs:/test-css/...`.

This means the parser, CSS apply pass, layout, painter, link handling,
image rendering, scrolling, AND external stylesheet loading are all
exercised end-to-end in Citron without any network. Live `http(s)://`
HTML and stylesheets require real Switch hardware to fully validate.

## Growth path

1. ~~**Internal pages via loader.** Implement `BrowserResourceLoader` and
   register it ahead of `NativeFetchLoader`.~~ **Done.**
2. ~~**Address bar via on-canvas keyboard.**~~ **Done.** Tap outside the
   keyboard panel also dismisses it, falling through to whatever the
   tap actually wanted (link, chrome glyph, etc.).
3. ~~**Navigation chrome bindings.**~~ **Done.** Visual back/forward
   glyphs in the chrome strip with active/inactive state and
   tap-dispatch by x position.
4. ~~**Profile + storage (history).**~~ **Done for history.** Cookies,
   local-storage, cache, bookmarks are still TODO.
5. ~~**Real network pages — HTML rendering.**~~ **Done in the pipeline**
   sense (parser + layout + paint + link tap + image + scrolling).
   `WebView` now sniffs `Content-Type` and routes HTML to the delegate.
   Live `http(s)` validation gated on real Switch hardware (Citron has
   no TCP sockets).
6. ~~**CSS engine.**~~ **Done for the core subset.** css-tree-based parse;
   tag/class/id/`*` selectors with descendant + child + adjacent-sibling
   + general-sibling combinators; structural pseudo-classes
   (`:first-child`, `:nth-child`, etc.) and attribute selectors
   (`[a=v]`, `~=`, `^=`, `$=`, `*=`, `|=`); selector lists;
   specificity-based cascade with inline `style="..."`, inline
   `<style>`, and external `<link rel="stylesheet">`; direct vs.
   inherited values kept separate so tag-specific UA defaults survive
   over `body { font-size: ... }`; properties cover text styling,
   color, background, margin, padding. See "CSS engine" above for the
   full matrix.
7. **Tabs.** Multi-instance `WebView` doesn't exist yet — first tab
   implementation: active tab owns the only `WebView`; background tabs
   keep just their URL and history-store entry.

### Loader registration order

The runtime's `WebView` now prepends caller-supplied `resourceLoaders`
before the auto-built `LocalResourceLoader` / `NativeFetchLoader`. So
`BrowserResourceLoader` claims `browser://` URLs before `NativeFetchLoader`
sees them, but `http(s)://` URLs still fall through to the auto-built
`NativeFetchLoader` without the browser having to re-register it. See
`switch-web-runtime/docs/resource-loading.md` for the full ordering rules.

## Non-goals (still)

- Full DOM. No `document.querySelector`, no mutation observers, no events.
- JS execution from rendered HTML pages. `<script>` is stripped at
  parse time.
- Spec-complete CSS. We cover a tiny subset; pseudo-classes, sibling
  combinators, attribute selectors, `display`, `width`/`height`,
  borders, floats, flex, grid, transforms, animations, media queries —
  all out of scope or to be added piecemeal.
- Forms, tables, multi-process tabs, Service Workers, IndexedDB.
- Scroll position persistence across back/forward. (Could be added by
  putting `scrollY` on `NavigationController` history entries; not
  done yet.)
- Inline `<img>` inside text flow with proper baseline alignment for
  short images smaller than the surrounding line height. (Today we
  bottom-align inline images within the line, which works well for
  icon-sized images but looks off if the image is much taller than the
  text.)

## Anti-imports

`switch-web-browser` must not import from `../switch-webapp-player/`. If the
browser ever needs something the player has, lift it into
`@switch-web/runtime` first, then import it from there.
