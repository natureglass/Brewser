#!/usr/bin/env python3
"""Refresh romfs/configs/current.json from the upstream package.json files.

Reads the `version` field from (v8-migration siblings — the non-v8
names are the retired pre-rename trees):
  - D:/Workspace/nxjs-extended/packages/runtime/package.json  -> "nx.js"
  - D:/Workspace/brewser-runtime/package.json               -> "runtime"
  - D:/Workspace/brewser/package.json                       -> "brewser"

Also stamps a human-readable `notes` field — the release-notes blurb the
Check-for-Updates modal shows under its "Update Brewser vX.Y.Z" button.
Defaults to DEFAULT_NOTES; override per-release with the
BREWSER_RELEASE_NOTES env var (the Makefile forwards `RELEASE_NOTES=...`).
It is release METADATA, not a version: every consumer that semver-compares
versions.json against current.json must skip this key.

This produces the immutable "I shipped with these versions" snapshot
that the apps.html Check-for-Updates flow compares against the
remotely-downloaded versions.json.

Versions are written verbatim; the key order is preserved to keep the
diff minimal across runs.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CURRENT_PATH = ROOT / "romfs" / "configs" / "current.json"
WORKSPACE = ROOT.parent

SOURCES = (
    ("nx.js", WORKSPACE / "nxjs-extended" / "packages" / "runtime" / "package.json"),
    ("runtime", WORKSPACE / "brewser-runtime" / "package.json"),
    ("brewser", ROOT / "package.json"),
)

# Release-notes blurb shown under the modal's "Update Brewser" button. Kept
# generic on purpose: it is what ships when a release doesn't bother to
# describe itself, so it must read sensibly for ANY build.
DEFAULT_NOTES = "General Brewser improvements"
NOTES_ENV = "BREWSER_RELEASE_NOTES"


def read_notes() -> str:
    """Release notes from $BREWSER_RELEASE_NOTES, else DEFAULT_NOTES.

    A blank/whitespace-only override falls back to the default rather than
    writing an empty string — the modal would otherwise render an empty
    notes line under the Update button.
    """
    override = os.environ.get(NOTES_ENV, "")
    return override.strip() or DEFAULT_NOTES


def read_version(pkg_path: Path) -> str:
    if not pkg_path.is_file():
        sys.exit(f"missing package.json: {pkg_path}")
    try:
        data = json.loads(pkg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"failed to parse {pkg_path}: {exc}")
    version = data.get("version")
    if not isinstance(version, str) or not version:
        sys.exit(f"no usable 'version' field in {pkg_path}")
    return version


def main() -> None:
    versions = {key: read_version(path) for key, path in SOURCES}
    versions["notes"] = read_notes()
    CURRENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    CURRENT_PATH.write_text(
        json.dumps(versions, indent=4) + "\n",
        encoding="utf-8",
    )
    summary = ", ".join(f"{k}={v}" for k, v in versions.items())
    print(f"wrote {CURRENT_PATH.relative_to(ROOT)}: {summary}")


if __name__ == "__main__":
    main()
