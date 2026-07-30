# Brewser-v8 shell + NRO build (V8-MIGRATION FORK)
#
# This Makefile builds the V8-migration variant of brewser. Defaults are
# tuned for that fork: ../brewser-runtime-v8 + ../nxjs-source-v8 siblings.
# The QuickJS-era ../brewser-runtime + ../nxjs-source coexist in this
# workspace as the migration's READ-ONLY reference and are NOT touched
# by this Makefile — see MIGRATION_PLAN.md "Repo / branch topology" in
# nxjs-source-v8 for the topology contract.
#
#   make            # full chain: sync-runtime + current-json + build + nro + sdmc
#   make build      # esbuild bundle only (depends on sync-runtime)
#   make nro        # package brewser.nro (depends on build + current-json),
#                   #   detects EBUSY (Citron lock) and surfaces a friendly error
#   make sdmc       # mirror romfs/ to the Citron SDMC profile (depends on nro)
#   make mirror-only# mirror romfs/ to SDMC WITHOUT rebuilding (romfs-only edits)
#   make current-json
#                   # refresh romfs/configs/current.json from the upstream
#                   #   nxjs-source-v8 / brewser-runtime-v8 / brewser-v8 package.json
#   make sync-runtime
#                   # vendor ../brewser-runtime-v8/dist into runtime/
#                   # (calls node scripts/sync-runtime.mjs directly with
#                   # BREWSER_RUNTIME_DIR forwarded — avoids `npm run`'s
#                   # env-scrubbing trap)
#   make clean      # remove build/, runtime/, brewser.nro (lock-tolerant)
#   make help
#
# Environment requirements:
#   * devkitPro msys2 bash for the nxjs-source-v8 sub-make (`make nro`
#     chains into `make -C $(NXJS_SOURCE_DIR)` which needs devkitARM)
#   * npm on PATH for `runtime-build` + `npm run nro`. devkitPro msys2's
#     PATH does NOT include nvm-installed Node by default; the recipe
#     for invocation from a fresh msys2 shell is:
#         export PATH=/c/nvm4w/nodejs:$PATH    # or wherever npm lives
#         make -C /d/Workspace/brewser-v8 nro
#
# Overrides (sibling paths are `?=` so env can override; needed only if
# the worktree layout diverges from the standard side-by-side topology):
#   PYTHON=py                Use the Windows 'py' launcher instead of 'python'
#   SDMC_DEST=...            Point the sdmc mirror at a different Citron profile
#   BREWSER_RUNTIME_DIR=...  Override the brewser-runtime sibling path
#   NXJS_SOURCE_DIR=...      Override the nxjs-source sibling path

PYTHON ?= python
SDMC_DEST ?= C:/Users/NatureGlass/AppData/Roaming/citron/sdmc/switch/brewser

CURRENT_JSON      := romfs/configs/current.json
BREWSER_PKG       := package.json
# V8-migration fork: defaults point at the -v8 sibling checkouts. The
# QuickJS-era ../brewser-runtime + ../nxjs-source live in this workspace
# too, but they are the migration's READ-ONLY reference (see
# MIGRATION_PLAN.md "Repo / branch topology" in nxjs-source-v8) and must
# NOT be built from. Use `?=` so a future shared/dual-fork build can
# override at invocation; the immediate `:=` shape in the upstream
# brewser/Makefile couldn't be env-overridden, which made cross-fork
# experimentation harder than it needed to be.
BREWSER_RUNTIME_PKG ?= ../brewser-runtime-v8/package.json
NXJS_PKG          ?= ../nxjs-source-v8/packages/runtime/package.json
COLLECT_CURRENT   := scripts/collect_current.py

NRO               := brewser.nro
NRO_LOG           := .nro-build.log
# Release output dir. `dist/` maps to the `dist/` folder at the root of the
# natureglass/Brewser repo, which raw.githubusercontent.com serves for the
# self-updater. `make release` lands brewser.nro here (see the `release` target).
DIST_DIR          ?= dist
# The sibling brewser-apps checkout — `make release` writes its versions.json
# (served at play.brewser.tech/versions.json), which the runtime string-compares
# against the installed current.json to recognize a new build. Mirrors
# romfs/configs/current.json exactly (also fixes the stale collect_versions.py).
BREWSER_APPS_DIR  ?= ../brewser-apps
VERSIONS_JSON     := $(BREWSER_APPS_DIR)/versions.json
# natureglass/Brewser branch the client downloads from. Keep == src/update/
# config.ts RELEASE_REF. (Moving off v8-migration → main.)
RELEASE_BRANCH    ?= main

