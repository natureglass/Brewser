#!/usr/bin/env python3
"""Regenerate the catalogue-v2 platform fixtures and run the golden merge test.

Inputs (never modified):
  tests/fixtures/platform/catalogue.v1.live.json — genuine CI-produced v1
      snapshot (dated since the B3 backfill). The v2 example derives from
      it, so fixture dates/sizes ARE the production values — one truth.
      (catalogue.v1.dateless.json is the frozen PRE-backfill snapshot,
      kept solely as the normalizer's dateless-tolerance input; it is NOT
      read here and must never gain dates.)
  D:/Workspace/brewser-apps/apps/<id>/            — real app payloads, walked
      for maxFileBytes (and to cross-check sizeBytes against the snapshot).

Outputs (all under the pinned serialization — see PIN below):
  index-fragment.base.example.json   index-fragment.ext1.example.json
  curation.example.json              catalogue.v2.example.json

Then asserts the golden invariant: merge(fragments, curation) reproduces
catalogue.v2.example.json byte-for-byte. The merge here is the reference
implementation for the future base-CI generator.

PIN (catalogue-v2.md "Serialization"): UTF-8 no BOM, indent=2,
ensure_ascii=False, sort_keys=True, LF line endings, single trailing newline.
Every open() in this file passes encoding='utf-8' explicitly — Windows'
default is cp1252 and mangles the description text silently.
"""

from __future__ import annotations

import html
import json
import re
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[3]
FIXTURES = WORKSPACE / "brewser-v8" / "tests" / "fixtures" / "platform"
APPS_DIR = WORKSPACE / "brewser-apps" / "apps"

SOURCES = {"base": "https://play.brewser.tech", "ext1": "https://play1.brewser.tech"}
DEFAULT_SOURCE = "base"
EXT1_APPS = {"com.natureglass.unitydemoprobe"}
FEATURED = ["com.natureglass.fluiddynamics", "com.natureglass.midilab"]
REVOKED: "list[str]" = []

# Catalogue entry projection (R1): browse/decide fields only.
SLIM_REQUIRED = [
    "id", "name", "version", "entry", "logo", "categories", "compatibility",
    "permissions", "developer", "license",
]
SLIM_OPTIONAL = ["genre", "features", "tags"]

# publishedAt comes straight from the live snapshot (real backfilled
# dates) — a missing date raises KeyError in slim_entry, loudly.

# stats.example.json (C2) — deliberate gaps: speedtest + fractalzoom are
# ABSENT from stats (apps with no counters yet), and ghostapp is a stats
# id with NO catalogue entry (delisted between publications). Values are
# arbitrary but fixed. `ratingScore` is computed below by a CONFORMANCE
# ORACLE for the platform ranking rule (catalogue-v2.md §Top Rated is
# normative): WP's implementation, run over THIS fixture corpus, must
# reproduce these exact numbers. Its PRODUCTION output will differ —
# the empirical mean C depends on the corpus — and that is expected.
STATS = {
    "com.natureglass.fluiddynamics":      {"downloads": 87,  "ratingAvg": 4.2, "ratingCount": 9},
    "com.natureglass.gravityballs":       {"downloads": 54,  "ratingAvg": 3.8, "ratingCount": 4},
    "com.natureglass.midilab":            {"downloads": 412, "ratingAvg": 4.6, "ratingCount": 23},
    "com.natureglass.neuralnetworks":     {"downloads": 61,  "ratingAvg": 5.0, "ratingCount": 1},
    "com.natureglass.savedemo":           {"downloads": 12,  "ratingAvg": 0,   "ratingCount": 0},
    "com.natureglass.sensorsplayground":  {"downloads": 133, "ratingAvg": 4.1, "ratingCount": 11},
    "com.natureglass.spectraplay":        {"downloads": 96,  "ratingAvg": 4.8, "ratingCount": 50},
    "com.natureglass.streamcast":         {"downloads": 71,  "ratingAvg": 2.9, "ratingCount": 7},
    "com.natureglass.unitydemoprobe":     {"downloads": 210, "ratingAvg": 3.5, "ratingCount": 6},
    "com.natureglass.webgl2threejsdemos": {"downloads": 158, "ratingAvg": 4.4, "ratingCount": 17},
    "com.natureglass.ghostapp":           {"downloads": 999, "ratingAvg": 4.9, "ratingCount": 40},
}

