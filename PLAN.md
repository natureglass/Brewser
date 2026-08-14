# Brewser Forwarder — Phase II Plan

**Status:** Phase II (Plan). No implementation code has been written. Hard stop after this document for review.
**Basis:** `INVESTIGATION.md` (Phase I, approved) + the Phase II Directive (consolidated final scope). Two directive-required investigations were completed first and are recorded in §0. Nothing here contradicts Phase I without a new citation.

---

## 0. Facts settled during Phase II (required before planning)

### 0.1 §2(b) — Blob backing: the lazy / file-backed generation path is available — CONFIRMED

The engine's `Blob` is a fetch-blob port that **stores `Blob`-instance parts by reference, never copying them**; only typed-array/`ArrayBuffer` parts are copied.

- `nxjs-extended/packages/runtime/src/polyfills/blob.ts:89-90` — `} else if (element instanceof Blob) { part = element; }` (by-reference), vs `:80-88` (typed-array/ArrayBuffer → `new Uint8Array(...slice())`, copied).
- `blob.ts:113-115` — `get size()` returns the sum precomputed at construction from each part's `.size` (synchronous).
- `blob.ts:157-170` — `stream()` lazily iterates parts; `blob.ts:34` — for a `Blob` part it does `yield* part.stream()` (pull-based, no materialization).

`FsFile` (returned by `Switch.file(path)`) is itself a lazily SD-backed `Blob`:
- `nxjs-extended/packages/runtime/src/fs.ts:372` — `export class FsFile extends File` and `polyfills/file.ts:8` — `class File extends Blob` ⇒ `FsFile instanceof Blob` is **true**.
- `fs.ts:378` — the constructor calls `super([], name, …)` (empty parts — **no bytes held**).
- `fs.ts:394-400` — `get size()` is a **synchronous** `statSync(this.name)`.
- `fs.ts:435-459` — `stream()` reads the file from SD lazily via `fopen`/`fread` chunks.

**Consequence for the generator:** if the RomFS tree is built from `Switch.file(<appfile>)` (`FsFile`) leaves rather than `new Blob([bytes])`, then the vendored `romfs.encode` (reads only `.size` sync, pushes each leaf by reference) and `nro.encode` (pushes the RomFS + code Blobs by reference) produce a **lazy composite Blob**. Streaming that Blob to `Switch.file(out).writable` pulls each app file from SD chunk-by-chunk. **Peak memory = the small RomFS metadata tables + a 64 KiB streaming pool — never the app bytes**, regardless of app size or launch regime. The only forced materialization in the reference code is the Node CLI's `Buffer.from(await outputNro.arrayBuffer())` (`packages/nro/src/main.ts:217`), which we do not port.

**Decision this settles:** the embed path is flat-memory. **No `Switch.memoryUsage()` checkbox gating is required** (directive §2(b) "if lazy: no gating needed"). The only generation preflight is `openSdmc().freeSpace()` for SD space. The generator MUST build RomFS from `FsFile` leaves (implementation constraint, §4.3). An SD-file-backed engine Blob (directive §2(b) follow-up) is therefore **not** a launch dependency and is dropped from this plan.

### 0.2 Deliverable 3 — snapshot hygiene: use an allowlist, not a walk — CONFIRMED

All runtime/user data managed by the runtime lives **outside** `apps/<id>/`:
- localStorage → `sdmc:/switch/brewser/shell/localStorage/default.json` (`brewser-runtime/src/storage/local-storage.ts:87-91`; root from `brewser/src/profile/browser-profile.ts:70-72`); single shared namespace, not per-app.
- IndexedDB → `sdmc:/switch/brewser/shell/indexedDB/<db>.json` (`brewser-runtime/src/storage/indexed-db.ts:68-76`).
- Cookies → in-memory only, never persisted (`brewser-runtime/src/resources/cookie-jar.ts:20-23`).
- SDK saves → localStorage key `brewser_save_<pkg>` + server (`brewser-apps/.../savedemo/brewser.js:47,138-155`).
- All shell/user state (favorites, achievements, ratings, versions, auth) → `configs/` and `shell/auth/`.

**But `apps/<id>/` is not write-sealed against the app itself:** `allowLocalWrite` returns `true` for any path inside the sandbox root (`brewser-runtime/src/permissions/browser-permission-policy.ts:126-130`), and the sandbox root **is** the app's own dir (`brewser/src/browser-shell.ts:2441-2442`, `sandboxRoot = ${appRoot}${appDir}`). An app can `Switch.writeFileSync('./save.dat', …)` into `apps/<id>/` with no permission. Install itself writes only the artifact `files[]` + entry + `manifest.json`; no post-install shell write targets an installed app's dir (`download-modal.js`, `updates-modal.js:667-675` reads only).

