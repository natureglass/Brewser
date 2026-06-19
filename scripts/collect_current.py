#!/usr/bin/env python3
"""Refresh romfs/configs/current.json from the upstream package.json files.

Reads the `version` field from:
  - D:/Workspace/nxjs-source/packages/runtime/package.json  -> "nx.js"
  - D:/Workspace/brewser-runtime/package.json               -> "runtime"
  - D:/Workspace/brewser/package.json                       -> "brewser"

This produces the immutable "I shipped with these versions" snapshot
that the apps.html Check-for-Updates flow compares against the
remotely-downloaded versions.json. Mirrors the format produced by
brewser-apps/scripts/collect_versions.py so the two files stay
byte-identical at release time.

Versions are written verbatim; the key order is preserved to keep the
diff minimal across runs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CURRENT_PATH = ROOT / "romfs" / "configs" / "current.json"
WORKSPACE = ROOT.parent

SOURCES = (
    ("nx.js", WORKSPACE / "nxjs-source" / "packages" / "runtime" / "package.json"),
    ("runtime", WORKSPACE / "brewser-runtime" / "package.json"),
    ("brewser", WORKSPACE / "brewser" / "package.json"),
)


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
    CURRENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    CURRENT_PATH.write_text(
        json.dumps(versions, indent=4) + "\n",
        encoding="utf-8",
    )
    summary = ", ".join(f"{k}={v}" for k, v in versions.items())
    print(f"wrote {CURRENT_PATH.relative_to(ROOT)}: {summary}")


if __name__ == "__main__":
    main()
