# Forwarder Generation — Phase I Investigation

**Feature:** Fully offline, on-device forwarder-NRO generation for Brewser.
**Date:** 2026-08-13 · **Phase:** I (Investigation only — no plan, no code).
**Scope of this doc:** answer I0–I10 against the *actual current code* of `nxjs-extended`, `brewser`, `brewser-runtime`, `brewser-apps`. Every verdict is backed by `file:line` evidence. Nothing here is designed or decided — that is Phase II.

## Verdict legend

- **CONFIRMED** — proven by reading current code.
- **PARTIAL** — mostly proven; a named piece is unresolved by code-reading alone.
- **UNSUPPORTED** — the capability/assumption does not hold today; a gap the plan must fill.
- **NEEDS-HARDWARE-PROBE** — provable only on real CFW hardware (with an exact probe given). Note: **Citron cannot test the forwarder→brewser argv handoff at all** (see I2).

## Executive summary

**Overall feasibility: HIGH.** The engine already ships every runtime primitive the feature needs — arbitrary SD writes with auto-mkdir, streaming `WritableStream` sink, `freeSpace()`, a **linked libjpeg-turbo JPEG encoder**, hardware `crypto.subtle.digest('SHA-256')`, and a full argv vector exposed as `Switch.argv`. The NRO/RomFS/NACP packing libraries are already **100% Web-API and streamable** — porting them on-device is a *vendoring* job, not a rewrite. The self-update system supplies the atomic-rename discipline and a version-locked place to embed a stub.

**The real work is small and well-scoped**, concentrated in four spots the plan must address:

1. **Forwarder exit-to-hbmenu is a genuine gap (UNSUPPORTED today).** Exiting an autorun-launched app currently *no-ops* (or loops) rather than returning to hbmenu — a new exit path is required (I1).
2. **argv shape matters (CONFIRMED trap).** The task's literal stub command line `"…brewser.nro" --fwd=1 --app=x` would hit the `argv[1]`-is-entrypoint-override trap and brewser would fail to boot. Two clean fixes exist; pick one in Phase II (I2).
3. **No per-file hashes exist anywhere in the app pipeline (CONFIRMED).** `forwarder.json` hashes must be computed at generation time on-device; the generator must also *walk* the installed app dir because the file list is never persisted after install (I3, I7).
4. **HOS `rename`-overwrite semantics + real-hardware argv delivery + peak generation memory are hardware-only** (I2, I4, I9).

**Decisions that need Alex (surfaced, not taken — for Phase II):** (a) argv-trap fix — repeat-the-path vs. a ~5–10-line engine `resolve_entrypoint` change; (b) whether to add a first-class engine *file-backed Blob* to keep generation memory flat, or accept ~28 MiB resident in application mode; (c) whether the ledger `verify-patches.sh` gets its stale default paths fixed as part of this work.

---

## I0 — Environment recon — CONFIRMED

| Repo | Local path | Branch | Notes |
|---|---|---|---|
| Engine | `D:\Workspace\nxjs-extended` | `nxjs-extended` | `.git/HEAD` → `refs/heads/nxjs-extended`. V8/Skia fork of nx.js; **sole engine truth**. |
| Platform/shell | `D:\Workspace\brewser` | `main` | `package.json:2` name `brewser`, `:3` version **0.1.83**; NACP id `01f5905036d20000` (`package.json:31-33`). |
| Runtime bundle | `D:\Workspace\brewser-runtime` | `main` | `package.json:2` `@switch-web/runtime`. |

**pnpm `link:` targets** (all confirmed):
- `brewser-runtime/package.json:30` — `"@nx.js/runtime": "link:../nxjs-extended/packages/runtime"`.
- `brewser/package.json:20` — `"@switch-web/runtime": "link:./runtime"` (a Windows junction → `brewser-runtime`); `:24-26` — `@nx.js/nro`, `@nx.js/nsp`, `@nx.js/runtime` → `link:../nxjs-extended/packages/*`.
- Build: `brewser/package.json:8` `"nro": "node scripts/build-icon.mjs && node scripts/stage-main.mjs && nxjs-nro --fat && node scripts/unstage-main.mjs"`.

