/**
 * src/update/log.ts — UI-agnostic NDJSON event log for the self-updater.
 *
 * Unlike the rig's log.ts, there is NO on-screen ring buffer here (Brewser's UI
 * is the shell's own; progress reaches the user via the caller's callbacks).
 * This module only: (1) appends one NDJSON line per event to a per-run log file
 * under `update/logs/` so an update's timeline survives chainloads, and (2)
 * mirrors to console.debug. All file I/O is best-effort — logging must never
 * throw into the update flow.
 */
import * as gfs from './guarded-fs';
import { underUpdate } from './paths';

let seq = 0;
let runId = '0';
let role = '(unset)';
let version = '(unset)';
let logFile = underUpdate('logs/run-0.ndjson');

export function initLog(opts: { runId: string; logFile?: string; role: string; version: string }): void {
	runId = opts.runId;
	role = opts.role;
	version = opts.version;
	logFile = opts.logFile ?? underUpdate(`logs/run-${runId}.ndjson`);
	try {
		gfs.mkdir(underUpdate('logs'));
	} catch {
		/* best-effort */
	}
	log('log-init', { runId, role, version, logFile });
}

export function getLogFile(): string {
	return logFile;
}

export function log(type: string, data?: Record<string, unknown>): void {
	const evt = {
		seq: seq++,
		t: Date.now(),
		pt: Math.round(performance.now() * 1000) / 1000,
		run: runId,
		role,
		version,
		type,
		...(data ?? {}),
	};
	try {
		console.debug(`[update] ${type} ${data ? JSON.stringify(data) : ''}`);
	} catch {
		/* console may be unavailable mid-teardown */
	}
	try {
		gfs.appendFile(logFile, JSON.stringify(evt) + '\n');
	} catch {
		/* best-effort; a full/absent card must not crash the flow */
	}
}

/** A transient status line — logged as an event; the visible status is the
 * caller's UI concern (driven by progress callbacks). */
export function status(message: string): void {
	log('status', { message });
}

/** Start a timing span; call the returned fn to log its duration in ms. */
export function span(label: string): (extra?: Record<string, unknown>) => void {
	const t0 = performance.now();
	return (extra?: Record<string, unknown>) => {
		log('span', { label, ms: Math.round((performance.now() - t0) * 1000) / 1000, ...(extra ?? {}) });
	};
}
