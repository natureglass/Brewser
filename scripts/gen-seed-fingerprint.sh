#!/usr/bin/env bash
# Content fingerprint of the ENTIRE seeded romfs set — every file seedRomfs
# mirrors to the SD profile (shell/ + themes/ + configs/ + root files), MINUS
# the files it explicitly skips. Written to romfs/seed-fingerprint and embedded
# in the NRO.
#
# On boot, src/profile/browser-profile.ts compares this to the copy stored on
# the SD profile:
#   - MATCH  → every seeded file is already present and current, so the whole
#              seed walk is SKIPPED. This is the big boot-time win: the walk is
#              readDir×12 + statSync×181, and on a Switch SD card each statSync
#              is a ~130ms fsdev round-trip, so the no-op walk costs ~23s.
#   - DIFFER → fresh profile or changed bundle: re-seed (app-owned shell/ +
#              themes/ overwritten; configs/ + apps/ missing-only), then store
#              the new fingerprint so the next boot takes the fast path.
#
# CRITICAL: the exclusion list below MUST stay in lockstep with
# SEED_SKIP_DIRS / SEED_SKIP_ROOT_FILES in src/profile/browser-profile.ts. If a
# file is hashed here but NOT seeded (or vice-versa), the fingerprint would flip
# without a corresponding seed and defeat the skip (or a real change would go
# unseeded). The exclusions are:
#   - romfs/emojis/*          (SEED_SKIP_DIRS — 1870 PNGs read lazily from romfs)
#   - romfs/main.js[.map]     (SEED_SKIP_ROOT_FILES — the runtime bundle, in-NRO)
#   - romfs/GeistMono.ttf     (SEED_SKIP_ROOT_FILES — fat-base, nxjs: mount)
#   - romfs/runtime.js.map    (SEED_SKIP_ROOT_FILES — fat-base, nxjs: mount)
#   - romfs/forwarder-stub.nro(SEED_SKIP_ROOT_FILES — read from romfs directly)
#   - romfs/seed-fingerprint  (this file itself — must not hash itself)
#   - romfs/shell/auth/*      (runtime-created login store, never shipped)
#
# Deterministic: sort the file list, hash each file's "sha256  path" line, then
# hash the whole listing. Any content change (or rename) in the seeded set flips
# the fingerprint; an unchanged rebuild reproduces it exactly.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d romfs ]; then
  echo "[seed-fingerprint] romfs/ missing — skipping" >&2
  exit 0
fi

fp="$(
  find romfs -type f \
    -not -path 'romfs/emojis/*' \
    -not -path 'romfs/shell/auth/*' \
    -not -path 'romfs/main.js' \
    -not -path 'romfs/main.js.map' \
    -not -path 'romfs/GeistMono.ttf' \
    -not -path 'romfs/runtime.js.map' \
    -not -path 'romfs/forwarder-stub.nro' \
    -not -path 'romfs/seed-fingerprint' \
    -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | cut -c1-32
)"

printf '%s\n' "$fp" > romfs/seed-fingerprint
echo "[seed-fingerprint] whole seeded romfs -> $fp"
