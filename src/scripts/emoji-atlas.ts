// =========================================================================
// Emoji atlas — Twemoji PNG bundle served from `romfs:/emojis/`.
// =========================================================================
//
// Detection (matchEmojiClusterAt) — uses Unicode property escapes
// (\p{Extended_Pictographic}, \p{Regional_Indicator}) plus explicit
// handling of the joiners that build composite clusters:
//   - VS-16 (U+FE0F): forces emoji presentation on dual-use codepoints
//     like 2764 ❤  / 270C ✌ . Stripped from the filename key.
//   - ZWJ (U+200D): joins multiple base emoji into one cluster (family
//     sequences, profession sequences). Also stripped from the key.
//   - Skin-tone modifiers (1F3FB–1F3FF): follow a base in tone-sequence
//     clusters. Kept in the key.
//   - Combining keycap (U+20E3): combines with [0-9#*] (optionally
//     preceded by FE0F) to form keycap emoji.
//
// The codepoint key is lowercase hex codepoints joined by `-`, matching
// the bundled filename convention (e.g. `1f600.png`, `1f468-1f469-1f466.png`,
// `1f1fa-1f1f8.png`).
//
// Loading — `getEmojiImage(key)` returns a cached decoded Image on hit,
// triggers a one-shot async fetch on first reference, and returns null
// while loading / on permanent failure. The onload handler bumps the
// live-tree version and requests a full repaint so the page picks up
// the newly-decoded glyph on the next frame.

import { bumpLiveTreeVersion } from './live-dom.js';
import { requestFullRepaint } from './live-paint-control.js';

type CacheEntry =
	| { kind: 'loading' }
	| { kind: 'ready'; img: HTMLImageElement }
	| { kind: 'failed' };

const cache = new Map<string, CacheEntry>();

/** Look up (and lazy-load) the emoji PNG for a codepoint key. Returns
 * a decoded `HTMLImageElement` on cache hit; `null` while loading or
 * after a permanent load failure. The first miss kicks off an async
 * fetch that bumps the live-tree version + requests a full repaint
 * on load so the next paint draws the now-cached glyph. */
export function getEmojiImage(key: string): HTMLImageElement | null {
	const existing = cache.get(key);
	if (existing) {
		return existing.kind === 'ready' ? existing.img : null;
	}
	cache.set(key, { kind: 'loading' });
	try {
		const img: HTMLImageElement = new (globalThis as unknown as {
			Image: new () => HTMLImageElement;
		}).Image();
		img.onload = () => {
			cache.set(key, { kind: 'ready', img });
			bumpLiveTreeVersion();
			requestFullRepaint();
		};
		img.onerror = () => {
			cache.set(key, { kind: 'failed' });
		};
		img.src = `romfs:/emojis/${key}.png`;
	} catch (_) {
		cache.set(key, { kind: 'failed' });
	}
	return null;
}

/** True if `getEmojiImage(key)` has already determined the asset is
 * missing/broken. Atom emitters can use this to fall back to text
 * rendering instead of reserving an invisible emoji box. */
export function emojiAssetFailed(key: string): boolean {
	const e = cache.get(key);
	return e?.kind === 'failed';
}

// -----------------------------------------------------------------------
// Cluster detection
// -----------------------------------------------------------------------
//
// Strategy: at position `i`, peek the codepoint. If it isn't a plausible
// emoji starter, bail out. Otherwise greedily extend through:
//   - Optional VS-16 (FE0F) after a base
//   - Optional skin-tone modifier (1F3FB–1F3FF) after a base
//   - Optional combining-keycap (20E3) closing a keycap cluster
//   - Optional ZWJ + next emoji codepoint (repeatable) for ZWJ sequences
//
// We do NOT enumerate the full Unicode Emoji_Sequences table — the
// asset filename strip (no FE0F, no 200D) tolerates a wider match,
// and `emojiAssetFailed` flips the atom back to text if the bundle
// doesn't have a matching PNG.
//
// Note on regional indicators: a flag emoji is two consecutive
// regional-indicator codepoints (1F1E6–1F1FF). They're NOT
// Extended_Pictographic on their own, so we handle them as a special
// case at the top of `matchEmojiClusterAt`.

const ZWJ = 0x200D;
const VS16 = 0xFE0F;
const KEYCAP_COMBINING = 0x20E3;

