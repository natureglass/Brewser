/**
 * src/update/applier.ts — the pre-shell applier orchestration for the update
 * boot roles. Dynamically imported by main.ts ONLY when the role is non-normal,
 * so config + the crypto/net modules never load on a normal boot.
 *
 * STAGED / RECOVERY / RESTORE run the self-apply and chainload the installed NRO
 * (never return). POST-APPLY confirms the freshly-installed build, stamps
 * current.json, then RETURNS so main.ts continues into the browser shell on the
 * new version.
 *
 * STAGED auto-applies without a second prompt — the user already confirmed the
 * download + chainload in the in-shell modal (the "full auto two-stage" choice).
 * RECOVERY / RESTORE were launched deliberately from hbmenu, so they proceed
 * after a brief visible dwell.
 */
import * as apply from './apply';
import { BREWSER_VERSION } from './config';
import { readJournal } from './journal';
import { getLogFile, initLog, log } from './log';
import { BREWSER_NRO, samePath } from './paths';
import type { UpdaterRole } from './role';
import * as splash from './splash';
import { nextFrames } from './ui';

const DWELL_FRAMES = 150; // ~2.5s at 60fps — long enough to read an error / a deliberate launch

export async function runRole(role: UpdaterRole): Promise<void> {
	const jr = readJournal();
	const journal = jr.ok ? jr.journal : null;
	const inFlight = !!journal && ['staged', 'applying', 'applied'].includes(journal.state);
	const runId = inFlight ? journal!.runId : String(Date.now());
	initLog({
		runId,
		logFile: inFlight ? journal!.logFile : undefined,
		role: role.kind,
		version: BREWSER_VERSION,
	});
	log('applier-boot', { role: role.kind, selfPath: role.selfPath, journalState: journal?.state ?? null });

	switch (role.kind) {
		case 'post-apply': {
			splash.start('Updating Brewser');
			splash.splashUi.status('Confirming update…');
			try {
				await apply.postApplyConfirm(splash.splashUi, role.journal, role.selfPath);
			} catch (err) {
				log('post-apply-error', { err: String(err) });
			}
			splash.stop();
			return; // main.ts continues into the browser shell
		}

		case 'staged': {
			splash.start('Updating Brewser');
			const armed =
				!!journal &&
				(journal.state === 'staged' || journal.state === 'applying') &&
				!!journal.stagedPath &&
				samePath(journal.stagedPath, role.selfPath);
			if (armed) {
				try {
					// selfApply chainloads the installed NRO on success (never returns).
					// It returns only on an idempotent no-op (already installed).
					await apply.selfApply(splash.splashUi, journal!, role.selfPath);
				} catch (err) {
					splash.splashUi.status('Update failed');
					splash.splashUi.progress(-1, String(err));
					log('staged-apply-error', { err: String(err) });
					await nextFrames(DWELL_FRAMES);
				}
			} else {
				splash.splashUi.status('No staged update — booting Brewser…');
				log('staged-no-journal', { journalState: journal?.state ?? null });
				await nextFrames(DWELL_FRAMES);
			}
			// Boot the installed build (recovers a no-op / unarmed staging launch).
			if (Switch.statSync(BREWSER_NRO)) {
				await apply.chainload(BREWSER_NRO);
			}
			splash.stop();
			Switch.exit();
			return;
		}

		case 'recovery': {
			splash.start('Recovering Brewser');
			splash.splashUi.status('Reinstalling this build…');
			await nextFrames(DWELL_FRAMES);
			const j = await apply.buildSelfDerivedJournal(splash.splashUi, runId, getLogFile(), role.selfPath, 'recovery');
			await apply.selfApply(splash.splashUi, j, role.selfPath); // chainloads on success
			if (Switch.statSync(BREWSER_NRO)) await apply.chainload(BREWSER_NRO);
			splash.stop();
			Switch.exit();
			return;
		}

		case 'restore': {
			splash.start('Restoring Brewser');
			splash.splashUi.status('Reinstalling the previous build…');
			await nextFrames(DWELL_FRAMES);
			const j = await apply.buildSelfDerivedJournal(splash.splashUi, runId, getLogFile(), role.selfPath, 'restore');
			await apply.selfApply(splash.splashUi, j, role.selfPath, { allowDowngrade: true }); // chainloads
			if (Switch.statSync(BREWSER_NRO)) await apply.chainload(BREWSER_NRO);
			splash.stop();
			Switch.exit();
			return;
		}
	}
}