# nxjs runtime build + overlay. nxjs-source-v8 produces nxjs.nro, which
# the `nxjs-nro` packager (invoked by `npm run nro`) pulls from
# node_modules/@nx.js/nro/dist/ as the runtime image. Without an explicit
# overlay step, edits to nxjs C/TS source never reach brewser.nro.
#
# V8-migration default: ../nxjs-source-v8 (the v8-migration worktree).
# ../nxjs-source is the QuickJS-era READ-ONLY reference and must NOT be
# the default for this fork — see [[reference-brewser-v8-sync-runtime-env-loss]]
# for an example of how the wrong sibling-default silently shipped stale
# code through the build chain before this Makefile was forked.
# Skipped if the configured dir is missing (consumers without the
# sibling checkout still get `make` to succeed via the postinstall path).
NXJS_SOURCE_DIR   ?= ../nxjs-source-v8
NXJS_SOURCE_NRO   := $(NXJS_SOURCE_DIR)/nxjs.nro
NXJS_OVERLAY      := node_modules/@nx.js/nro/dist/nxjs.nro

.PHONY: all runtime-build sync-runtime check-endpoints typecheck current-json seed-fingerprint build nro sdmc mirror-only clean help nxjs-runtime release bump

# Default target is now a full self-update RELEASE (bump + sign → dist/), since
# the primary workflow is producing installable/updatable builds. For the
# Citron dev loop (no version bump, mirrors romfs/ to the emulator) run
# `make sdmc` explicitly.
all: release

# Build the sibling brewser-runtime workspace so its `dist/` is fresh
# before `sync-runtime` copies it. Without this, `make sdmc` would happily
# vendor a stale dist and the NRO would ship pre-edit runtime code — the
# kind of silent-staleness bug that's painful to track down.
# V8-migration default: ../brewser-runtime-v8. ../brewser-runtime is the
# production runtime tree (used by brewser/Makefile, not this fork).
# Skipped if `BREWSER_RUNTIME_DIR` is missing (consumers without the
# sibling checkout still need `make` to succeed via the postinstall path).
BREWSER_RUNTIME_DIR ?= ../brewser-runtime-v8
runtime-build:
	@if [ -d "$(BREWSER_RUNTIME_DIR)" ]; then \
		echo "Building $(BREWSER_RUNTIME_DIR)/dist/..."; \
		cd "$(BREWSER_RUNTIME_DIR)" && npm run build; \
	else \
		echo "[runtime-build] $(BREWSER_RUNTIME_DIR) missing — skipping (will vendor whatever dist/ is currently there)"; \
	fi

# sync-runtime: vendor the freshly-built dist/ into brewser-v8/runtime/.
# Calls node directly with BREWSER_RUNTIME_DIR explicitly forwarded so the
# env survives the recipe boundary. Prior shape `@npm run sync-runtime`
# dropped BREWSER_RUNTIME_DIR through the `npm run` invocation (npm's env
# scrubbing for non-npm_*  vars varies by node version + Windows path
# munging), silently falling back to the `?=` default and mirroring the
# WRONG dist — symptom was edits-to-runtime-don't-reach-NRO with a clean
# build log. See [[reference-brewser-v8-sync-runtime-env-loss]] for the
# original diagnostic; this rewrite cures it at the source instead of
# requiring callers to run the sync manually.
sync-runtime: runtime-build
	@BREWSER_RUNTIME_DIR="$(BREWSER_RUNTIME_DIR)" node scripts/sync-runtime.mjs

# Endpoint-parity guard: the endpoint constants exist in three copies
# (engine src, engine dist, shell vendored dist) and Phase 0 of the
# platform adaptation caught the dist pair shipping stale URLs while the
# source was already fixed. Fails the build on any disagreement.
check-endpoints: sync-runtime
	@BREWSER_RUNTIME_DIR="$(BREWSER_RUNTIME_DIR)" node scripts/check-endpoint-parity.mjs