function isEmojiBase(cp: number): boolean {
	// Single-codepoint emoji starters cover most of what the bundle
	// renders. We use Extended_Pictographic for the broad class.
	// Keycap bases (digits / # / *) are NOT included here — a bare ASCII
	// digit isn't an emoji on its own, only the 3-codepoint keycap
	// sequence (DIGIT VS-16? KEYCAP_COMBINING) is. The keycap path is
	// handled as a special case at the top of matchEmojiClusterAt so we
	// don't mis-tokenize ordinary numbers into emoji atoms.
	//
	// Regional indicators (1F1E6–1F1FF) are also excluded — they're
	// handled as a pair (flag emoji) at the top of matchEmojiClusterAt.
	if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return false;
	const ch = String.fromCodePoint(cp);
	return /\p{Extended_Pictographic}/u.test(ch);
}

function isKeycapBase(cp: number): boolean {
	// 0030–0039 (digits), 0023 (#), 002A (*) — the only ASCII chars
	// that combine with U+20E3 to form keycap emoji.
	return cp === 0x23 || cp === 0x2A || (cp >= 0x30 && cp <= 0x39);
}

function isRegionalIndicator(cp: number): boolean {
	return cp >= 0x1F1E6 && cp <= 0x1F1FF;
}

function isSkinTone(cp: number): boolean {
	return cp >= 0x1F3FB && cp <= 0x1F3FF;
}

function cpLen(cp: number): number {
	return cp > 0xFFFF ? 2 : 1;
}

/** Try to match an emoji grapheme cluster starting at `s.codePointAt(i)`.
 * Returns the (exclusive) end index in code-units and a filename key
 * (codepoints joined with `-`, stripped of VS-16 and ZWJ) on match;
 * `null` if the character at `i` doesn't start an emoji. */
export function matchEmojiClusterAt(
	s: string,
	i: number,
): { end: number; key: string } | null {
	if (i >= s.length) return null;
	const firstCp = s.codePointAt(i);
	if (firstCp === undefined) return null;

	// Regional-indicator pair (country flag).
	if (isRegionalIndicator(firstCp)) {
		const j = i + cpLen(firstCp);
		if (j < s.length) {
			const secondCp = s.codePointAt(j);
			if (secondCp !== undefined && isRegionalIndicator(secondCp)) {
				return { end: j + cpLen(secondCp), key: hexKey([firstCp, secondCp]) };
			}
		}
		return null;
	}

	// Keycap sequence: <DIGIT|#|*> [VS-16]? <U+20E3>. Only a closed
	// 3-codepoint cluster counts — a bare digit must NOT be matched as
	// an emoji (it would break ordinary number tokenization). Confirm
	// the U+20E3 terminator is present before committing.
	if (isKeycapBase(firstCp)) {
		let j = i + 1;
		if (j < s.length && s.charCodeAt(j) === VS16) j += 1;
		if (j < s.length && s.charCodeAt(j) === KEYCAP_COMBINING) {
			return { end: j + 1, key: hexKey([firstCp, KEYCAP_COMBINING]) };
		}
		// Not a keycap — treat as ordinary text.
		return null;
	}

	if (!isEmojiBase(firstCp)) return null;

	const kept: number[] = [firstCp];
	let j = i + cpLen(firstCp);

	while (j < s.length) {
		const cp = s.codePointAt(j);
		if (cp === undefined) break;
		if (cp === VS16) {
			// Variation selector — consumed but not part of the key.
			j += 1;
			continue;
		}
		if (cp === KEYCAP_COMBINING) {
			kept.push(cp);
			j += 1;
			// Keycap closes the cluster.
			break;
		}
		if (isSkinTone(cp)) {
			kept.push(cp);
			j += cpLen(cp);
			continue;
		}
		if (cp === ZWJ) {
			// ZWJ extends only if followed by another emoji base.
			const after = s.codePointAt(j + 1);
			if (after === undefined) break;
			if (isEmojiBase(after) || isRegionalIndicator(after)) {
				j += 1;
				kept.push(after);
				j += cpLen(after);
				continue;
			}
			break;
		}
		break;
	}

	return { end: j, key: hexKey(kept) };
}

/** Twemoji filename convention: each codepoint in lowercase hex,
 * minimum 4 digits (so U+00A9 → `00a9`, U+1F600 → `1f600`), joined
 * with `-` for multi-codepoint clusters. */
function hexKey(cps: readonly number[]): string {
	let out = '';
	for (let k = 0; k < cps.length; k++) {
		if (k > 0) out += '-';
		const h = cps[k].toString(16);
		out += h.length < 4 ? '0'.repeat(4 - h.length) + h : h;
	}
	return out;
}

/** Cheap pre-filter: does `text` contain any non-ASCII codepoint (and
 * therefore potentially an emoji)? Pure-ASCII runs (the overwhelming
 * majority of text) skip the per-position cluster matcher entirely. */
export function textHasEmoji(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) >= 0x80) return true;
	}
	return false;
}
