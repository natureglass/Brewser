# Runtime Adaptation Options — bringing brewser-v8 / brewser-runtime-v8 onto the new platform contract

Companion to `PLATFORM_CONTRACT_FINDINGS.md` (breaking changes BC1–BC7 referenced below). Four genuinely different strategies. None is started; this is a decision document.

**Shared baseline (needed under every option, ~zero design risk):**
- Re-vendor `runtime/dist/` from `brewser-runtime-v8` (picks up the already-fixed WP downloads/ratings URLs — BC3).
- Revoke the committed GitHub PAT (`brewser-runtime-v8/telemetry/Test-GitHubDispatch.ps1:38`) — independent of any option.

---

## Option 1 — Minimal conformance patch ("teach the old skeleton the new dialect")

Patch each of the ~8 existing consumption sites in place; keep the current architecture (TS shell parses → romfs page scripts fetch/diff/download).

**Work order:**
1. Re-vendor dist (baseline).
2. Catalogue adapter inline at the two read points: `readCatalogGroup`/`loadCatalogGroup` (`src/profile/browser-toolbar.ts:880-900`) and `diffCatalog` (`romfs/shell/scripts/updates-modal.js:463-520`) accept `{apps:[]}`; map the flat list into the existing card pipeline (simplest: one "Apps" collection; tabs collapse or repurpose as category filters later).
3. Flatten path construction: drop the `<group>` segment in `browser-toolbar.ts:785/801/818/853`, `nav-helpers.ts:124-133` (accept `apps/<id>/…`), `download-modal.js`, `updates-modal.js:308`, `missing-app-modal.js:206`. Decide policy for old `apps/<tier>/<id>/` installs (simplest: ignore; user re-downloads — Open Q8).
4. Fix the rating payload `data:['like',n]` → `data:['stars',n]` (`missing-app-modal.js:509`) — BC4.
5. Permission vocabulary shim: name→slug map (`"Usb"→'usb'`, `"Device Info"→'device_info'`, …) applied before `setManifestPermissions` (`src/browser-shell.ts:1908-1912`) and before warnings lookup — BC5. (Engine-side alternative: normalize inside `setManifestPermissions` itself, which fixes every future caller.)
6. Card metadata: read `categories[0]`/join instead of `category` (`browser-toolbar.ts:821`) — BC6.
7. Re-seed `romfs/configs/catalogue.json` with the current prod catalogue; migrate `homeSection` values.

**Effort / sequencing:** the smallest option — roughly 2–3 working sessions plus one hardware test pass. Slots cleanly *before* resuming the Unity milestone, because it touches none of the engine paint/WebGL surface the Phase A/B demo-isolation and patch-ledger work lives in.

**Later cost:** the contract knowledge stays smeared across six files in two languages (TS + page JS). The next platform drift (e.g. catalogue `version: 2`, a renamed field) fails silently again, in the same places, with the same "empty rail" symptom. No single place to look.

**Risk on CFW:** medium. Each patched site is individually verifiable, but the same shape assumptions are duplicated in TS and page JS — easy to fix one and miss the other. Early detection: after step 2, a visible "catalogue vN — X apps" line on apps.html (replacing silent-empty) turns every future drift from invisible to obvious; test with canned fixtures in Citron (no network there), real fetch verified on hardware only.

**Platform-side needs:** none mandatory. Optional: `usb` entry in `permissions.json`.

---

## Option 2 — Clean platform-client abstraction ("one door to the platform")

Introduce a single `platform-client` module (living in `brewser-runtime-v8/src`, consumed by the shell) that owns fetching, parsing, validating, and **normalizing** everything platform-shaped; the shell and page scripts consume only the normalized model.

**Work order:**
1. Baseline (re-vendor + PAT).
2. Define the normalized model: `NormalizedCatalogue { version, generated, apps: NormalizedApp[] }`; `NormalizedApp` with `id, name, version, entry, logo, categories[], permissionSlugs[], tags[], genre[], features[], sizeBytes, description` — plus a `collections` map (initially `{ all: [...] }`, extensible to `featured` when the platform exports it).
3. Implement parser/normalizer with explicit validation + a `parseReport { dropped: n, unknownFields: [...] }` instead of silent drops; permission name→slug normalization lives here (BC5), as does category plural handling (BC6).
4. Shell writes the normalized result to `configs/catalogue.normalized.json`; page scripts (`updates-modal`, `download-modal`, `missing-app-modal`) are rewritten to consume it and a single shared URL-builder (`appFileUrl(id, rel)`, no group segment — BC1/BC2).
5. Telemetry client in the same module: rating event with `['stars', n]` (BC4), downloads/ratings refresh, versions check; one place holds every endpoint.
6. UI pass: tabs become data-driven (categories facet or single grid + filter); `homeSection` migrates to a collection name.
7. Re-seed romfs; hardware pass.

**Effort / sequencing:** ~2× Option 1 — call it 4–6 working sessions plus two hardware passes (one for the client, one for the UI pass). Best run as its own track *between* engine milestones: land steps 1–5 (no visible UI change beyond correctness) before the Unity milestone, defer step 6's UI polish until after. Doesn't touch the patch-ledger/demo-isolation surfaces.

**Later cost:** low and shrinking. New platform capability = new method on the client; next drift = one parser + one fixture to update. The romfs page scripts stop encoding contract knowledge entirely, which also de-risks the eventual shell/page refactors you already do routinely.

