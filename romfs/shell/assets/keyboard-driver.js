/*
 * keyboard-driver.js — page-side glue for the HTML virtual keyboard.
 *
 * Reserved as the named home for any future page-side script the
 * keyboard wants to expose. Currently empty: the keyboard's live-DOM
 * tree is parsed once at shell startup with its `<script>` blocks
 * stripped (live-DOM doesn't model selectionStart / focus / etc., so
 * the original inline script in keyboard.html can't run there), and
 * the key-tap dispatch + value/cursor state both live in the shell at
 * src/input/keyboard-overlay.ts.
 *
 * If a future iteration runs page scripts in the kb root (e.g. for
 * locale-driven layout swaps or cascade-friendly key remapping), this
 * file will be the entry point — kept in BUILTIN_ASSETS so it ships
 * with every profile and the file slot is reserved.
 */
