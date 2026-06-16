/** Look up (and lazy-load) the emoji PNG for a codepoint key. Returns
 * a decoded `HTMLImageElement` on cache hit; `null` while loading or
 * after a permanent load failure. The first miss kicks off an async
 * fetch that bumps the live-tree version + requests a full repaint
 * on load so the next paint draws the now-cached glyph. */
export declare function getEmojiImage(key: string): HTMLImageElement | null;
/** True if `getEmojiImage(key)` has already determined the asset is
 * missing/broken. Atom emitters can use this to fall back to text
 * rendering instead of reserving an invisible emoji box. */
export declare function emojiAssetFailed(key: string): boolean;
/** Try to match an emoji grapheme cluster starting at `s.codePointAt(i)`.
 * Returns the (exclusive) end index in code-units and a filename key
 * (codepoints joined with `-`, stripped of VS-16 and ZWJ) on match;
 * `null` if the character at `i` doesn't start an emoji. */
export declare function matchEmojiClusterAt(s: string, i: number): {
    end: number;
    key: string;
} | null;
/** Cheap pre-filter: does `text` contain any non-ASCII codepoint (and
 * therefore potentially an emoji)? Pure-ASCII runs (the overwhelming
 * majority of text) skip the per-position cluster matcher entirely. */
export declare function textHasEmoji(text: string): boolean;
//# sourceMappingURL=emoji-atlas.d.ts.map