**Decision this settles:** snapshot **by allowlist = the app's artifact `files[]` inventory** (byte-for-byte the original installable bundle), never by trusting a directory walk. Because that inventory is fetched at install but **not persisted to disk today** (Phase I I3.5), offline-correct embedding requires **persisting the inventory at install/update time** (§4.4). This is the correctness cornerstone of the embed feature; the exact persistence shape + legacy-app handling is Open Decision D1 (§11).

---

## 1. Architecture overview

Four components, one generic stub serving both forwarder variants:

```
GENERATION (inside Brewser, online-agnostic/offline)
  app modal "Create App Forwarder" (installed apps only)
   └─ confirm dialog (embed checkbox, default OFF)  ── Cancel → nothing written
       └─ globalThis.__brewserCreateForwarder({appId, embed}, ui)   [shell seam]
            read romfs:/forwarder-stub.nro  →  NRO.decode
            build NACP (title/author/version/id)                    [vendored, in-memory]
            build 256×256 JPEG icon (decode cached logo → OffscreenCanvas → convertToBlob)
            build RomFS:
              forwarder.json  (contract, appId, [entry, files])
              [embed only] bundle/<rel>  = Switch.file(apps/<id>/<rel>)  [FsFile leaves — lazy]
            NRO.encode → lazy Blob → stream to sdmc:/switch/<name>-forwarder.nro.tmp
            verify → rename .tmp → .nro                              [I4-P swap pattern]

LAUNCH (from hbmenu, fully offline)
  <name>-forwarder.nro
   └─ generic stub (C + libnx)
        romfsInit; parse forwarder.json (unknown contract → error+exit)
        verify sdmc:/switch/brewser/brewser.nro exists (else friendly install msg)
        installed?  (manifest.json + <entry> present)   [embed only test; lite: skip]
          ├─ yes → chainload now (ignore any bundle)
          └─ no  → bundle present? seed apps/<id>/ (entry-last) → chainload
                   no bundle?  → chainload anyway (Brewser shows missing screen)
        envSetNextLoad("…/brewser.nro", "\"…/brewser.nro\" --fwd=1 --app=<id>") ; exit

  brewser.nro  (chainloaded)
   └─ boot: parse Switch.argv → --app overrides autorunApp bootUrl; --fwd=1 = forwarder mode
        forwarder mode: no catalogue, showToolbar:false, own splash policy
        app exit at history depth 1 → Switch.exit()  → hbmenu   [closes I1 gap]
        app missing → graceful missing-app screen → clean exit
```

**Invariants (from directive §1):** the launch path never touches the network; Brewser is never embedded; generation only reads `apps/<id>/` (via the persisted allowlist) and writes one new `.nro`; the forwarder's RomFS is immutable; installed apps always run at their *installed* version (embedded snapshot is ignored when installed — never a downgrade).

---

## 2. Component A — Generic stub (`brewser-forwarder-stub`, new sibling folder, C + libnx)

**One generic binary; all per-forwarder data is in its RomFS.** No baked-in strings, no code patching — generation only replaces the NRO asset section (icon + NACP + RomFS).

### 2.1 RomFS layout
- `romfs:/forwarder.json` — always present (schema §5.2).
- `romfs:/bundle/<rel>…` — present **iff** embed was chosen (the app snapshot). Absent ⇒ lite forwarder.