**Ledger system: ACTIVE and binding.**
- Engine ledger `nxjs-extended/NXJS_PATCHES_NEEDED.md` (~515 KB; highest engine entry **#117**, `NXJS_PATCHES_NEEDED.md:150`).
- Runtime ledger `brewser-runtime/RUNTIME_SHIMS.md` (highest entry **#119** WebNN, `RUNTIME_SHIMS.md:83`; `#118` at `:114`).
- Archive `nxjs-extended/NXJS_PATCHES_ARCHIVE.md` (tombstones, e.g. #40/#41).
- Auditor `nxjs-extended/scripts/verify-patches.sh` (1829 lines; content-greps each entry's re-apply marker).
- **Numbering is a single shared global space** across both ledgers (`RUNTIME_SHIMS.md:47-50` "Global entry numbering is shared … Never renumber"). **Max observed = #119 → next free = #120.**

**Two I0 gotchas the plan must respect:**
1. **`verify-patches.sh` default paths are stale (pre-rename).** `scripts/verify-patches.sh:23` defaults `RUNTIME` to `../../brewser-runtime-v8` and `:25` `BREWSER_V8` to `../../brewser-v8` — folders that no longer exist. Run it with `RUNTIME=…/brewser-runtime BREWSER_V8=…/brewser APPS=…/brewser-apps` overrides, or every runtime-ledger + brewser check silently reports MISSING. (Fixing these defaults is a candidate cleanup for Phase II.)
2. **The global number space has at least one collision:** `#105` is used twice — `NXJS_PATCHES_NEEDED.md:549` ("Page-level ES modules") **and** `RUNTIME_SHIMS.md:282` ("Snapshot toolbar avatar SDMC read"). "Never renumber" still holds; just start new entries at **#120** to stay clear of both ledgers.
3. **Marker-property guard rule (house rule #3) is codified:** `RUNTIME_SHIMS.md:26-32` — any runtime shim depending on engine internals must detect *its own* install via a marker property (`Symbol.for(...)`), never `typeof`/shape sniffing (the #34 throw-stub misclassification is the cautionary tale).

---

## I1 — How `autorunApp` works today — CONFIRMED (with an exit-path gap)

**Config → decision → launch:**
- Field + doc: `brewser/src/profile/browser-toolbar.ts:336-346` (`autorunApp: string;`, "navigates to this URL at boot instead of `DEFAULT_HOME_URL` … Home button always targets `DEFAULT_HOME_URL`"). Default `''` at `:474`; parse/normalize at `:632-634`.
- Read at boot: `brewser/src/browser-shell.ts:1299` `const shellConfig = loadConfig(this.profile.appRoot);` (loads `sdmc:/switch/brewser/configs/config.json`).
- Consumed exactly once: `brewser/src/browser-shell.ts:1408` `const bootUrl = resolveAutorunUrl(shellConfig.autorunApp) ?? DEFAULT_HOME_URL;`. `resolveAutorunUrl` at `:5451-5456` (empty→`null`→home; scheme passes through; bare path → `brewser://…`).
- Launch = a plain navigation: `browser-shell.ts:1410` (splash) / `:1416` (no-splash) `await this.navigateTo(bootUrl);` → `navigateTo` at `:1904` → `this.navigation.navigate(url)`.

**Key architectural fact:** there is **no "launch app by id" function.** An app is "launched" solely by navigating the WebView to `brewser://apps/<id>/<entry>`. So a forwarder's `--app` override just needs to influence the `bootUrl` computed at `browser-shell.ts:1408`.

**State before the app:** the *entire* shell is initialized regardless of autorun (`seedRomfs` `:1265`; keyboard/file-picker/select/date/time/color/number overlays `:1269-1294`; toolbar chrome `:1331`; wallpaper; cursor; applet check; net probe). Only the initial *navigation target* differs. The catalogue **page** (`home.html`) is genuinely never navigated to, so `buildLibraryPager` never runs on an autorun boot — but the **toolbar chrome still paints over the app** unless `showToolbar:false` (`browser-shell.ts:1325`, `:1330-1332`). A forwarder would likely set `showToolbar:false`.

**Exit behavior — UNSUPPORTED (this is the gap):** exiting an autorun-launched app returns to **neither** the catalogue **nor** hbmenu today.
- `case 'exit':` at `browser-shell.ts:1687`. With `currentAppDir` set it goes to a context-aware branch (`:1707-1762`) ending in `goBack()` (`:1760`).
- `goBack()` no-ops with no prior entry: `brewser/src/navigation/browser-navigation.ts:60-65`; controller returns `null` at depth 1: `brewser-runtime/src/navigation/navigation-controller.ts:34-40`, `:14-16` (`canGoBack = index > 0`).
- On an autorun boot the app URL is the **first and only** history entry (`index 0`) → `canGoBack` false → **exit is a no-op (user stuck)**.
- The only `Switch.exit()` path is the shell-context quit modal (`browser-shell.ts:1771`), unreachable while `currentAppDir` is set.
- `freshProcessOnExit:true` makes exit *chainload brewser* (`:1724-1751`) which re-autoruns the same app → **relaunch loop**, still never hbmenu.

→ **Forwarder mode must add a new exit path: `Switch.exit()` (process exit to hbmenu) when an app-context exit occurs at history depth 1.** Runtime change, no engine change.

**config.json seed** (`brewser/romfs/configs/config.json`): `autorunApp:""` (`:34`), `showSplash:true` (`:25`), `splashFadeMs:250` (`:27`), `showToolbar:true` (`:26`), `checkVerOnBoot:true` (`:22`), `homeSection` (`:29`), `buttonMapping` block with `exit→PLUS` (`:35-49`). No Settings UI writes `autorunApp` — it is config/hand-edited only.

> **NEEDS-HARDWARE-PROBE (I1-P):** set `configs/config.json` `autorunApp` to an installed app's `/apps/<id>/index.html`, boot, press the app's exit button. Expect: no-op / stuck (and with a manifest `freshProcessOnExit:true`, a relaunch loop). Confirms the gap the forwarder must close.

---

## I2 — argv end-to-end — CONFIRMED (delivery to JS) + NEEDS-HARDWARE-PROBE (real chainload)

**argv reaches JS today as the full positional vector.** No engine change is required to *surface* argv.
- Native populates all `argc` entries: `nxjs-extended/source/main.cc:1193-1198` (`for (i=0..argc) argv_array->Set(i, argv[i])` onto `$.argv`).
- Exposed verbatim: `nxjs-extended/packages/runtime/src/switch/index.ts:269` `export const argv = $.argv;`; typed `argv: string[]` at `packages/runtime/src/$.ts:534`. So `Switch.argv` = the complete arg list including argv[0] and any `--fwd=1 --app=x` flags at argv[2+].

**The `argv[1]` entrypoint-override is real and current.** `resolve_entrypoint` (`source/main.cc:1422`, body `:1424-1490`) dispatches on argv[1]:
- `argv[1]=="nsp:"` → `romfsMountFromCurrentProcess` → `romfs:/main.js` (`:1433-1451`).
- `argv[1]` ends `.nro` → `mount_nro_romfs(argv[1])` → `romfs:/main.js` (`:1452-1462`).
- **else → `strdup(argv[1])` as a literal entrypoint path + `read_file(argv[1])`** (`:1463-1468`) — **the trap.**
- no argv[1] → `romfsMountSelf` → `romfs:/main.js` (standalone; **this is brewser's normal boot**, `:1470-1489`).
- **argv[2+] are never read by `resolve_entrypoint`** — flags there don't affect entrypoint resolution.

**`Application.launch(...args)` → `envSetNextLoad`:** native `nx_ns_app_launch` at `source/ns.cc:302`; builds a quoted argv string `"path" "arg1" …` and calls `envSetNextLoad(launch_path, args)` at `ns.cc:256-270`; `new Switch.Application(path)` sets `is_nro` (`ns.cc:70-103`), and `launch()` requires `is_nro` (`ns.cc:241`), so a fat `brewser.nro` path goes down the `envSetNextLoad` branch. Each JS-passed arg becomes argv[1], argv[2]…

**The trap bites the task's literal contract.** The command line written in the task (§5.1) — `envSetNextLoad("…/brewser.nro", "\"…/brewser.nro\" --fwd=1 --app=<appId>")` — parses to `argv[0]="…/brewser.nro"`, **`argv[1]="--fwd=1"`** → falls into the literal-path `else` → `read_file("--fwd=1")` fails → **brewser fails to boot.** Two clean fixes (Phase II decision):
- **(a) Repeat the brewser path as argv[1]** (zero engine change): `launch("sdmc:/switch/brewser/brewser.nro", "--fwd=1", "--app=x")` (JS) or the C-stub equivalent `envSetNextLoad(path, "\"path\" \"path\" --fwd=1 --app=x")`. argv[1] is the `.nro` path → `mount_nro_romfs` → `romfs:/main.js`; flags at argv[2+]; brewser reads `Switch.argv.slice(2)`. This mirrors the slim-launcher convention at `bootstrap/launcher-nro/source/main.c:64-66`.
- **(b) ~5–10-line engine change** to `resolve_entrypoint` (`source/main.cc:1431-1469`): when argv[1] starts with `--`, treat it as a flag (skip it, fall through to the standalone `romfsMountSelf` path). This makes the task's literal contract work as written and is the "clean first-class" option. Would need ledger entry **#120**.

**Citron cannot test any of this.** `source/detect.cc:5-9` — Citron's NRO loader doesn't populate the hbloader env block (`… && !has_argv`); `source/main.cc:1623-1624` restates it. So the whole forwarder→brewser handoff is **real-hardware-only**.

> **NEEDS-HARDWARE-PROBE (I2-P):** on real hardware, from a forwarder do `new Switch.Application("sdmc:/switch/brewser/brewser.nro").launch("sdmc:/switch/brewser/brewser.nro","--fwd=1","--app=TESTID")`; in brewser's `main.js` log `Switch.entrypoint` and `JSON.stringify(Switch.argv)`. Expect `entrypoint==="romfs:/main.js"` (per `main.cc:1189-1191`) and argv `["…/brewser.nro","…/brewser.nro","--fwd=1","--app=TESTID"]` with all tokens intact. Also probe a token-count ceiling if many flags are planned.

---

## I3 — Local app storage / install — CONFIRMED (installed apps are fully offline; no per-file hashes)

**Root + layout (flat):** `BREWSER_APP_ROOT = 'sdmc:/switch/brewser/'` (`brewser-runtime/src/browser-config.ts:28`). Installed apps live at `sdmc:/switch/brewser/apps/<id>/` (folder == id). Confirmed on both write (`brewser/romfs/shell/scripts/download-modal.js:385`) and read (`brewser/src/profile/browser-toolbar.ts:900-901`; enumeration doc `brewser-runtime/src/platform/installed-apps.ts:29`). NOTE: several `browser-shell.ts` **comments** say `apps/<group>/<id>/` — that wording is **stale**; the code is flat (`brewser/src/shell/nav-helpers.ts:118-143`, `catalogue-normalizer.ts:562`).

**Install flow** (the download modal *is* the installer — no separate install manager): `download-modal.js` `runInstall` (`:516`) reads the cached catalogue (`readCachedCatalogue()` → `configs/catalogue.json`, `:548`), fetches the per-app inventory `app.artifactsUrl` (`:567`) → `parseArtifacts` (`:594`), `mkdirSync` the app dir (`:605`), then `downloadFiles` (`:349`) writes each file `Switch.writeFileSync(APP_ROOT+'apps/'+id+'/'+rel, buf)` (`:435`). The entry file (`index.html`) is written **last** (`:323-341`, `:357`) so an interrupted install stays flagged missing.

**On-disk file set** = the artifact `files[]` list + entry, verbatim rel paths: `index.html`, assets/bundle, the logo/banner, and `manifest.json`. The per-file inventory doc `artifacts/<id>.json` = `{ id, sizeBytes, files: string[] }` (`brewser-runtime/src/platform/artifacts.ts:11-16`, `:38-46`) is fetched transiently at install and **NOT persisted to disk**.

**Manifest on disk** = `apps/<id>/manifest.json`, read by `installed-apps.ts` (which requires only `manifest.json` to exist, `:113`, and checks the single `entry` file exists, `:135`). **No per-file list and no per-file hashes in the manifest.** No `.forwarder-meta` sidecar exists anywhere.

**Catalogue `NormalizedApp` shape** (`catalogue-normalizer.ts:76-129`): `entryRel`, `logoRel`, `entryUrl`, `logoUrl`, `artifactsUrl`, whole-app `sizeBytes`, `fileUrl(rel)`. No per-file digest.

**Icon is cached locally on install** (it is just another `files[]` entry, written to disk; filename = the manifest `logo` field, commonly `appbanner.jpg`/`.png` per `download-modal.js:118`). Read from disk when present: `browser-toolbar.ts:1026-1054` (uses `brewser://apps/<id>/<logoRel>` when the local file exists, else remote `logoUrl`, else bundled `download.png`).

**Definitive offline answer — YES for *installed* apps.** Launch, assets, manifest, and icon all load from SD with zero network; the installed-apps enumeration is explicitly disk-authoritative (`installed-apps.ts:6-10`). This is a real local-install layout, not a temp/streamed model. **Caveats the plan must respect:** (a) an app that is *listed but not installed* ("available") has **no local files** — cannot be forwardered offline (matches the task's "app must be locally installed" precondition); (b) there is **no post-install manifest of what was written**, so the generator must **walk `apps/<id>/` recursively** (`Switch.readDirSync`, available per I4) to enumerate files, and a partial install is only detectable via the single entry-exists probe.

**Per-file hashes in the pipeline — NONE (I3.6).** `artifacts.ts`, `catalogue-normalizer.ts`, and `stats.ts` carry only whole-app `sizeBytes`; the download loop writes bytes with only an HTTP `resp.ok` check. The **only** SHA-256 machinery in the tree is the unrelated NRO self-updater (`brewser/src/update/verify.ts` etc.). → `forwarder.json` per-file hashes must be **computed at generation time on-device** (feasible; see I7).

> **NEEDS-HARDWARE-PROBE (I3-P):** install any app, then inspect `sdmc:/switch/brewser/apps/<id>/` on the SD card — verify it contains `manifest.json`, `index.html`, the logo, and the `artifacts/<id>.json` file list, with **no** per-file hash sidecar and **no** `.forwarder-meta`. Confirms the exact tree the generator will walk.

---

## I4 — JS filesystem capability — CONFIRMED (rename-overwrite = HW probe)

Native FS bindings registered in `nx_init_fs` (`nxjs-extended/source/fs.cc:918-941`): `writeFile`/`writeFileSync`/`appendFileSync` (`:938-940`), `mkdir`/`mkdirSync` (`:925/:927`), `rename`/`renameSync` (`:934/:935`), `remove`/`removeSync` (`:932/:933`), `readDirSync`/`readDirNext` (`:928/:929`), `readFile`/`readFileSync` (`:930/:931`), `stat`/`statSync` (`:936/:937`). Surfaced onto `Switch.*` via `packages/runtime/src/switch/index.ts:14` (`export * from '../fs'`); TS wrappers in `packages/runtime/src/fs.ts` (`writeFileSync:242`, `mkdirSync:102`, `renameSync:301`, `removeSync:281`, `readDirSync:193`, `statSync:310`).

- **Writes auto-create parent directories** — `write_file_do` calls `createDirectoryRecursively(dir, 0777)` before `fopen(...,"w")` (`fs.cc:578-587`, sync path `:635-644`). Writing `sdmc:/switch/foo/bar.nro.tmp` implicitly makes `sdmc:/switch/foo/`.
- **Free space:** `Switch.FileSystem.openSdmc()` (`packages/runtime/src/switch/file-system.ts:92-94`) → `freeSpace()` → `nx_fs_free_space` → `fsFsGetFreeSpace` returning a **bigint of bytes** (`source/fsdev.cc:132-143`). `totalSpace()` likewise (`fsdev.cc:145-157`).
- **No engine path/size restriction** — the JS path string goes straight to `fopen` (`fs.cc:254`, `:619`); no allow-listing, no size cap; a `bigFile` path exists for >4 GB (`fs.ts:389`).
- **Streaming sink:** `Switch.file(p).writable` returns a real `WritableStream` (`fs.ts:480-500`) — opens with `'w'` (truncates) on the first chunk, reuses the handle, appends each chunk via thread-pool `fwrite`. `Switch.file(p).stream()` gives a byte `ReadableStream` (`fs.ts:435-478`). So `someReadable.pipeTo(Switch.file(path).writable)` is a supported end-to-end streaming path (this is exactly the self-update idiom, see I9).

> **NEEDS-HARDWARE-PROBE (I4-P): rename-overwrite semantics.** `rename` is a bare POSIX `rename()` with no dest pre-check (`fs.cc:857`, sync `:883`); whether it atomically overwrites an existing target or throws `EEXIST` is decided by the libnx/HOS FS layer, not this code. Probe: write `a.bin` and `b.bin`, `renameSync('a.bin','b.bin')`, read back `b.bin` — content of `a` = overwrite; a throw = "must `removeSync` target first". This determines the safe `.tmp → final` write pattern (the self-updater already uses *remove-then-rename* to sidestep this — a proven fallback).

---

## I5 — Pack tooling portability — CONFIRMED (Web-API, streamable, small vendoring job)

The `packages/nro/src/main.ts` CLI is a thin Node wrapper; the real encode/decode lives in three external packages whose **core logic is 100% Web-API with zero Node dependencies.** Sources read directly from the pnpm store:

| Package | Version | Path (`…/node_modules/.pnpm/…/@tootallnate/…`) | Verdict |
|---|---|---|---|
| `@tootallnate/nro` | 0.1.3 | `@tootallnate+nro@0.1.3/…/nro/src/index.ts` | CONFIRMED pure Web-API |
| `@tootallnate/romfs` | 0.1.1 | `@tootallnate+romfs@0.1.1/…/romfs/src/index.ts` | CONFIRMED pure Web-API |
| `@tootallnate/nacp` | 0.2.1 | `@tootallnate+nacp@0.2.1/…/nacp/src/index.ts` | CONFIRMED pure in-memory struct |

- **`@tootallnate/nro`:** `decode(Blob)→NRO` (`:75`), `encode(NRO)→Blob` (`:135`); NRO = `{data,icon,nacp,romfs}` all `Blob`. Only import is `@tootallnate/nacp` (`:2`) — no `node:*`, no `Buffer`. **ASET splice** = a 0x38-byte header appended after `nro.data` with three `{offset,size}` u32 pairs (icon/nacp/romfs) at 0x8/0x18/0x28 (`:135-187`) — ~50 lines. `encode` builds `BlobPart[]` pushing large payloads **by reference** and returns `new Blob(parts)` (`:136,:187`) → **lazy/streamable**.
- **`@tootallnate/romfs`:** `encode(RomFsEntry)→Blob` (`:285`), `decode(Blob)→RomFsEntry` (`:46`). `RomFsEntry` = nested `{ [name]: RomFsEntry | Blob }`. **Zero imports.** Faithful switch-tools `romfs.c` port (~250 lines: `walkFs` `:208-283`, `calcPathHash` `:168-181`, header/tables `:345-506`). `encode` reads only `blob.size` during assembly (never file contents) and pushes file Blobs by reference (`:451`), returning `new Blob(blobParts)` (`:508`) → **streamable; only the small dir/file/hash tables are materialized.**
- **`@tootallnate/nacp`:** `class NACP` backed by a fixed `0x4000` `ArrayBuffer` (`:38-64`); pure `DataView` getters/setters. **UTF-8 limits enforced in code:** `encodeWithSize` throws if `>= size`; `title` uses `0x200` written to 12 lang slots at `i*0x300` (`:73-78`) → title **< 0x200 bytes/lang**; `author` uses `0x100` (`:85-90`); `version` `0x10` (`:210-213`). Matches the task's constraints exactly.

**Node coupling exists only in the wrapper/CLI layers you re-author (not the algorithm):**
- `@nx.js/patch-nacp` (`packages/patch-nacp/src/index.ts:2,104`): `readFileSync` from `node:fs` reads package.json — replace with an already-parsed in-memory manifest, then call the portable `NACP` setters (`nacp.id/title/version/author`, `:119-143`) unchanged. Its helpers `parse-author`/`title-case` are pure-JS (vendor or inline).
- `packages/nro/src/main.ts` (`:4-17`): `node:fs`/`node:url`/`node:path`, `Buffer`, `chalk`/`bytes`/`terminal-image` — all I/O glue re-authored against Brewser's SD API. Its only forced materialization is `Buffer.from(await outputNro.arrayBuffer())` (`:217`); **drop that and stream the output Blob to SD instead.**

**Vendoring status:** no copy/submodule exists in `brewser-runtime` today (only lockfile references under `examples/`). Upstream = `github.com/TooTallNate/switch-tools` `packages/{nro,romfs,nacp}` (MIT) — clean vendor target.

**Streaming verdict:** both `NRO.encode` and `RomFS.encode` return lazy composite Blobs → drive `blob.stream()` to `Switch.file().writable`, keeping peak heap to the small metadata tables, **not** the full forwarder size. **One caveat that ties to I9:** RomFS requires each embedded file as a `Blob`. If Brewser's Blobs are memory-backed (the likely case — a Blob built from a file's `ArrayBuffer`), the app's *file data* (~28 MiB worst case) is resident during encode; a lazily-SD-backed Blob would keep it flat but that is a property of the engine's Blob implementation (open design question for Phase II — see Cross-cutting §2).

---

## I6 — Icon pipeline — CONFIRMED (on-device JPEG encode is real and linked)

- **`toDataURL`/`toBlob`/`convertToBlob('image/jpeg')` all present** on both `Screen` and `OffscreenCanvas`. Native `toDataURL` registered on the shared canvas prototype (`nxjs-extended/source/canvas.cc:2055`, body `:2826`, honors JPEG via `mime_to_type_code("image/jpeg")→1` at `:2837`/`:2706-2712`). JS: `Screen.toBlob` (`packages/runtime/src/screen.ts:233-241`), `OffscreenCanvas.convertToBlob({type:'image/jpeg',quality})` (`offscreen-canvas.ts:47-52`).
- **JPEG *encoder* is compiled AND linked** — decisive: via **libjpeg-turbo** `tjCompress2(...)` (`canvas.cc:2656-2674`, `#include <turbojpeg.h>` at `:30`), with `-lturbojpeg … -ljpeg` in `nxjs-extended/Makefile:120`. (There is **no** `SkJpegEncoder` in `source/` — JPEG encode does *not* route through Skia.) PNG encode is Skia `SkPngEncoder` (`canvas.cc:52,2694`); WebP via `WebPEncodeBGRA` (`:2678`). Note: `TJSAMP_420` chroma subsampling is hardcoded (`:2665`) — fine for a 256×256 icon; quality (0–1→0–100) is passed through.
- **Decode:** PNG (libpng), JPEG (turbojpeg), WebP (`image.cc:45-66`). **SVG is minimal** (only Khronos-style solid-fill `red-green.svg`; gradients/paths → NULL, `image.cc:68-79`). **No ICO.** For the forwarder (decode a cached PNG/JPEG banner, re-encode JPEG) this is sufficient; treat SVG source icons as unsupported.
- **Resize path:** `new OffscreenCanvas(256,256)` (`offscreen-canvas.ts:40-45`), `getContext('2d')` (`:54-72`), `drawImage` 9-arg resample (`canvas.cc:2424-2527`, dest-rect at `:2503-2525`).

**No fallback needed.** Recommended pipeline (all supported on-device): decode source banner via `Image`/`createImageBitmap` → `new OffscreenCanvas(256,256)` → `ctx.drawImage(img,…,256,256)` → `await canvas.convertToBlob({type:'image/jpeg', quality})` → `await blob.arrayBuffer()` → hand to the NRO packer / write. The submission-time pre-encode and JS-encoder fallbacks the task lists are **not required** (recommend against them).

> **NEEDS-HARDWARE-PROBE (I6-P, low priority):** confirm a 256×256 JPEG produced by `convertToBlob('image/jpeg')` on-device is accepted by hbmenu as an NRO icon (visual check) — code proves the encoder is linked; only a device confirms hbmenu renders it.

---

## I7 — Hashing — CONFIRMED (SHA-256 works; whole-buffer only)

- **`crypto.subtle.digest('SHA-256', data)` works** — `packages/runtime/src/crypto.ts:249-257` → native `nx_crypto_digest` dispatching SHA-256 via libnx's hardware `sha256CalculateHash` (`nxjs-extended/source/crypto.cc:167-190`). Genuine digest, independent of the HMAC/sign/verify machinery; returns an `ArrayBuffer` off the thread pool.
- **Whole-buffer only — no streaming/`update`/`final`.** The API hashes one `BufferSource` in a single call (`crypto.cc:236,:188-202`), and the runtime doc says so explicitly (`crypto.ts:236-237`). → each forwarder file must be materialized in memory before hashing.
- `sha256Hex(str)` exists natively (`crypto.cc:972-986`) but is **string-only** (not binary) and not re-exported on `Switch.*` — not usable for file bytes. No native chunked/rolling hash, no CRC32.

**Recommendation:** since the generator already reads each app file into a Blob/ArrayBuffer to add it to the RomFS (I5), computing `crypto.subtle.digest('SHA-256', fileBytes)` per file at that moment is free of extra I/O. Reusing pipeline hashes is *not an option* (none exist — I3.6). Files are individually small (largest single member 14.65 MiB, I9), so whole-file digest per file is fine. The stub then re-hashes each extracted file against `forwarder.json` (component A).

---

## I8 — Stub distribution & packaging — CONFIRMED

- **Build:** `Makefile:183` `nro: build current-json seed-fingerprint` → `npm run nro` (`package.json:8`, `nxjs-nro --fat` bakes `romfs/` + NACP into a **fat** NRO). JS bundle via `scripts/build-main.mjs`; `scripts/stage-main.mjs` copies `build/main.js(.map)` into `romfs/` for packaging, `scripts/unstage-main.mjs` removes them after.
- **RomFS baked into the NRO** (from `romfs/`): `configs/` (~104 K), `emojis/` (9.9 M), `shell/` (1.8 M — pages + `scripts/` + `assets/`), `themes/` (1.3 M), `seed-fingerprint` (32 B).
- **Release:** `Makefile:235-246` `release: bump → nro → current.json → versions.json → mv dist/ → sign-release.mjs → verify-release.mjs`. Output: `dist/brewser.nro`, `dist/update.json`, root `versions.json`. `dist/brewser.nro` = **69,610,000 bytes (~69.6 MB)** (`update.json` `nroSize:69610000`).
- **Seeding** (`brewser/src/profile/browser-profile.ts`): `seedRomfs()` (`:257-277`) recursively mirrors `romfs:/` → `sdmc:/switch/brewser/` via `fetch('romfs:/…')` + `writeFileSync` (`:338-341`). Re-seed trigger = `seed-fingerprint` change (`:267`, `:283-303`). **Only `shell/` + `themes/` are "app-owned" (force-overwritten on fingerprint bump)** — `isAppOwnedRel` (`:363-366`), overwrite gate `:335-336`; everything else is **missing-only**. `SEED_SKIP_ROOT_FILES` (`:33-42`) skips `main.js`, `main.js.map`, `GeistMono.ttf`, `runtime.js.map`, `seed-fingerprint`.

**Stub embedding — recommendation:** embed inside the fat NRO and read at generation time; do **not** ship a first-boot sibling.
- **Preferred: `romfs:/forwarder-stub.nro`**, read via `Switch.readFileSync('romfs:/forwarder-stub.nro')` at generation. Add its filename to `SEED_SKIP_ROOT_FILES` (`browser-profile.ts:33-42`) so the seeder never mirrors a redundant/stale copy to SD (a root-level, non-app-owned file would otherwise be seeded **missing-only** and go stale). Fully offline, zero seeding.
- If an on-disk SD copy is ever required, the only version-locked spot is **under `shell/`** (force-re-seeded on fingerprint change) — never the romfs root.

**Version-lock — automatic.** The self-updater hashes and replaces the **entire NRO as one signed unit**: `dist/update.json` carries `chunks[]` SHA-256 (one per 4 MiB), a `rootHash`, and `components:{brewser:"0.1.83", counter:82}`; the atomic whole-NRO swap is `src/update/apply.ts:40-60`. Anything in `romfs/` (a stub included) is covered by those chunk hashes and swapped atomically — so a bundled stub's argv contract can never desync from the runtime that reads it (they are the same file). Build identity is baked via `scripts/build-main.mjs:57-63` defines, read defensively in `src/update/config.ts:75-92`.

**Size:** a ~300 KB stub is ~0.4 % of the 69.6 MB NRO — negligible, dwarfed by the 9.9 MB emoji bundle, and clears the updater's free-space preflight (`config.ts:57-58`, `FREE_SPACE_MULTIPLIER=3`, `+64 MiB`).

---

## I9 — Memory & size envelope — CONFIRMED (worst case fits application mode; stream to SD)

- **Largest app:** `com.natureglass.2dplatformermicrogame` (Unity WebGL) = **29,104,167 bytes ≈ 27.76 MiB** total (`brewser-apps/catalogue.json:39`; corroborated `artifacts/…2dplatformermicrogame.json:3`). Biggest **single file** (RomFS holds each individually): `Build/custom_apps.wasm` = **14.65 MiB**, `Build/custom_apps.data` = 12.69 MiB. 28 apps in the catalogue.
- **V8 heap ceiling** (`nxjs-extended/source/main.cc:2011-2020`, regime chosen at `:1571`): **512 MiB application** / **~89 MiB applet-jitless (default)** / ~41 MiB applet-JIT / 32 MiB floor applet-JIT-GPU. Exposed as `heapSizeLimit` via `Switch.memoryUsage()` (`source/memory.cc:33`).
- **Critical nuance:** binary `ArrayBuffer`/`Uint8Array` backing stores are malloc'd from the **native heap**, not the V8 object heap (`main.cc:1891-1892`, `NewDefaultAllocator`). So bundle bytes consume **native headroom**, not `heapSizeLimit`. In **applet mode native slack is only tens of MiB** (`main.cc:1936-1940` documents a ~5 MiB shortfall for a streaming decompress) → assembling ~28 MiB in-memory is close to the applet margin. **Application mode is comfortable (GiB of native).** (The prior "audio PCM 96 MB budget" note appears to conflate the Skia GPU cache / applet reserve constants; no hard audio cap found.)
- **Streaming multi-MB to SD is an established, load-bearing pattern:** `brewser/src/update/guarded-fs.ts:38-39` (`writableFor` → `Switch.file(...).writable`), self-update download reads body chunk-by-chunk and never buffers (`src/update/net.ts:262-263`, doc `:223-225`), file copy streams (`src/update/apply.ts:49-59`). Strong evidence the same approach works for forwarder output.

**Facts for the in-memory-vs-streamed decision (not decided here):** worst-case output 27.76 MiB total / 14.65 MiB largest member; application-mode headroom is ample, applet-mode is tight; RomFS/NRO encode return lazy Blobs so the *output* streams to SD keeping heap to small tables (I5). The residual question is whether the *input* app bytes stay resident (memory-backed Blobs) — ~28 MiB worst case, fine in application mode.

> **NEEDS-HARDWARE-PROBE (I9-P):** measure actual peak memory during a real generation of the 27.76 MiB worst-case app via `Switch.memoryUsage()` (`heapSizeLimit`/`usedHeapSize`/`mallocedMemory`/`peakMallocedMemory`) **in both launch regimes**, and first establish **which mode Brewser actually runs in** when launched normally from hbmenu (applet vs application "title override"). This decides whether generation must hard-require application mode / stream aggressively / cap by app size.

---

## I10 — UI surface — CONFIRMED

- **The per-app modal is universal and lives in `romfs/shell/home.html`** (there is **no `apps.html`** in the current tree), controlled by `romfs/shell/scripts/missing-app-modal.js` (despite the name, it drives installed *and* missing apps). Markup `home.html:191-277`: `#app-modal-overlay` (`:191`), `#app-modal-card` (`:192`), `#app-modal-title` (`:211`), `#app-modal-identifier` (`:212`), `#app-modal-description` (`:227`), `#app-modal-body` (`:242`), icon `#app-modal-logo`, action buttons `#app-modal-delete` (`:259`), `#app-modal-update` (`:260`), `#app-modal-cancel` (`:271`), `#app-modal-play` (`:272`), `#app-modal-download` (`:273`). The action row has a LEFT slot (`.app-modal-actions-side`, installed-only actions like Delete) and a RIGHT slot — a "Create App Forwarder" button most naturally joins the LEFT slot.
- **Button pattern:** static markup + per-node `addEventListener` in the controller (`missing-app-modal.js:945-973`); handlers hand off to sibling modals via `globalThis.__brewser*` openers.
- **Progress/error/success reuse (no new CSS):** `download-modal.js` `setLoading/setProgress/setError/setSuccess` (`:139-160`) toggle `download-modal-card--{loading,success,error}` and set `progressFill.style.width` (`:180`); the self-update modal reuses these verbatim (`self-update-modal.js:62-83`). A forwarder-generation UI should follow the same scheme.
- **Non-blocking long task:** the real pattern is a **per-file `async/await` loop** with cooperative-cancel checkpoints (`download-modal.js:349-453`), work deferred one microtask so the loading frame paints first (`:657`, `Promise.resolve().then(...)`). (A true `getReader()` streaming loop exists only on the native self-update copy path, `apply.ts:49-59` — the closer template if generation streams bytes.) *[Prior "reader loop / rAF" note was imprecise — corrected here.]*
- **Bridge seam (how a page script triggers privileged work):** the shell installs capability functions on the shared `globalThis` (`src/update/seam.ts:37-61` `installSelfUpdateSeam()` → `globalThis.__brewserSelfUpdate`; `src/browser-shell.ts:1167-1193` `installPlatformBridge()` → `globalThis.__brewserPlatformClient`); page scripts consume them with `typeof … === 'function'` guards. **Forwarder plan:** add a shell-side installer (mirroring `installSelfUpdateSeam`) putting e.g. `globalThis.__brewserCreateForwarder = async (detail, ui) => {…}` on `globalThis`, called from the modal exactly as `self-update-modal.js` calls `__brewserSelfUpdate.prepare(ui)`.
- **"Is locally installed" signal:** cards carry a `data-app-detail` JSON blob (`src/resources/browser-resource-loader.ts:1403-1470`) with `id`, `name`, `url`, `missing`, `installedVersion`, `entry`, `logo`. The controller parses it on tap (`missing-app-modal.js:850-859`) and already branches on `currentDetail.missing` (`:776`). **Enable "Create App Forwarder" only when `detail.missing === false`** (installed), toggled with the existing `app-modal-btn--hidden` class.

---

## Consolidated hardware-probe checklist (for Alex)

All probes require **real CFW hardware** — Citron cannot exercise the argv path (I2) and its offline banner behavior differs.

| # | Probe | Decides |
|---|---|---|
| I2-P | Chainload `brewser.nro` with `launch("<brewser.nro>","--fwd=1","--app=TESTID")`; log `Switch.entrypoint` + `Switch.argv` in brewser's `main.js`. | argv delivery through a real chainload; that the argv shape boots brewser's own `romfs:/main.js` with flags intact. |
| I4-P | Write `a.bin`/`b.bin`; `renameSync('a','b')`; read `b`. | HOS `rename`-overwrite vs `EEXIST` → the safe `.tmp→final` swap pattern. |
| I1-P | Set `config.json autorunApp` to an installed app; boot; press exit. | Confirms the exit-to-hbmenu gap (no-op / loop today). |
| I3-P | Inspect `sdmc:/switch/brewser/apps/<id>/` after a real install. | Exact tree the generator walks; absence of per-file hashes / `.forwarder-meta`. |
| I9-P | `Switch.memoryUsage()` peak during a real generation of the 27.76 MiB worst-case app, both launch regimes; determine Brewser's actual applet-vs-application mode. | In-memory-vs-streamed generation; whether to require application mode / cap by size. |
| I6-P | Visual: hbmenu renders an on-device-encoded 256×256 JPEG icon on a generated forwarder. | Confirms the linked encoder's output is hbmenu-valid (low priority; encoder linkage already proven in code). |

---

## Cross-cutting findings & open design questions (for Phase II — not decided here)

1. **argv-trap fix (I2):** repeat-the-brewser-path in argv[1] (zero engine change) **vs.** a ~5–10-line `resolve_entrypoint` change to skip `--`-prefixed argv[1] (makes the task's literal contract work; needs ledger #120). Alex's call.
2. **Generation memory (I5+I9):** RomFS input requires each file as a `Blob`. If the engine's Blobs are memory-backed, ~28 MiB of app bytes are resident during encode (fine in application mode, tight in applet). Option to add a first-class **SD-file-backed Blob** to the engine to keep generation flat — an engine addition worth weighing vs. simply requiring application mode + streaming output.
3. **Exit-to-hbmenu (I1):** new runtime exit path (`Switch.exit()` at history depth 1 in forwarder mode). Must be gated so existing (non-forwarder) `autorunApp` and normal browsing exit behavior are *completely unchanged*.
4. **Per-file integrity (I3+I7):** hashes computed at generation time; the stub verifies size+sha256 per extracted file. No pipeline change needed.
5. **Ledger hygiene (I0):** `verify-patches.sh` stale default paths (`brewser-runtime-v8`/`brewser-v8`) should be fixed if any engine entry (#120) lands; new entries start at **#120** to avoid the two ledgers' used range and the #105 collision.
6. **Pack library placement (I5):** vendor `@tootallnate/{nro,romfs,nacp}` (+ a re-authored in-memory `patch-nacp`) as a **platform-agnostic** module in `brewser-runtime` so a future web generator can reuse it — no Node/SD coupling in the library itself.

---

## Verdict summary

| Item | Verdict | One-line |
|---|---|---|
| I0 Environment | **CONFIRMED** | Paths/branches/links known; ledger active (next free **#120**); `verify-patches.sh` needs path overrides. |
| I1 autorunApp | **CONFIRMED** + **UNSUPPORTED (exit)** | Config-driven boot navigation; exit-to-hbmenu path must be added. |
| I2 argv | **CONFIRMED** + **NEEDS-HARDWARE-PROBE** | `Switch.argv` full vector; argv[1] trap has a clean fix; Citron can't test it. |
| I3 App storage | **CONFIRMED** | Installed apps fully offline; **no per-file hashes**; generator must walk the dir. |
| I4 Filesystem | **CONFIRMED** + **NEEDS-HARDWARE-PROBE (rename)** | Full write/mkdir/rename/remove/stat + streaming + `freeSpace`; auto-mkdir. |
| I5 Pack tooling | **CONFIRMED** | 100% Web-API, streamable; small vendoring job; node coupling only in CLI/patch-nacp. |
| I6 Icon | **CONFIRMED** | On-device 256×256 JPEG encode is real & linked (libjpeg-turbo); no fallback needed. |
| I7 Hashing | **CONFIRMED** | `crypto.subtle.digest('SHA-256')` works; whole-buffer only; hash at gen time. |
| I8 Stub dist | **CONFIRMED** | Embed `romfs:/forwarder-stub.nro` (+`SEED_SKIP`); auto version-locked by signed whole-NRO. |
| I9 Memory | **CONFIRMED** + **NEEDS-HARDWARE-PROBE (peak)** | 27.76 MiB worst case; fine in application mode; stream output to SD. |
| I10 UI | **CONFIRMED** | Modal in `home.html` + `missing-app-modal.js`; reuse `--loading/--success/--error`; `__brewser*` seam. |

---

## ⛔ STOP — Phase I complete

Per the methodology, this is a hard stop. **No plan, no code has been written.** Awaiting review of this investigation before proceeding to Phase II (Plan).
