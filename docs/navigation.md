# Navigation

`BrowserNavigation` (`src/navigation/browser-navigation.ts`) wraps the
runtime's `NavigationController` and ties it to a `WebView`. The runtime
controller is intentionally small — it owns the history stack and the
`currentURL` / `canGoBack` / `canGoForward` accessors. The browser layer
adds the side effects: actually loading the URL into the `WebView` and
recording it in `HistoryStore`.

## Stack semantics

`NavigationController` keeps a single linear history with an `index`
pointer:

- `navigate(url)` pushes onto the end, truncating any forward entries.
- `goBack()` decrements `index`; returns the URL or `null`.
- `goForward()` increments `index`; returns the URL or `null`.
- `reload()` returns the current URL unchanged.
- `clear()` empties the stack.

This is a per-tab structure. Multi-tab support keeps one
`NavigationController` per tab.

## Status

Live for `browser://` JS bundle pages, `browser://test-html/*` HTML
fixtures, and (on real hardware) live `http(s)` HTML.

`BrowserNavigation.navigate(url)` records the URL on the controller, then
calls `webView.load({ url })`. The runtime fetches the URL through the
registered loaders (`BrowserResourceLoader` first; `NativeFetchLoader`
appended automatically) and dispatches by `Content-Type`:

- `text/javascript` (`browser://new-tab/`, etc.) → `new AsyncFunction(body)`
  executes the bundle inside the app session.
- `text/html` / `application/xhtml+xml` → `WebViewDelegate.onHtmlResponse`
  fires, the browser shell runs the body through the HTML pipeline
  (parse → layout → paint), and stores the `LayoutResult` for scroll
  repaints.

If the load throws (network error, decode error, unhandled content
type, etc.), the navigation falls back to `browser://error/` while
keeping the controller pointed at the originally requested URL (so
back/forward and the address bar both still reflect the user's intent).
The full error message + stack is stashed on `globalThis.__browserLastError`
so the error page bundle can render it.

`http(s)://` targets reach `NativeFetchLoader` when `allowNetwork` is
true (the default). In Citron, the native socket layer fails fast with
an empty error — see `docs/browser-architecture.md` for why and for the
fixture-based dev pattern. On real hardware the round-trip works.

## Link taps and scrolling

Two non-button inputs also feed the navigation loop:

- **Content link tap** — `BrowserResourceLoader` and the layout pass
  expose link rects in layout-space coordinates. The single canvas
  touch handler (`installCanvasTouch`) hit-tests these against
  `clientY + scrollY` so scroll-offset doesn't break tap targets.
  A hit pushes `{ kind: 'navigate', url }` into the input queue and
  the main loop dispatches it the same way as a chrome glyph press.
- **Scroll** — right stick Y (with deadzone + smooth ramp) and D-pad
  up/down. `waitForControllerInput` fires `onScroll(delta)` and keeps
  polling rather than returning. The shell clamps to
  `[0, contentBottomY - canvasHeight]`, calls `setContentScrollY(y)`
  to update the touch handler's offset, and repaints the content area
  via `paintLayout(result, { scrollY })`. Layout is not re-run.

## On-canvas keyboard behavior

The on-canvas keyboard (`KeyboardOverlay`) overlays the bottom half of
the canvas while open. Two dismissal paths matter for navigation:

- Submit → `BrowserNavigation.navigate(resolvedURL)`.
- Cancel via the B button or the keyboard's Cancel key → no navigation;
  the shell reloads the current URL to redraw over the keyboard pixels.
- **Tap outside the keyboard panel** → the keyboard treats it as a
  cancel and the canvas touch handler (which fired the same event
  first) may have already queued a `navigate` / `back` / `forward` /
  `address-bar` input. `promptAndNavigate` peeks the pending input via
  `peekPendingInput()`; if anything is queued it skips the redraw and
  lets the main loop dispatch what the user actually tapped on. So
  tapping a link while the keyboard is open dismisses the keyboard
  *and* navigates to the link.

## Current wiring

```text
controller-shortcuts.ts (L+R+Minus held 1s            -> exit)
                        (ZR rising-edge OR chrome URL tap -> address-bar)
                        (chrome back-glyph tap        -> back)
                        (chrome forward-glyph tap     -> forward)
                        (B  rising-edge               -> back)
                        (X  rising-edge               -> forward)
                        (Y  rising-edge               -> reload)
                        (content-area tap on a link   -> navigate(href))
                        (right stick Y / D-pad U/D    -> onScroll(delta))
            |
            +---- 'address-bar' --------------------+
            +---- 'back'/'forward'/'reload' --------+
            +---- 'navigate' (link href) -----------+
            +---- 'exit' (L+R+Minus held)           |
                                                    v
BrowserShell.run loop (per input)
            |
            | 'address-bar':
            +-> promptAndNavigate()
            |     +-> KeyboardOverlay.open(currentURL)   // on-canvas keyboard
            |     +-> AddressBarInput.setText(value).resolve()
            |     +-> BrowserNavigation.navigate(url)    // on submit
            |     |   OR  navigateTo(currentURL)         // on cancel — reload to
            |     |                                      // clear keyboard pixels
            |     |   OR  return                         // tap-outside dismissed
            |     |                                      // and queued another input
            |
            | 'back' / 'forward' / 'reload':
            +-> runNavigation(() => navigation.go{Back,Forward}() | reload())
            |     +-> NavigationController.go{Back,Forward,reload}()
            |     +-> WebView.load({ url }) if URL is non-null
            |           +-> [JS body]    AsyncFunction eval
            |           +-> [HTML body]  onHtmlResponse → parse → layout → paint
            |           +-> [error]      browser://error/ fallback with
            |                            __browserLastError stash
            |
            | 'navigate' (link tap):
            +-> navigateTo(input.url)
                  // same path as a typed-URL submit

(scroll fires while waiting; no kind returned)
            |
            | onScroll(delta):
            +-> handleScroll(delta) → clamp → repaintContent()
                  +-> setContentScrollY(scrollY)  // touch hit-test offset
```

## What NOT to put here

- Page rendering — that's the runtime's WebView + a `BrowserResourceLoader`.
- Cookie / cache lookup — that's `BrowserProfile`.
- Soft-keyboard handling — that's `input/keyboard-overlay.ts`.