# Shell typecheck (tsc 5.2.2, local devDependency since Phase 1c).
# Needs the vendored runtime types, hence the sync-runtime dep. esbuild
# does NOT typecheck, so without this gate type rot ships silently —
# same defect class as the vendored-dist drift.
typecheck: sync-runtime
	@npm run typecheck

# File target: re-runs only when an upstream package.json (or the
# collector script itself) changes. The phony `current-json` alias lets
# callers spell the intent without remembering the output path.
$(CURRENT_JSON): $(BREWSER_PKG) $(BREWSER_RUNTIME_PKG) $(NXJS_PKG) $(COLLECT_CURRENT)
	@$(PYTHON) $(COLLECT_CURRENT)

current-json: $(CURRENT_JSON)

# Content fingerprint of the app-owned romfs (shell/ + themes/) → romfs/seed-
# fingerprint, embedded in the NRO. browser-profile.ts re-seeds those trees on
# an EXISTING profile when the fingerprint changes (seedRomfs is otherwise
# missing-only, so edited pages/scripts/styles never replaced the stale on-disk
# copies without a manual mirror). Regenerated every package so it always
# matches the romfs being shipped.
seed-fingerprint:
	@bash scripts/gen-seed-fingerprint.sh

build: sync-runtime check-endpoints typecheck
	@npm run build

# nx.js runtime build MOVED to Makefile_nxjs — it needs the devkitPro toolchain,
# whereas this Makefile's release build is pure Node (esbuild + the nxjs-nro
# packager, reusing the prebuilt nxjs.nro base). The self-updater is
# zero-engine-delta, so nx.js rarely changes. If you edited nx.js C/TS source,
# rebuild + overlay it FIRST:  make -f Makefile_nxjs
nxjs-runtime:
	@echo "nx.js runtime build lives in Makefile_nxjs now (it needs devkitPro)."
	@echo "If you changed nx.js source, run:  make -f Makefile_nxjs"
	@echo "Then re-run your main-Makefile target. (The updater is zero-engine-delta,"
	@echo "so for updater/shell changes you can skip this entirely.)"
	@exit 1

# `npm run nro` writes brewser.nro. Citron keeps an exclusive lock on
# the NRO while the app is open, so the write fails with EBUSY. We
# capture all output, replay it, and on a non-zero exit specifically
# match EBUSY to surface a clear "close Citron" message. Non-EBUSY
# failures fall through with the original npm output preserved.
nro: build current-json seed-fingerprint
	@npm run nro > $(NRO_LOG) 2>&1; \
	status=$$?; \
	cat $(NRO_LOG); \
	if [ $$status -ne 0 ] && grep -q "EBUSY" $(NRO_LOG); then \
		echo ""; \
		echo "ERROR: $(NRO) is locked by Citron."; \
		echo "Close Citron and re-run 'make nro'."; \
	fi; \
	rm -f $(NRO_LOG); \
	exit $$status

# Mirror romfs/ verbatim into the Citron SDMC profile. The seedRomfs
# walker on next boot is skip-if-exists, so without this step stale
# SDMC copies hide fresh romfs edits — see
# [[feedback-sync-to-citron-sdmc]] in the workspace memory. Full mirror
# (including configs/) is intentional — user accepts the catalogue /
# config reset.
sdmc: nro mirror-only

