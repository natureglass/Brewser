# Browser UI

The browser shell is targeted at the Switch's single fullscreen canvas. The
intended chrome (address bar, back/forward/reload, tab strip) is rendered
directly to the 2D canvas — the runtime's browser shim does not provide a
real DOM.

## Status

`src/browser-ui.ts` exposes a `BrowserUI` class with `renderAddressBar(state)`
that paints a 56-pixel chrome strip over the top of the canvas after
every navigation. The strip contains:

- ‹ and › glyphs on the left for back/forward, drawn in an "active"
  color when there's history to move to and a dimmed color otherwise.
  Tap regions are kept in sync with the glyph positions via
  `CHROME_LAYOUT` in `browser-config.ts`.
- The current URL after a 1 px divider, truncated with an ellipsis if
  it would collide with the hint.
- The controller hint flush right.

Below the strip, page content is painted by either the active
`brewser://` JS bundle (`new-tab`, `error`, etc.) drawing direct to the
canvas, or by the HTML pipeline's `paintLayout` rendering a
`LayoutResult`. The HTML pipeline owns the entire content area
(`y in [CHROME_HEIGHT, canvasHeight)`) and clips its drawing to that
band so scrolled content never bleeds into the chrome strip. A 4 px
scrollbar appears on the right edge when content exceeds the viewport.

Tabs and any menu UI are still placeholders.

## Intended layout

```text
+---------------------------------------------------------------+
| [<-] [->] [reload] [ address bar (touch/keyboard) ] [ menu ]  |  <- chrome
+---------------------------------------------------------------+
|                                                               |
|                                                               |
|                page area (WebView output)                     |
|                                                               |
|                                                               |
+---------------------------------------------------------------+
```

The page area is the active `WebView`'s canvas output. The chrome row is
drawn before / after the WebView render, depending on whether we composite
into a separate offscreen canvas or directly over the fullscreen one.

## Inputs

- **Touchscreen** (current):
  - Tap the ‹ or › glyph in the chrome strip → back / forward.
  - Tap the URL area in the chrome strip → opens the on-canvas keyboard.
  - Tap an underlined link in the content area → navigates to its href
    (hit-test honors `scrollY`).
  - Tap any key on the open keyboard → activates it.
  - Tap outside the keyboard panel while it's open → dismisses the
    keyboard; if the tap also queued a `navigate` / `back` / `forward`
    / `address-bar` input (because the canvas touch handler fires the
    same event first), the shell skips the redraw and dispatches that
    queued input instead.
- **Controller** (current — shell):
  - **ZR** (rising-edge press) → opens the on-canvas keyboard.
  - **B** (rising-edge) → back. No-op when there's no back history.
  - **X** (rising-edge) → forward. No-op when there's no forward history.
  - **Y** (rising-edge) → reload.
  - **Right stick Y** (analog with 0.15 deadzone, smooth ramp) → scroll
    the current HTML page; clamped to
    `[0, contentBottomY - canvasHeight]`. Up to ~560 px/sec at full
    deflection.
  - **D-pad up / down** (rising-edge) → step scroll 24 px per press.
  - **L + R + Minus** held ~1s → exits the shell. Takes precedence — the
    per-button shortcuts are skipped while the combo is being held so
    they can't accidentally fire.
- **Controller** (current — keyboard open):
  - D-pad / left stick moves focus.
  - **A** activates the focused key.
  - **Y** backspaces.
  - **B** cancels.
  - **+** submits.

The exact bindings live in `src/input/controller-shortcuts.ts` and the
button-index constants live in `src/browser-config.ts`.

## What NOT to put here

- HTTP fetching — that goes through `WebView` + `NativeFetchLoader`.
- Bookmark/history storage — that's `profile/*` and `navigation/*`.
- Permission UI — surface decisions come from `BrowserPermissionPolicy`.