**Risk on CFW:** front-loaded but observable. The client is pure data-in/data-out, so it's fully testable off-console (fixtures + headless Chrome harness) before any Switch build; the residual hardware risk is nxjs `fetch` behavior against `brewser.tech`/raw.githubusercontent (TLS, redirects), which is *already* the current risk surface, unchanged. Early detection: the `parseReport` is rendered on the updates modal, so a drifted contract says "12 apps, 3 fields unknown" instead of rendering nothing.

**Platform-side needs:** none mandatory; benefits from the Option 4 items if you choose to do them.

---

## Option 3 — Versioned-contract tolerance ("assume drift is permanent")

Option 2, plus machinery to *negotiate and survive* future contract change: dispatch on `catalogue.version` (1 = current; unknown → last-good cache + banner), feature-detect endpoints at runtime (`GET /telemetry/v1/ping` for platform liveness/version; try authed `/rate`, fall back to `/log`), pin the staging `manifest.schema.json` as a vendored fixture and diff against it in CI, and log contract-drift events to telemetry so the fleet reports breakage before you see it.

**Effort / sequencing:** Option 2 + roughly 2–3 more sessions, plus small ongoing attention (keeping the vendored schema and fixtures fresh). Realistically displaces the Unity milestone by a week of calendar time.

**Later cost:** best drift story of the four — but this is a **single-operator platform where you own both sides and both repos sit in the same workspace**. Version negotiation between two codebases you release in lockstep is machinery you must maintain without a second producer to justify it. The genuinely valuable pieces (version field check, ping probe, drift visibility) are small and can be folded into Option 2 for ~10% of the cost.

**Risk on CFW:** lowest steady-state, highest build-phase surface (more code paths = more to verify on hardware once).

**Platform-side needs:** a commitment that `catalogue.json.version` is bumped on breaking shape changes (currently constant `1`, `build_catalog.py:37`) — cheap but must be honored to be worth anything.

---

## Option 4 — Platform-assisted alignment ("fix the contract at the source, shrink the consumer")

Invert the default: make the platform emit what the runtime needs, so runtime-side work collapses toward Option 1's size. These are **your platform decisions**, listed separately as required:

- **P1 — permission slugs:** manifest builder emits taxonomy term slugs instead of names (`class-brewser-sub-manifest.php:50` + validator term-name→slug), aligning manifests with `permissions.json`/`warnings.json`/engine keys. Kills BC5 at the source for every future consumer (web player included). Needs a resubmission/regeneration pass for the 12 live apps.
- **P2 — export featured:** catalogue generator (or WP on approve) writes `featured: true` from `_brewser_featured` into the entry, restoring a data-driven Featured rail (Open Q2).
- **P3 — canonical base URL decision:** settle `play.brewser.tech` vs `raw.githubusercontent` vs `natureglass.github.io` once, and set both the WP `play_base_url` default and the runtime pins to it (Open Q1).
- **P4 — `usb` entry in `permissions.json`** + reconcile the three permission vocabularies.
- Runtime side then does: baseline + BC1/BC2 flattening + BC4 payload fix + reseed (i.e. Option 1 minus the vocabulary shim, minus rail redesign).

**Effort / sequencing:** platform edits are small (P1 is the only one with a data migration), but they ride your WP release/testing cadence — the runtime is blocked on P1/P2 landing *and being verified live* before its own changes are testable end-to-end. That coupling is the real cost: two repos' release trains serialized.

**Later cost:** cleanest contract of all — the platform emits runtime-ready data, no shim layer to maintain. But every future consumer-driven need becomes a platform change first, which is the slower loop.

**Risk on CFW:** lowest code risk on the runtime, but highest *coordination* risk: if P1 ships wrong, live apps' manifests regress for the web player too, not just the Switch. Early detection: regenerate one app's manifest on staging and diff before touching prod.

---

## Recommendation

**Option 2, with P1 and P2 from Option 4 cherry-picked, and Option 3's two cheap probes (version-field check + `/ping`) folded in.** Reasoning, stated as a recommendation rather than a verdict:

- BC1/BC2 make the catalogue UX entirely dead, and the current failure mode is *silent* — the single most valuable property to buy is "drift is visible," which Option 2's normalizer/parseReport gives you and Option 1 structurally can't.
- You own both sides, so full Option 3 negotiation machinery is overhead; but the permission-vocabulary break (BC5) is a *platform bug* by any reading (manifests that don't match the platform's own `permissions.json`), and fixing it runtime-side (Option 1/2 shim) means carrying a display-name mapping forever. P1 is the right fix; the runtime shim can still exist as a one-release transition for the 12 current manifests.
- Sequencing fits your current work: the platform client is engine/shell plumbing, disjoint from the demo-isolation and Unity surfaces, and its testable-off-console nature means it doesn't compete for your hardware-testing time until one consolidated pass.

**Smallest first step that validates the approach** (before committing to anything):
re-vendor `runtime/dist`, then build *only* the catalogue normalizer with two fixtures — the live `brewser-apps/catalogue.json` and the old romfs seed — and run it in the existing headless-Chrome harness, asserting it yields 12 normalized apps with correct entry URLs (`apps/<id>/index.html`, no group segment) and correctly slug-mapped permissions for `midilab` (`Usb→usb`) and `sensorsplayground` (`Device Info→device_info`). That is one module + one test, zero UI or romfs changes, and it proves the exact seam every option depends on. If it holds, continue into Option 2; if you'd rather go Option 1 or 4, the normalizer is still the first artifact either of those needs.
