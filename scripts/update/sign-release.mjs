#!/usr/bin/env node
/**
 * scripts/update/sign-release.mjs — sign the current dist/brewser.nro using the
 * version (package.json) + counter (scripts/update/build-info.json) baked into
 * it, and the natureglass/Brewser release URL. Thin wrapper over
 * make-manifest.mjs so there is one signer + one never-reused-counter guard.
 *
 * BRANCH must stay in sync with src/update/config.ts RELEASE_REF (the client's
 * AUTHORITATIVE download source; the manifest's own url is advisory). Override
 * for a one-off with BREWSER_RELEASE_BRANCH=<branch>.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const counter = JSON.parse(readFileSync(join(root, 'scripts', 'update', 'build-info.json'), 'utf8')).counter;

const branch = process.env.BREWSER_RELEASE_BRANCH || 'main';
const url = `https://raw.githubusercontent.com/natureglass/Brewser/${branch}/dist/brewser.nro`;

console.log(`[sign-release] version ${version} counter ${counter} branch ${branch}`);
execFileSync('node', [
	join(root, 'scripts', 'update', 'make-manifest.mjs'),
	join(root, 'dist', 'brewser.nro'),
	String(version),
	String(counter),
	url,
	join(root, 'dist'),
], { cwd: root, stdio: 'inherit' });