# GitHub hard-rejects single files over 100 MiB at push time.
MAX_SINGLE_FILE_BYTES = 100 * 1024 * 1024

# Top Rated prior weight (mirrors the PHP BREWSER_RATING_PRIOR_WEIGHT).
RATING_PRIOR_WEIGHT = 5


def with_rating_scores(stats: dict) -> dict:
    """Conformance oracle for the platform ranking rule (C1).

    The SPEC is normative (catalogue-v2.md §Top Rated); this exists so
    the WP implementation can be verified by running it over the fixture
    corpus and reproducing these numbers. Production scores will differ
    (different corpus → different empirical C) — expected, not drift.

    C = empirical mean of ratingAvg over rated apps (ratingCount >= 1);
    score = (v*R + m*C) / (v + m), rounded to 4 decimals; ratingScore is
    OMITTED for unrated apps (absent = "no data", never 0 or C).
    """
    rated = [s for s in stats.values() if s["ratingCount"] >= 1]
    if not rated:
        return {k: dict(v) for k, v in stats.items()}
    c = sum(s["ratingAvg"] for s in rated) / len(rated)
    out = {}
    for app_id, s in stats.items():
        entry = dict(s)
        v = s["ratingCount"]
        if v >= 1:
            entry["ratingScore"] = round(
                (v * s["ratingAvg"] + RATING_PRIOR_WEIGHT * c) / (v + RATING_PRIOR_WEIGHT), 4)
        out[app_id] = entry
    return out


def dump_pinned(path: Path, obj) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")


def serialize_pinned(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def summarize(desc: str) -> str:
    """R2 summary algorithm — deterministic, character-counted.

    1. strip tags  2. decode entities  3. collapse whitespace  4. <=400 keep
    5. else cut at the last space at-or-before char 400 (hard cut at 399
       if no space, so the ellipsis keeps the result <=400), rstrip,
       append U+2026.
    """
    s = re.sub(r"<[^>]*>", "", desc)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) <= 400:
        return s
    cut = s[:400]
    idx = cut.rfind(" ")
    base = cut[:idx] if idx != -1 else cut[:399]
    return base.rstrip() + "…"


def walk_payload(app_dir: Path) -> "tuple[int, int]":
    """(sizeBytes, maxFileBytes) over non-hidden files — build_catalog.py rules."""
    total = 0
    biggest = 0
    for path in app_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(app_dir)
        if any(p.startswith(".") for p in rel.parts):
            continue
        n = path.stat().st_size
        total += n
        biggest = max(biggest, n)
    return total, biggest


def slim_entry(v1_entry: dict) -> dict:
    out = {}
    for k in SLIM_REQUIRED:
        out[k] = v1_entry[k]
    for k in SLIM_OPTIONAL:
        if k in v1_entry:
            out[k] = v1_entry[k]
    out["summary"] = summarize(v1_entry["description"])
    # C1: manifest-carried; the live snapshot supplies the real
    # backfilled date (KeyError here = a dateless capture, loudly).
    out["publishedAt"] = v1_entry["publishedAt"]
    out["sizeBytes"] = v1_entry["sizeBytes"]
    return out


