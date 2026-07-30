#!/usr/bin/env bash
# Content fingerprint of the app-owned romfs UI (shell/ + themes/), written to
# romfs/seed-fingerprint and embedded in the NRO.
#
# On boot, src/profile/browser-profile.ts compares this to the copy stored on
# the SD profile and RE-SEEDS shell/ + themes/ (overwriting) when it changed —
# so a rebuilt shell reaches an EXISTING profile without a manual mirror.
# seedRomfs is otherwise missing-only: configs/, apps/, logs/ and the
# runtime-created shell/auth/ are never touched.
#
# Deterministic: sort the file list, hash each file's "sha256  path" line, then
# hash the whole listing. A change to ANY shell/ or themes/ file's content (or a
# rename) flips the fingerprint; an unchanged rebuild reproduces it exactly, so
# there is no needless re-seed. shell/auth/ is excluded (it is runtime-created
# and never shipped in romfs) so it can never perturb the hash.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d romfs/shell ] || [ ! -d romfs/themes ]; then
  echo "[seed-fingerprint] romfs/shell or romfs/themes missing — skipping" >&2
  exit 0
fi

fp="$(
  find romfs/shell romfs/themes -type f -not -path 'romfs/shell/auth/*' -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | cut -c1-32
)"

printf '%s\n' "$fp" > romfs/seed-fingerprint
echo "[seed-fingerprint] romfs/shell + romfs/themes -> $fp"