### 2.2 Launch flow (exact)
1. `romfsInit()` + mount self romfs; open `romfs:/forwarder.json`.
2. Parse `forwarder.json` (§5.2). `contract != 1` → `consoleInit`, print a one-line "this forwarder is newer than… update Brewser" error, wait for `+`, exit. Extract `appId`, and (embed only) `entry` + `files[]`.
3. **Verify `sdmc:/switch/brewser/brewser.nro` exists** (`stat`). Absent → friendly console message "Brewser isn't installed. Get it at play.brewser.tech" → wait → exit. (Never die silently — directive §A.)
4. **Bundle present?**
   - **No (lite):** skip the installed-test; go to step 7 (Brewser handles present/missing).
   - **Yes (embed):** run the **installed-test** — `apps/<id>/manifest.json` exists **and** `apps/<id>/<entry>` exists (exactly Brewser's definition, `installed-apps.ts:113,135`).
     - **Installed → skip seeding entirely** (never compare versions, never overwrite). Go to step 7.
     - **Not installed → seed (step 5).**
5. **Seed** (fully offline, from the forwarder's own `romfs:/bundle/`):
   - `freeSpace()` preflight against the sum of `files[].size`.
   - Write every non-entry file first, then the **entry file last** (mirrors the installer's interrupted-install self-heal, `download-modal.js:323-341`), verifying each written file's size against `files[]` (sizes-only — see Open Decision D2).
   - Swap pattern per §5.4 (contingent on probe I4-P; default = direct-write-entry-last into `apps/<id>/` because the app is *missing*, so there is no good install to protect — see §5.4).
   - Any failure (space, write error, size mismatch) → leave the live install untouched, print "Couldn't restore <title> — your SD card may be full. Open Brewser to reinstall." → wait → **clean exit to hbmenu** (do not chainload into a broken app).
6. (Seed succeeded → fall through.)
7. Optional one-line applet-mode notice (informational; not a blocker).
8. `envSetNextLoad("sdmc:/switch/brewser/brewser.nro", "\"sdmc:/switch/brewser/brewser.nro\" --fwd=1 --app=<appId>")` → clean `return` (process exits, hbloader chainloads). Relies on engine #120 (§3.1) so the leading `--` flags don't hijack the entrypoint.

### 2.3 Dependencies & build
- **Dependency-free beyond libnx.** JSON parsing: a tiny vendored public-domain single-header parser (or a hand-rolled extractor over our fixed schema) — no C++ runtime. **Sizes-only ⇒ no SHA-256 needed in the stub** (Open Decision D2; if D2 chooses sha256, vendor a public-domain SHA-256 — still no C++ runtime).
- **Build:** devkitPro/devkitA64 `Makefile` producing `brewser-forwarder-stub.nro` + GitHub Actions using the `devkitpro/devkita64` container.
- **Distribution (per I8):** the built artifact is placed at **`brewser/romfs/forwarder-stub.nro`** (committed binary, baked into `brewser.nro` by `nxjs-nro --fat`), and its filename added to `SEED_SKIP_ROOT_FILES` (`browser-profile.ts:33-42`) so the seeder never mirrors a stale copy to SD. It is **auto version-locked** to the runtime because it rides inside the signed whole-NRO that self-update replaces wholesale (chunk hashes in `dist/update.json`; atomic swap `src/update/apply.ts:40-60`).

### 2.4 Size note
Lite forwarder ≈ stub (~300 KB) + tiny `forwarder.json`. Embed forwarder = that + the app bundle (worst case 27.76 MiB, Phase I I9). The 256×256 JPEG icon and NACP are in the asset section, not RomFS.

---

## 3. Component B — Runtime forwarder mode (brewser / brewser-runtime) + engine #120

### 3.1 Engine change #120 (the ONLY engine delta) — argv-trap fix
Per standing decision §2(a): in `resolve_entrypoint` (`nxjs-extended/source/main.cc:1424-1490`), when selecting the entrypoint from argv, **skip leading `--`-prefixed tokens** (argv[1], argv[2], …) and use the first non-`--` token as today's entrypoint selector; if there is none, take the standalone `romfsMountSelf` path (`:1470-1489`).
- Result: a forwarder chainload `[brewser.nro, --fwd=1, --app=x]` has no non-`--` argv[1] → **standalone self-mount → `romfs:/main.js`** — the *identical* boot path as a normal launch. Flags remain visible in `Switch.argv` (populated for all `argc`, `main.cc:1193-1198`).
- **Backward compatibility preserved:** `argv[1]=="nsp:"` (`:1433`), `argv[1]` ending `.nro` (`:1452`), and a literal-entrypoint `argv[1]` (`:1463`) are unchanged — none begin with `--`.
- Ledger: **engine entry #120** (§7), re-apply marker `#120` grepped in `source/main.cc`.

No other engine change. The runtime/shell forwarder logic below uses only **public** `Switch.argv` and `Switch.exit()` — no engine internals — so it needs **no `RUNTIME_SHIMS.md` entry and no marker-property guard** (directive §3B "where applicable" — not applicable here).

### 3.2 argv parse + `--app` override (brewser shell)
At boot, before the autorun decision, parse `Switch.argv` (skip argv[0]) into flags: `--fwd=1` (forwarder mode), `--app=<id>`, unknown `--` flags ignored (additive-only contract).
- `--app=<id>` overrides `autorunApp` in the `bootUrl` computation at `browser-shell.ts:1408` — set `bootUrl = resolveAutorunUrl('apps/<id>/<entry>')` (entry from the app's on-disk `manifest.json`, default `index.html`). This reuses the existing autorun navigation path (Phase I I1); no new "launch-by-id" machinery.
- `--fwd=1` sets a `forwarderMode` flag on the shell.

### 3.3 Forwarder mode behavior
- **No catalogue UI** (already true for any autorun target — the catalogue page is never navigated to, Phase I I1).
- **Force `showToolbar:false`** and a **forwarder-defined splash policy independent of the user's `config.json`** (do not read `showToolbar`/`showSplash` from config in forwarder mode; the forwarder must look identical regardless of the device's shell settings).
- **Exit at history depth 1 → `Switch.exit()`** (closes the confirmed I1 gap): in the `case 'exit'` app-context branch (`browser-shell.ts:1687`, `:1707-1762`), when `!canGoBack` (`navigation-controller.ts:14-16`) and `forwarderMode`, call `Switch.exit()` → returns to **hbmenu**, never the catalogue. `freshProcessOnExit` is ignored in forwarder mode (no relaunch loop).
- **Missing/incomplete app** (`--app=<id>` but the installed-test fails — e.g. a lite forwarder whose app was deleted): render a graceful missing-app screen (reuse the `missing-app` notice surface) with an optional "Open Brewser to download it again" hint → clean exit. Never a crash, never the catalogue.

### 3.4 Untouched by design
Normal (no-argv) launches, and the existing plain-`autorunApp` behavior, are **completely unchanged** unless the separately-flagged autorun exit fix (§10) is independently approved. The forwarder branches are all gated on `forwarderMode`.

---

## 4. Component C — On-device generator + dialog UI

### 4.1 UI surface (per I10)
- **Button:** add `#app-modal-forwarder` to the app modal's LEFT action slot in `romfs/shell/home.html` (`.app-modal-actions-side`, near `#app-modal-delete`). Shown/enabled **only when `detail.missing === false`** (installed); toggled with the existing `app-modal-btn--hidden` class in the installed branch of `missing-app-modal.js` (`:776+`).
- **Confirm dialog:** a new modal reusing the `download-modal` `--loading/--success/--error` scheme (no new CSS). Body copy + checkbox + failure text per §9. Checkbox **default UNCHECKED**; label includes the computed embed size (sum of the app's `files[].size`, formatted). Cancel writes nothing.
- **Progress:** cooperative per-file `async/await` loop (the download-modal pattern, `download-modal.js:349-453`), work deferred one microtask so the loading frame paints (`:657`). For the embed variant, progress is driven by the streamed write (a small number of coarse ticks — the heavy lifting is one streamed pipe, not many fetches).

### 4.2 Seam (per I10)
`globalThis.__brewserCreateForwarder = async ({ appId, embed }, ui) => {…}`, installed by a new `installForwarderSeam()` mirroring `installSelfUpdateSeam()` (`brewser/src/update/seam.ts:37-61`), wired in `brewser/src/main.ts`. The seam runs in shell TS (privileged realm) so it uses raw `Switch.*` (no permission-policy gating; writes to `sdmc:/switch/` are allowed, auto-mkdir, no engine restriction — Phase I I4).

### 4.3 Generation pipeline (all on-device, offline)
1. Read `romfs:/forwarder-stub.nro` → `NRO.decode` (stub ~300 KB; trivially in memory).
2. **NACP** (vendored, in-memory): start from the stub's NACP, set `title` = app name, `author` = developer, `version` = app version, `id` = a per-app title id (Open Decision D5). UTF-8 limits enforced by the vendored class (title < 0x200/lang, author < 0x100 — Phase I I5).
3. **Icon** (per I6): read the app's cached logo from disk (`apps/<id>/<logoRel>`), decode via `Image`/`createImageBitmap` → `new OffscreenCanvas(256,256)` → `drawImage(...,256,256)` → `convertToBlob({type:'image/jpeg'})`. SVG logos are unsupported (I6) → fall back to the default icon (Open Decision D6).
4. **RomFS tree:**
   - `forwarder.json` (§5.2) as a small in-memory Blob.
   - **Embed only:** for each `rel` in the persisted allowlist (§4.4), add `bundle/<rel>` = **`Switch.file(appRoot + 'apps/<id>/' + rel)`** (an `FsFile` leaf — keeps generation lazy per §0.1). If any listed file is missing on disk (incomplete install), abort embed with a clear message (do not embed a partial bundle).
5. `NRO.encode({ data: stub.data, icon, nacp, romfs })` → **lazy composite Blob**.
6. Stream it: `outputNro.stream().pipeTo(Switch.file('sdmc:/switch/<name>-forwarder.nro.tmp').writable)` (`fs.ts:480-500`). Never `arrayBuffer()` the whole NRO.
7. Verify (`.tmp` exists, size > 0, optional NRO0 magic re-read of the header).
8. **Rename `.tmp` → final** per the I4-P swap pattern (§5.4) — regeneration replaces the same output filename cleanly (§5.3). On any failure, delete the `.tmp` so hbmenu never sees a partial `.nro`.

Peak memory (§0.1): stub (~300 KB) + NACP (16 KB) + icon (~tens of KB) + RomFS tables (KBs) + 64 KiB stream pool ≈ well under 1 MB, independent of app size.

### 4.4 Inventory persistence (for the offline allowlist — new, small)
Per §0.2, persist the app's artifact `files[]` at install/update time so the generator has an authoritative bundle list offline:
- **Write** (in `download-modal.js` `runInstall`, which already holds `files[]` in memory at `:610`): after a successful install/update, write the inventory to a sidecar **outside** `apps/<id>/` → `sdmc:/switch/brewser/configs/app-inventory/<id>.json` = `{ id, entry, version, files: [{ path, size }] }`. Keeping it out of `apps/<id>/` means the snapshot never has to exclude it and the app dir stays == bundle.
- **Delete** (in `delete-modal.js`): remove the sidecar on uninstall (avoid orphans).
- **Read** (generator): load the sidecar offline → allowlist + sizes for `forwarder.json`.
- **Legacy apps** (installed before this ships → no sidecar): Open Decision D1 (recommend: disable the embed checkbox with an inline reason "Re-download this app in Brewser to enable embedding"; link-only generation is never blocked).

---

## 5. Component D — `FORWARDER_CONTRACT.md` (full draft)

The file will be created at `brewser/FORWARDER_CONTRACT.md` in Phase III. Draft content:

### 5.1 argv contract (v1) — the durable cross-version guarantee
A forwarder chainloads Brewser with, in order after the NRO path: **`--fwd=1 --app=<appId>`**.
- `--fwd=1` — forwarder mode (no catalogue, toolbar off, exit → hbmenu).
- `--app=<appId>` — the app to launch; overrides `autorunApp`.
- **Additive-only evolution:** new flags may be introduced in future; **Brewser MUST ignore unknown `--` flags** and MUST forever honor `--fwd`/`--app`. **Old forwarders in the wild keep working across every runtime update** — this is the load-bearing guarantee. Flags are read from `Switch.argv`; the engine (#120) skips leading `--` tokens when resolving the entrypoint so Brewser boots its own `romfs:/main.js` normally.

### 5.2 `forwarder.json` schema (contract v1)
Read by the forwarder's own embedded stub (always the same version that generated it; the `contract` field is a defensive guard).
```json
{
  "contract": 1,
  "appId": "com.example.app",
  "title": "Example App",
  "entry": "index.html",
  "files": [ { "path": "index.html", "size": 12345 } ]
}
```
- `contract` (required) — `1`. Unknown value → stub prints error and exits.
- `appId` (required) — the app id passed as `--app`.
- `title` (optional) — for stub console messages.
- `entry`, `files[]` (present **iff** a bundle is embedded) — `entry` is the relative entry path written **last** during seeding and used for the installed-test; `files[]` is the embedded bundle inventory with per-file `size` for seed verification. Absent ⇒ lite (link-only) forwarder.
- **Bundle presence** = `files`/`entry` present **and** `romfs:/bundle/` populated. Both variants are contract v1.

### 5.3 SD paths, naming & collision rule
- Output: `sdmc:/switch/<name>-forwarder.nro`, staged as `…-forwarder.nro.tmp` first (atomic reveal). `<name>` derived from the app title/id (sanitized to a FAT-safe filename); the rule is deterministic so **regeneration for the same app replaces the same file** (idempotent; a different checkbox state cleanly overwrites the prior variant).
- Seed target: `sdmc:/switch/brewser/apps/<appId>/` (Brewser's app root, `browser-config.ts:28`).

### 5.4 Seed staging + FAT-safe swap
- Entry-last rule: all non-entry files written before the entry file, so an interrupted seed reads as "not installed" (installed-test fails) and self-heals on the next launch.
- **Swap:** because seeding runs only when the app is **missing** (nothing to protect), the recommended pattern is **direct-write-entry-last into `apps/<appId>/`** — no rename step, no dependency on HOS directory-rename semantics. (The directive's staging-dir + FAT-safe swap is retained as the alternative if probe I4-P shows direct writes are unsafe; then: stage to `apps/.staging-<id>/`, entry-last, remove any partial `apps/<id>/`, rename staging → live.) Final choice gated on I4-P — Open Decision D3.
- The updater's proven **remove-then-rename** idiom is the reference for any rename used (`src/update/apply.ts`).

### 5.5 Installed-test definition (shared with Brewser)
An app is "installed" ⟺ `apps/<id>/manifest.json` exists **and** `apps/<id>/<entry>` exists — identical to `brewser-runtime/src/platform/installed-apps.ts:113,135`. The stub uses `entry` from `forwarder.json`; Brewser uses the manifest's `entry`.

### 5.6 Semantics (normative)
- **Link-first:** installed → chainload at the installed version; the embedded snapshot is **ignored**. Never version-compare, never overwrite, never downgrade.
- **Seed-if-missing:** missing + bundle → seed offline, then chainload. Missing + no bundle → chainload; Brewser shows the missing-app screen.
- The forwarder's RomFS is **immutable**; app updates via Brewser never touch it; it refreshes only on regeneration.

### 5.7 Failure behaviors
- `brewser.nro` absent → "install Brewser (play.brewser.tech)" console message → exit.
- Seed failure (space/write/size) → "couldn't restore <title>" → clean exit; live install untouched.
- Unknown `contract` → error → exit.
- Applet-mode → optional one-line informational notice.

### 5.8 NACP / icon constraints
Title < 0x200 UTF-8 bytes per language slot; author < 0x100; version ≤ 0x10 bytes; icon = 256×256 JPEG. (Enforced by the vendored NACP class + the on-device JPEG encoder.)

### 5.9 Version-lock note
The stub is embedded in `brewser.nro`'s RomFS and is version-locked to the runtime by the signed whole-NRO self-update. A *generated* forwarder carries a copy of the stub from the Brewser version that made it; cross-version compatibility is guaranteed solely by the argv contract (§5.1).

---

## 6. Snapshot hygiene & exclusion rules (deliverable 3)

Restating §0.2 as the normative rule for the plan:
1. **Snapshot by allowlist, never by walking.** The embedded bundle = exactly the app's artifact `files[]` (persisted at install, §4.4). This is byte-for-byte the original installable bundle and cannot capture app-authored save/cache files.
2. **Include** `manifest.json` (a bundle file; authoritative id/version/entry). **Never include** anything not in `files[]` — such paths are necessarily app-written runtime data (no other writer targets `apps/<id>/`, §0.2).
3. **No path heuristics needed** (there is no `saves/`/`cache/` convention inside `apps/<id>/`; the allowlist covers arbitrary app-chosen filenames).
4. Runtime-managed user data (localStorage, IndexedDB, cookies, SDK saves) is provably outside `apps/<id>/`, so it is excluded by construction regardless.
5. Probe I3-P quantifies real-world app-written files (set-difference on-disk tree vs `files[]`); it validates but is not required for correctness (the allowlist is correct-by-construction).

---

## 7. Ledger entries & `verify-patches.sh` fixes (deliverable 4)

New entries start at **#120** (global max observed #119; respect the documented #105 collision; never renumber — Phase I I0).

| # | Ledger | Title | Re-apply marker (grep target) |
|---|---|---|---|
| #120 | `NXJS_PATCHES_NEEDED.md` (engine) | `resolve_entrypoint` skips leading `--` argv tokens (forwarder argv-trap fix) | `source/main.cc` contains a `#120` marker comment + the skip loop (e.g. `// #120:` and a `strncmp(argv[i], "--", 2)` guard in the entrypoint scan) |

- **No runtime-ledger (`RUNTIME_SHIMS.md`) entry** is planned: the forwarder runtime/shell code depends only on public `Switch.argv`/`Switch.exit()`, not engine internals, so it is ordinary feature code (not an engine-gap shim) and needs no marker-property guard (§3.1).
- **`verify-patches.sh` fixes (directive §2c), regardless of #120):**
  1. `scripts/verify-patches.sh:23` — default `RUNTIME` `…/brewser-runtime-v8` → `…/brewser-runtime`.
  2. `scripts/verify-patches.sh:25` — default `BREWSER_V8` `…/brewser-v8` → `…/brewser`.
  3. Add a `#120` check block (grep `source/main.cc` for the marker) in the engine section.
- After ledger edits, run `verify-patches.sh` with corrected/overridden paths and confirm all entries PRESENT/KNOWN-OPEN (house rule #2).

---

## 8. Per-repo file list & Phase III implementation order (deliverable 5)

### Files to create (C) / modify (M)

**`nxjs-extended` (engine):**
- M `source/main.cc` — #120 leading-`--` skip in `resolve_entrypoint`.
- M `NXJS_PATCHES_NEEDED.md` — add #120 entry.
- M `scripts/verify-patches.sh` — fix default paths + add #120 check.

**`brewser-forwarder-stub` (NEW sibling folder `D:\Workspace\brewser-forwarder-stub`):**
- C `source/main.c` — the generic stub (§2).
- C `Makefile` — devkitA64.
- C `.github/workflows/build.yml` — `devkitpro/devkita64` container → artifact.
- C vendored `json.h` (public-domain, tiny) or hand-rolled parser; (C `sha256.h` only if D2 = sha256).
- C `README.md`.

**`brewser-runtime` (runtime bundle — platform-agnostic pack library):**
- C `src/pack/nro.ts`, `src/pack/romfs.ts`, `src/pack/nacp.ts` — vendored from `@tootallnate/{nro,romfs,nacp}` (Web-API only; Phase I I5).
- C `src/pack/patch-nacp.ts` — re-authored, in-memory (no `node:fs`); accepts a parsed manifest object.
- C `src/pack/index.ts` — exports (platform-agnostic; no `Switch`/SD coupling — a future web generator can reuse it).
- (No `RUNTIME_SHIMS.md` change — §7.)

**`brewser` (shell):**
- M `src/main.ts` — `installForwarderSeam()` wiring.
- C `src/forwarder/seam.ts` — `globalThis.__brewserCreateForwarder`.
- C `src/forwarder/generate.ts` — generation orchestration (NACP/icon/RomFS/stream/rename) using the brewser-runtime pack lib.
- M `src/browser-shell.ts` — argv parse; `--app` override at the `:1408` bootUrl seam; `--fwd` forwarder mode (toolbar off, splash policy, missing screen); exit depth-1 → `Switch.exit()` gated on `forwarderMode`.
- M `src/profile/browser-profile.ts` — add `forwarder-stub.nro` to `SEED_SKIP_ROOT_FILES` (`:33-42`).
- M `romfs/shell/home.html` — `#app-modal-forwarder` button + confirm-dialog markup.
- M `romfs/shell/scripts/missing-app-modal.js` — wire the button (installed-only) → open dialog.
- C `romfs/shell/scripts/forwarder-modal.js` — confirm dialog + progress + calls the seam.
- M `romfs/shell/scripts/download-modal.js` — persist artifact inventory to `configs/app-inventory/<id>.json` on install/update (§4.4).
- M `romfs/shell/scripts/delete-modal.js` — delete the inventory sidecar on uninstall.
- C `romfs/forwarder-stub.nro` — committed built stub artifact (baked by `nxjs-nro --fat`).
- C `FORWARDER_CONTRACT.md` — §5 content.
- C `tests/forwarder-roundtrip.test.mjs`, `tests/forwarder-nacp-limits.test.mjs`, `tests/forwarder-exclusion.test.mjs` — Phase IV (§13).

### Implementation order (dependency-driven)
1. **Engine #120** + ledger + `verify-patches.sh` fixes (settles the argv contract everything depends on; small).
2. **Stub** (C + Makefile + CI) — standalone, buildable, produces `forwarder-stub.nro`. Testable against a hand-made forwarder before the generator exists.
3. **Pack library** vendored into `brewser-runtime` + Node round-trip tests (dev-machine verifiable now — §13).
4. **Inventory persistence** in `download-modal.js` / `delete-modal.js` (unblocks offline allowlist).
5. **Generator + seam** in `brewser` (icon, NACP, RomFS from `FsFile` leaves, stream-write, rename).
6. **Runtime forwarder mode** (argv parse, `--app` override, `--fwd` mode, exit-to-hbmenu, missing screen) + embed `forwarder-stub.nro` into romfs + `SEED_SKIP`.
7. **UI** (button + dialog + approved copy).
8. **`FORWARDER_CONTRACT.md`** + tests green + hardware checklist.

---

## 9. Dialog copy draft (deliverable 6 — Alex approves the words)

Two-sentence register, no jargon ("chainload"/"RomFS"/"NRO" never appear). `<App>` and `~SIZE` are substituted at runtime.

**Confirm dialog — body:**
> Create a shortcut for **<App>** in your Home­brew Menu. Launch it there to open <App> straight from Brewser — it always runs the version you have installed.

**Checkbox label (default OFF):**
> Include a copy of <App> (adds ~SIZE) — lets the shortcut reinstall it if you ever delete it.

**Buttons:** `Create shortcut` / `Cancel`.

**Generation success:**
> Done — close Brewser and look for **<App>** in your Home­brew Menu.

**Generation failure (SD full / write error):**
> Couldn't create the shortcut — your SD card may be full. Nothing was changed.

**Embed disabled (legacy app, if D1 = disable):**
> Re-download <App> in Brewser first to include a copy in the shortcut.

**Stub / forwarder-mode screens (shown on launch):**
- Brewser missing: `Brewser isn't installed. Get it at play.brewser.tech, then open this shortcut again.`
- App deleted, no embedded copy (Brewser missing-app screen): `<App> isn't installed. Open Brewser to download it again.`
- Restore failed (SD full): `Couldn't restore <App> — your SD card may be full. Open Brewser to reinstall.`
- Applet-mode notice (optional, one line): `Tip: for the smoothest experience, launch with more memory.`

---

## 10. Plain-`autorunApp` exit fix — separate, flagged proposal (deliverable 7)

**Independent of the forwarder work; accept or reject on its own.** Today, exiting an app launched via plain `autorunApp` (no forwarder) is a **no-op / relaunch loop** (Phase I I1, confirmed): the app is the sole history entry, `canGoBack` is false, and `Switch.exit()` is unreachable from the app context.

**Proposal:** apply the same depth-1 fix outside forwarder mode — when an app-context `exit` occurs at history depth 1 under plain `autorunApp`, call `Switch.exit()` (return to hbmenu) instead of no-op. The Home button (→ `DEFAULT_HOME_URL`) escape hatch is unaffected.

**Why separate:** it changes existing (if broken) behavior for non-forwarder autorun users; the forwarder feature does not require it (forwarder mode has its own gated exit path, §3.3). **Risk:** minimal — it converts a stuck state into a clean exit; the only behavioral change is that an autorun app's exit action now quits to hbmenu. **Recommendation: accept** (it fixes a real UX dead-end), but it ships as a distinct commit that can be reverted without touching the forwarder. Regression test #15 covers "unchanged unless this is approved."

---

## 11. Open decisions for Alex (deliverable 8)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | Offline allowlist source + legacy apps | (a) Persist artifact `files[]` at install (§4.4) + **disable embed for legacy-installed apps** with a re-download hint; (b) same persistence but **walk-with-warning** for legacy apps; (c) no persistence, always walk | **(a)** — correct-by-construction; legacy apps just re-download to enable embed. Link-only is never blocked. |
| **D2** | `forwarder.json` integrity | sizes-only vs + per-file `sha256` | **sizes-only** — source is the forwarder's own immutable RomFS; keeps the stub SHA-free and generation flat. (sha256 would catch rare SD bit-rot but adds a C dependency + per-file materialization; not worth it.) |
| **D3** | Seed swap pattern | direct-write-entry-last vs staging-dir + rename swap | **direct-write-entry-last** (app is missing → nothing to protect; avoids the HOS dir-rename unknown). Confirm with probe I4-P; fall back to staging+rename if direct writes prove unsafe. |
| **D4** | Plain-autorun exit fix (§10) | accept / reject | **accept** as a separate commit. |
| **D5** | Forwarder NACP title id | reuse Brewser's id `01f5905036d20000` / derive a deterministic per-app id / fixed forwarder id | **derive a deterministic per-app id** (so hbmenu treats each forwarder as distinct); confirm the derivation is collision-safe and non-conflicting with real titles. Low-risk; happy to default to a fixed forwarder id if you prefer. |
| **D6** | Icon fallback when logo is SVG/absent/undecodable | Brewser default icon / a generated placeholder / block generation | **Brewser default icon** (forwarder still works with generic art; never blocks generation). |
| **D7** | Applet-mode on launch | warn-only / silent / gate | **warn-only** (one line). Embedding is flat-memory (§0.1) so no memory gate is needed even in applet mode. |

---

## 12. Hardware-probe plan (deliverable 9)

All require real CFW hardware (Citron doesn't populate argv — Phase I I2). Recommended order and timing:

| Probe | What | When | Notes |
|---|---|---|---|
| **I2-P** | After #120: `Switch.Application("…/brewser.nro").launch("…/brewser.nro","--fwd=1","--app=TESTID")` from a tiny JS test app; log `Switch.entrypoint` + `Switch.argv` in Brewser. | **Before Phase III** (runnable NOW via a ~20-line test app; no C stub needed) | Confirms the argv contract + #120 fix boot Brewser's own `romfs:/main.js` with flags intact. De-risks the whole feature. |
| **I4-P** | Rename-overwrite (and, if D3 = staging, directory-rename) semantics: write `a`/`b`, `renameSync('a','b')`, read back. | Before Phase III (or early in it) | Decides the `.tmp→final` swap and D3. Fallback = remove-then-rename (self-updater's proven idiom). |
| **I1-P** | Plain-autorun exit gap: set `autorunApp`, boot, press exit. | Alongside §10 | Confirms the stuck/loop gap the exit fix closes. |
| **I3-P** | `ls -R apps/<id>/` set-differenced vs `artifacts/<id>.json files[]` per installed app. | During Phase III | Quantifies real app-written files; validates the allowlist (not required for correctness). |
| **I6-P** | hbmenu renders an on-device-encoded 256×256 JPEG forwarder icon. | During Phase III | Encoder linkage already proven (I6); visual accept-check only. |
| **I9-P** | Peak memory during a worst-case (27.76 MiB) embed generation, both launch regimes. | **Downgraded to optional** | §0.1 resolved the lazy/flat path, so memory is no longer a concern *provided* the generator uses `FsFile` leaves. Run as a lightweight confirmation on the first embed generation, not a gating probe. |

---

## 13. Phase IV verification plan (build now, run after Phase III)

**Automated (Node, dev machine — runnable without hardware):**
- `forwarder-roundtrip.test.mjs` — using the vendored pack lib, assemble **both** variants (lite + embed) from a fixture app; parse back with a verifier: ASET header offsets/sizes, NACP fields (title/author/version/id), RomFS file listing + per-file bytes, `forwarder.json` schema + `files[]` sizes. Assert byte/structure equality.
- `forwarder-nacp-limits.test.mjs` — NACP UTF-8 edge cases (title at 0x1FF vs 0x200 boundary; author at 0xFF vs 0x100; multibyte/astral; over-limit throws).
- `forwarder-exclusion.test.mjs` — dir-walk/allowlist rules: given a fixture `apps/<id>/` containing bundle files **plus** app-written `save.dat`/`cache/`, assert the snapshot equals the allowlist `files[]` exactly and excludes the extras.

**Manual hardware checklist (Alex):** the directive §5 list — Generation 1-7, Forwarder 8-16, Regression 17/#15. Key ones the plan is explicitly designed to pass: dialog-cancel writes nothing (#3), kill-mid-generation leaves only cleanable `.tmp` (#4), regenerate-other-checkbox clean replace (#5), installed app runs at the **new** version after a Brewser update — embedded snapshot ignored, no downgrade (#9), delete → lite forwarder shows missing screen / embed forwarder seeds offline (#10), interrupted seed self-heals (#11), no `brewser.nro` → friendly message (#13), normal boot completely unchanged (#15).

**Definition of done (unchanged from directive):** A–D implemented per this plan, `FORWARDER_CONTRACT.md` written, round-trip tests green, `verify-patches.sh` green with #120 under corrected paths, hardware checklist delivered.

---

## ⛔ STOP — Phase II complete

No implementation code has been written. Awaiting review/approval of this plan (and the Open Decisions in §11) before Phase III.
