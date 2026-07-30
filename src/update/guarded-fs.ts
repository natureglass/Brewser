/**
 * src/update/guarded-fs.ts — the ONLY module allowed to call mutating
 * `Switch.*` FS APIs for the self-updater.
 *
 * Every function here passes its target path(s) through `guardPath()` first
 * (the swap/staging surface), except `writeCurrentJson`, which uses the
 * separate single-file `guardCurrentJson()` because current.json sits under the
 * DENIED configs/ tree. Read-only operations (readFileSync, statSync,
 * file().stream()) are unrestricted and may be called directly elsewhere.
 *
 * ADAPTED from the brewser-updater-test rig's guarded-fs.ts (identical shape;
 * only the added `writeCurrentJson` is new).
 */
import { CURRENT_JSON_PATH, guardCurrentJson, guardPath } from './paths';

export function writeFile(path: string, data: string | BufferSource): void {
	Switch.writeFileSync(guardPath(path), data);
}

export function appendFile(path: string, data: string | BufferSource): void {
	Switch.appendFileSync(guardPath(path), data);
}

export function mkdir(path: string): void {
	Switch.mkdirSync(guardPath(path));
}

export function remove(path: string): void {
	Switch.removeSync(guardPath(path));
}

/** Both endpoints of a rename must be allowed. */
export function rename(from: string, to: string): void {
	Switch.renameSync(guardPath(from), guardPath(to));
}

/** Guarded WritableStream for streaming writes (opens 'w' on first chunk). */
export function writableFor(path: string): WritableStream<BufferSource | string> {
	return Switch.file(guardPath(path)).writable;
}

/** Delete if present; returns true if something was removed. */
export function removeIfExists(path: string): boolean {
	guardPath(path);
	if (Switch.statSync(path)) {
		Switch.removeSync(path);
		return true;
	}
	return false;
}

/**
 * The ONLY writer allowed to touch configs/current.json — the post-apply
 * version stamp. Separate from `guardPath` because current.json lives under the
 * DENIED configs/ tree; routing it through its own single-file guard keeps the
 * swap allow-list clean and makes this one exceptional write auditable.
 */
export function writeCurrentJson(data: string | BufferSource): void {
	Switch.writeFileSync(guardCurrentJson(CURRENT_JSON_PATH), data);
}