mirror-only:
	@echo "Mirroring romfs/ to $(SDMC_DEST)/"
	@mkdir -p "$(SDMC_DEST)"
	@cp -r romfs/* "$(SDMC_DEST)/"

# Release build for the self-updater: full NRO packaging (with the baked
# version/counter/keyring via the --define build), output to $(DIST_DIR)/ for
# publishing to natureglass/Brewser. Does NOT mirror to Citron (this NRO is for
# real hardware / the update server, not the emulator). Sign + verify after:
#   node scripts/update/make-manifest.mjs $(DIST_DIR)/$(NRO) <ver> <counter> \
#     https://raw.githubusercontent.com/natureglass/Brewser/main/$(DIST_DIR)/$(NRO) $(DIST_DIR)
#   node scripts/update/verify-release.mjs
# Bump package.json version + scripts/update/build-info.json counter (strictly
# increasing, matching the manifest counter) before each real release.
# Bump the release version + build counter (patch version + counter+1). Runs as
# the first step of every `release`, so each build is a new, recognizable,
# strictly-newer version. See scripts/bump-version.mjs.
bump:
	@node scripts/bump-version.mjs

# Full self-update RELEASE (the default target). In one go:
#   1. bump  package.json version + build-info counter
#   2. nro   build the bundle (bakes the new version/counter/keyring via
#            scripts/build-main.mjs) + regen current.json + seed-fingerprint +
#            package the fat NRO (reusing the prebuilt nxjs.nro base — see
#            Makefile_nxjs for the runtime build)
#   3. mirror current.json → the served versions.json (in ../brewser-apps)
#   4. move the NRO into dist/, sign the manifest, and verify the console would
#      accept it.
# Does NOT rebuild nx.js and does NOT mirror to Citron (this NRO is for real
# hardware / the update server). `bump` is a prerequisite so it completes before
# the recursive `nro` build picks up the new version.
release: bump
	@$(MAKE) nro
	@echo "[release] mirroring current.json → $(VERSIONS_JSON)"
	@mkdir -p "$(BREWSER_APPS_DIR)"
	@cp romfs/configs/current.json "$(VERSIONS_JSON)"
	@mkdir -p "$(DIST_DIR)"
	@mv -f $(NRO) "$(DIST_DIR)/$(NRO)"
	@node scripts/update/sign-release.mjs
	@node scripts/update/verify-release.mjs
	@echo ""
	@echo "[release] DONE ($(RELEASE_BRANCH)). Publish:"
	@echo "  • push $(DIST_DIR)/$(NRO) + $(DIST_DIR)/update.json to natureglass/Brewser"
	@echo "  • push $(VERSIONS_JSON) to brewser-apps (served at play.brewser.tech/versions.json)"

clean:
	rm -rf build/ runtime/
	-rm -f $(NRO)

help:
	@echo "brewser-v8 Makefile (V8-migration fork). Defaults to ../brewser-runtime-v8 + ../nxjs-source-v8."
	@echo ""
	@echo "Targets:"
	@echo "  make / make release"
	@echo "                   FULL SELF-UPDATE RELEASE (default): bump version+counter,"
	@echo "                   build (bakes version/counter/keyring), package the NRO into"
	@echo "                   $(DIST_DIR)/, update $(VERSIONS_JSON), sign + verify the manifest."
	@echo "                   Each run is a NEW, strictly-newer version. Push dist/ to"
	@echo "                   natureglass/Brewser and versions.json to brewser-apps."
	@echo "  make bump        Bump version + counter only (scripts/bump-version.mjs)"
	@echo "  make sdmc        Citron dev loop: build + mirror romfs/ to SDMC (NO bump/sign)"
	@echo "  make mirror-only Mirror romfs/ to SDMC without rebuilding"
	@echo "  make nro         Package $(NRO) at repo root (build + current-json + seed-fingerprint)"
	@echo "  make build       esbuild bundle with baked defines (depends on sync-runtime)"
	@echo "  make current-json  Refresh $(CURRENT_JSON) from upstream package.json files"
	@echo "  make clean       Remove build/, runtime/, $(NRO)"
	@echo ""
	@echo "  nx.js runtime (needs devkitPro; separate — updater is zero-engine-delta):"
	@echo "  make -f Makefile_nxjs   Rebuild nxjs.nro + overlay into node_modules"
	@echo ""
	@echo "Current sibling defaults:"
	@echo "  BREWSER_RUNTIME_DIR = $(BREWSER_RUNTIME_DIR)"
	@echo "  NXJS_SOURCE_DIR     = $(NXJS_SOURCE_DIR)"
	@echo ""
	@echo "Overrides:"
	@echo "  PYTHON=py                Use the Windows 'py' launcher instead of 'python'"
	@echo "  SDMC_DEST=...            Point the sdmc mirror at a different Citron profile"
	@echo "  BREWSER_RUNTIME_DIR=...  Override the brewser-runtime sibling path"
	@echo "  NXJS_SOURCE_DIR=...      Override the nxjs-source sibling path"