def build_fragment_entry(v1_entry: dict) -> dict:
    e = slim_entry(v1_entry)
    app_dir = APPS_DIR / v1_entry["id"]
    if not app_dir.is_dir():
        sys.exit(f"error: {app_dir} missing — cannot compute maxFileBytes")
    total, biggest = walk_payload(app_dir)
    if total != v1_entry["sizeBytes"]:
        sys.exit(
            f"error: {v1_entry['id']}: local tree sizeBytes {total} != "
            f"snapshot {v1_entry['sizeBytes']} — refresh catalogue.v1.live.json first"
        )
    if biggest > MAX_SINGLE_FILE_BYTES:
        sys.exit(f"error: {v1_entry['id']}: file of {biggest} bytes exceeds the GitHub 100 MiB push limit")
    e["maxFileBytes"] = biggest
    return e


def merge(fragments: "list[dict]", curation: dict, generated: str) -> dict:
    """Reference implementation of the base-CI merge (catalogue-v2.md §pipeline)."""
    seen: "dict[str, str]" = {}
    apps = []
    for frag in fragments:
        src = frag["source"]
        if src not in SOURCES:
            sys.exit(f"merge error: fragment names unknown source {src!r}")
        for a in frag["apps"]:
            if a["id"] in seen:
                sys.exit(f"merge error: {a['id']} present in fragments {seen[a['id']]!r} and {src!r}")
            seen[a["id"]] = src
            e = {k: v for k, v in a.items() if k != "maxFileBytes"}
            if src != DEFAULT_SOURCE:
                e["source"] = src
            if a["id"] in curation["featured"]:
                e["featured"] = True
            apps.append(e)
    for fid in curation["featured"]:
        if fid not in seen:
            sys.exit(f"merge error: featured id {fid} has no fragment entry")
    # revoked ids are exempt from the presence check (files may be deleted)
    apps.sort(key=lambda e: e["id"])
    return {
        "version": 2,
        "generated": generated,
        "sources": SOURCES,
        "defaultSource": DEFAULT_SOURCE,
        "revoked": curation["revoked"],
        "apps": apps,
    }


def main() -> int:
    v1 = json.load((FIXTURES / "catalogue.v1.live.json").open(encoding="utf-8"))
    generated = v1["generated"]

    base_apps, ext1_apps = [], []
    for a in v1["apps"]:
        (ext1_apps if a["id"] in EXT1_APPS else base_apps).append(build_fragment_entry(a))

    frag_base = {"source": "base", "generated": generated, "apps": base_apps}
    frag_ext1 = {"source": "ext1", "generated": generated, "apps": ext1_apps}
    curation = {"generated": generated, "featured": FEATURED, "revoked": REVOKED}

    dump_pinned(FIXTURES / "index-fragment.base.example.json", frag_base)
    dump_pinned(FIXTURES / "index-fragment.ext1.example.json", frag_ext1)
    dump_pinned(FIXTURES / "curation.example.json", curation)
    # stats.example.json is NOT a golden-test input (operational data,
    # not a function of git state) but is emitted under the same pin for
    # consistency.
    dump_pinned(FIXTURES / "stats.example.json", {"generated": generated, "stats": with_rating_scores(STATS)})

    catalogue = merge([frag_base, frag_ext1], curation, generated)
    dump_pinned(FIXTURES / "catalogue.v2.example.json", catalogue)

    # Golden test: re-load everything from disk and re-merge — the file trip
    # is the point (serialization is part of the contract).
    frags = [
        json.load((FIXTURES / f"index-fragment.{n}.example.json").open(encoding="utf-8"))
        for n in ("base", "ext1")
    ]
    cur = json.load((FIXTURES / "curation.example.json").open(encoding="utf-8"))
    rebuilt = serialize_pinned(merge(frags, cur, generated))
    expected = (FIXTURES / "catalogue.v2.example.json").read_text(encoding="utf-8")
    if rebuilt != expected:
        sys.exit("GOLDEN TEST FAIL: merge(fragments, curation) != catalogue.v2.example.json")

    n = len(catalogue["apps"])
    size = (FIXTURES / "catalogue.v2.example.json").stat().st_size
    print(f"golden test PASS — {n} apps, catalogue.v2.example.json = {size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
