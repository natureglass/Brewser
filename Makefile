# Brewser shell + NRO build
#
#   make            # full chain: sync-runtime + current-json + build + nro + sdmc
#   make build      # esbuild bundle only (depends on sync-runtime)
#   make nro        # package brewser.nro (depends on build + current-json),
#                   #   detects EBUSY (Citron lock) and surfaces a friendly error
#   make sdmc       # mirror romfs/ to the Citron SDMC profile (depends on nro)
#   make mirror-only# mirror romfs/ to SDMC WITHOUT rebuilding (romfs-only edits)
#   make current-json
#                   # refresh romfs/configs/current.json from the upstream
#                   #   nxjs / brewser-runtime / brewser package.json files
#   make sync-runtime
#                   # vendor ../brewser-runtime/dist into runtime/
#   make clean      # remove build/, runtime/, brewser.nro (lock-tolerant)
#   make help
#
# Overrides:
#   PYTHON=py       Use the Windows 'py' launcher instead of 'python'
#   SDMC_DEST=...   Point the sdmc mirror at a different Citron profile

PYTHON ?= python
SDMC_DEST ?= C:/Users/NatureGlass/AppData/Roaming/citron/sdmc/switch/brewser

CURRENT_JSON      := romfs/configs/current.json
BREWSER_PKG       := package.json
BREWSER_RUNTIME_PKG := ../brewser-runtime/package.json
NXJS_PKG          := ../nxjs-source/packages/runtime/package.json
COLLECT_CURRENT   := scripts/collect_current.py

NRO               := brewser.nro
NRO_LOG           := .nro-build.log

# nxjs runtime build + overlay. nxjs-source produces nxjs.nro, which the
# `nxjs-nro` packager (invoked by `npm run nro`) pulls from
# node_modules/@nx.js/nro/dist/ as the runtime image. Without an explicit
# overlay step, edits to nxjs C/TS source never reach brewser.nro.
# Skipped if ../nxjs-source is missing (consumers without the sibling checkout).
NXJS_SOURCE_DIR   ?= ../nxjs-source
NXJS_SOURCE_NRO   := $(NXJS_SOURCE_DIR)/nxjs.nro
NXJS_OVERLAY      := node_modules/@nx.js/nro/dist/nxjs.nro

.PHONY: all runtime-build sync-runtime current-json build nro sdmc mirror-only clean help nxjs-runtime

all: sdmc

# Build the sibling brewser-runtime workspace so its `dist/` is fresh
# before `sync-runtime` copies it. Without this, `make sdmc` would happily
# vendor a stale dist and the NRO would ship pre-edit runtime code — the
# kind of silent-staleness bug that's painful to track down.
# Skipped if `BREWSER_RUNTIME_DIR` is missing (consumers without the
# sibling checkout still need `make` to succeed via the postinstall path).
BREWSER_RUNTIME_DIR ?= ../brewser-runtime
runtime-build:
	@if [ -d "$(BREWSER_RUNTIME_DIR)" ]; then \
		echo "Building $(BREWSER_RUNTIME_DIR)/dist/..."; \
		cd "$(BREWSER_RUNTIME_DIR)" && npm run build; \
	else \
		echo "[runtime-build] $(BREWSER_RUNTIME_DIR) missing — skipping (will vendor whatever dist/ is currently there)"; \
	fi

sync-runtime: runtime-build
	@npm run sync-runtime

# File target: re-runs only when an upstream package.json (or the
# collector script itself) changes. The phony `current-json` alias lets
# callers spell the intent without remembering the output path.
$(CURRENT_JSON): $(BREWSER_PKG) $(BREWSER_RUNTIME_PKG) $(NXJS_PKG) $(COLLECT_CURRENT)
	@$(PYTHON) $(COLLECT_CURRENT)

current-json: $(CURRENT_JSON)

build: sync-runtime
	@npm run build

# Build nxjs.nro from ../nxjs-source and overlay it into brewser's
# node_modules so the next `npm run nro` packs the freshly-built runtime
# instead of the vendored copy. Always invokes the nxjs Makefile (it's
# incremental — recompiles only changed translation units). `cmp -s`
# skips the cp when bytes haven't changed (cheap stat-only check after
# a no-op nxjs make).
nxjs-runtime:
	@if [ -d "$(NXJS_SOURCE_DIR)" ]; then \
		echo "Building $(NXJS_SOURCE_DIR) (nxjs.nro)..."; \
		$(MAKE) -C "$(NXJS_SOURCE_DIR)" || { \
			echo "ERROR: nxjs-source build failed — aborting before brewser packaging picks up stale nxjs.nro"; \
			exit 1; \
		}; \
		if [ -f "$(NXJS_SOURCE_NRO)" ]; then \
			if cmp -s "$(NXJS_SOURCE_NRO)" "$(NXJS_OVERLAY)" 2>/dev/null; then \
				echo "[nxjs-runtime] $(NXJS_OVERLAY) already up to date"; \
			else \
				echo "Overlaying $(NXJS_SOURCE_NRO) -> $(NXJS_OVERLAY)"; \
				cp "$(NXJS_SOURCE_NRO)" "$(NXJS_OVERLAY)" || exit 1; \
			fi; \
		else \
			echo "ERROR: $(NXJS_SOURCE_NRO) not produced by nxjs make"; \
			exit 1; \
		fi; \
	else \
		echo "[nxjs-runtime] $(NXJS_SOURCE_DIR) missing - skipping (using vendored $(NXJS_OVERLAY))"; \
	fi

# `npm run nro` writes brewser.nro. Citron keeps an exclusive lock on
# the NRO while the app is open, so the write fails with EBUSY. We
# capture all output, replay it, and on a non-zero exit specifically
# match EBUSY to surface a clear "close Citron" message. Non-EBUSY
# failures fall through with the original npm output preserved.
nro: build current-json nxjs-runtime
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

clean:
	rm -rf build/ runtime/
	-rm -f $(NRO)

help:
	@echo "Targets:"
	@echo "  make             Full chain (runtime-build + sync-runtime + current-json + build + nro + sdmc)"
	@echo "  make runtime-build"
	@echo "                   Build ../brewser-runtime so its dist/ is fresh"
	@echo "  make sync-runtime"
	@echo "                   Vendor ../brewser-runtime/dist into runtime/ (depends on runtime-build)"
	@echo "  make current-json"
	@echo "                   Refresh $(CURRENT_JSON) from upstream package.json files"
	@echo "  make nxjs-runtime"
	@echo "                   Build ../nxjs-source and overlay nxjs.nro into node_modules"
	@echo "  make build       esbuild bundle (depends on sync-runtime)"
	@echo "  make nro         Package $(NRO) (depends on build + current-json + nxjs-runtime)"
	@echo "  make sdmc        Build + mirror romfs/ to Citron SDMC"
	@echo "  make mirror-only Mirror romfs/ to SDMC without rebuilding"
	@echo "  make clean       Remove build/, runtime/, $(NRO)"
	@echo ""
	@echo "Overrides:"
	@echo "  PYTHON=py        Use the Windows 'py' launcher instead of 'python'"
	@echo "  SDMC_DEST=...    Point the sdmc mirror at a different Citron profile"
