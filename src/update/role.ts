/**
 * src/update/role.ts — config-free boot-role detection for the self-updater.
 *
 * Runs on EVERY boot from main.ts (before the shell). Deliberately imports only
 * `journal` + `paths` — NOT `config` and NOT the crypto/net modules — so a
 * normal boot pays only one statSync (the absent journal) and never evaluates
 * the update config/keyring. The heavy applier is dynamically imported by
 * main.ts only when this returns a non-'normal' role.
 *
 * Role comes from the launch path (argv[0]) + the on-disk journal, NEVER from
 * launch arguments (any argv[1] is an entrypoint override — chainloads are
 * argless). Brewser is a fat NRO, so argv[0] is its own path.
 */
import { type Journal, readJournal } from './journal';
import {
	BREWSER_NRO,
	RECOVERY_ALIAS,
	canonicalizeLaunchPath,
	isUnderUpdate,
	samePath,
} from './paths';

export type UpdaterRole =
	| { kind: 'normal'; selfPath: string }
	| { kind: 'staged'; selfPath: string }
	| { kind: 'recovery'; selfPath: string }
	| { kind: 'post-apply'; selfPath: string; journal: Journal };

export function detectUpdaterRole(): UpdaterRole {
	const raw: string = (Switch.argv && Switch.argv[0]) || '';
	const selfPath = canonicalizeLaunchPath(raw);
	const jr = readJournal();
	const journal: Journal | null = jr.ok ? jr.journal : null;

	// NB: the restore-to-previous system was removed — a leftover
	// brewser-previous.nro launched from hbmenu now falls through to a normal
	// boot (it is just an older Brewser build), and boot-ok deletes it.
	if (samePath(selfPath, RECOVERY_ALIAS)) return { kind: 'recovery', selfPath };
	if (isUnderUpdate(selfPath)) return { kind: 'staged', selfPath };
	if (samePath(selfPath, BREWSER_NRO) && journal?.state === 'applied') {
		return { kind: 'post-apply', selfPath, journal };
	}
	return { kind: 'normal', selfPath };
}
