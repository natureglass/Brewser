# Brewser build & release — `Makefile` and `Makefile_nxjs`

Two build files:

- **`Makefile`** — builds Brewser and cuts a **signed self-update release** (pure Node; runs in any shell with `node`/`npm`/`python` on PATH).
- **`Makefile_nxjs`** — rebuilds the **nx.js runtime** (`nxjs.nro`). Needs the **devkitPro** toolchain; run it only when nx.js C/TS source changed. The self-updater is zero-engine-delta, so you rarely need it.

---

## `make` / `make release` — cut a signed release (default)

```sh
make            # same as: make release
```

In one go it:

1. **Bumps** the version + build counter — `package.json` version (patch, e.g. `0.1.2 → 0.1.3`) and `scripts/update/build-info.json` `counter` (+1). The version lets the runtime **detect** a new build; the counter (baked in + signed) lets it **accept** the update and refuse a rollback.
2. **Builds** the bundle with the new version/counter + signing keyring baked in (`scripts/build-main.mjs`), refreshes `romfs/configs/current.json` + the seed-fingerprint, and **packages** the fat NRO (reuses the prebuilt `nxjs.nro` — no devkitPro needed).
3. **Mirrors** `current.json` → `../brewser-apps/versions.json` (served at `play.brewser.tech/versions.json` — the snapshot the runtime compares against).
4. **Moves** the NRO to `dist/`, **signs** `dist/update.json` (`scripts/update/sign-release.mjs`), and **verifies** the console would accept it (`scripts/update/verify-release.mjs`). The build fails if verification fails.

Output: `dist/brewser.nro` + `dist/update.json` (→ push to `natureglass/Brewser`) and `../brewser-apps/versions.json` (→ push to brewser-apps).

> **Every `make` bumps the version.** Re-running after a failed step advances the version again. To iterate on the shell **without** cutting a release, use `make sdmc` (Citron dev loop — builds + mirrors `romfs/` to the emulator, no bump, no sign).

### Publish + test an update
1. Flash the **previous** build to the SD card as `sdmc:/switch/brewser.nro` (the baseline that will receive the update).
2. `make` → produces the new signed version in `dist/` + updated `versions.json`.
3. Push `dist/` (`brewser.nro` + `update.json`) to `natureglass/Brewser` **`main`**, and `versions.json` to brewser-apps.
4. On the baseline: **Apps → Check for Updates → Update now → Restart Now** → it downloads, verifies, applies, and reboots into the new version.

### Common targets
| Command | What it does |
|---|---|
| `make` / `make release` | Bump + build + package + sign + verify → `dist/` (default) |
| `make sdmc` | Dev loop: build + mirror `romfs/` to Citron SDMC (**no bump/sign**) |
| `make bump` | Bump version + counter only |
| `make nro` | Package `brewser.nro` at repo root (no bump/sign/move) |
| `make build` | esbuild bundle with baked version/counter/keyring |
| `make clean` | Remove `build/`, `runtime/`, `brewser.nro` |

Overridable variables: `DIST_DIR` (default `dist`), `BREWSER_APPS_DIR` (default `../brewser-apps`), `RELEASE_BRANCH` (default `main` — keep equal to `src/update/config.ts` `RELEASE_REF`).

---

## `make -f Makefile_nxjs` — rebuild the nx.js runtime

```sh
make -f Makefile_nxjs
```

Builds `nxjs.nro` from `../nxjs-source-v8` and overlays it into `node_modules/@nx.js/nro/dist/` so the next `make` packages the fresh runtime. It's incremental (a no-op when nothing changed).

> **Run this from the devkitPro shell** (the msys2 environment that sets `DEVKITPRO` and puts devkitA64 / `pkg-config` / `sed` on PATH). A generic Git Bash will fail with `Please set DEVKITPRO` or use the wrong `sed`/`pkg-config`.

You only need this when you edit nx.js C/TS source. For updater/shell/theme changes, skip it — `make` reuses the existing `nxjs.nro` base.

---

## One-time signing keys

`make` bakes the signing keyring into every NRO. Generate the keypair once (`node scripts/update/gen-keys.mjs`), then move `keys/backup.key.pem` **offline**. Private keys + `keys/.release-counter` are gitignored; the public `keys/*.pub.*` + `*.keyid` are committed and baked in.
