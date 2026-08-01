# Platform Contract Findings — Brewser runtime vs rebuilt platform

**Date:** 2026-07-24
**Scope:** read-only investigation of five repos.
**Platform (source of truth):** `Brewser-WordPress/brewser-plugin/brewser` (WP plugin bundle), `brewser-apps` (prod CDN repo), `brewser-apps-staging` (intake/scan repo).
**Runtime (stale):** `brewser` (Switch shell), `brewser-runtime` (engine library).
**Citation convention:** `path:line`, relative to the named repo root. Old-contract evidence additionally drawn from the preserved snapshot `D:\Workspace\old_apps\` and the shell's own seed data. Pivotal claims (marked ✔) were re-verified by direct file reads; the rest come from full-file reads during the investigation sweep.

---

## 1. Platform — WordPress plugin (`Brewser-WordPress/brewser-plugin/brewser`)

### 1.1 Data model

**Authoritative app record = a row in `{prefix}brewser_sub_submissions`** (schema `plugins/brewser-submissions/includes/class-brewser-sub-schema.php:155-205`, `DB_VERSION='1.11.0'` at `:109`). Key columns: `package_id`, `owner_sub`, `version`, `app_name`, `description`, `entry`, `logo`, `price`, `license`, JSON columns `categories/tags/genre/features/permissions/compatibility/allowed_origins/button_mapping/screenshots/documentation`, `manifest_json`, `status VARCHAR(32) DEFAULT 'submitted'`, `wants_production`, `storage_key`, and the scanner columns `scan_verdict VARCHAR(16)` (`'' | GOOD | SUSPICIOUS | DANGEROUS`), `scan_findings`, `scan_override` (`:96-108`, `:193-195`).

**The App Post is a derived projection, not authoritative.** Apps are plain WP `post` objects (no custom post type) created with `'post_type' => 'post'` in `brewser_sub_upsert_app_post()` (`plugins/brewser-submissions/brewser-submissions.php:1042-1051`), keyed by meta `_brewser_package_id` (`:46`). Sync is one-way row→post via `brewser_sub_sync_app_post_facets()` (`:346-433`), invoked on approval (`class-brewser-sub-admin.php:1298-1319`).

Companion tables: `brewser_sub_developers` (`class-brewser-sub-schema.php:138-153`), telemetry `swtel_events`/`swtel_ratings`/`swtel_downloads` (`plugins/switch-telemetry/switch-telemetry.php:64-107`), `brewser_saves` (`plugins/brewser-auth/includes/class-brewser-auth-save.php:66-74`), `brewser_leaderboards` (`class-brewser-auth-leaderboard.php:104-114`), and four ideas tables (`plugins/brewser-ideas/includes/class-brewser-ideas-schema.php:69-121`).

Post meta consumed by the browse catalogue: `_brewser_publisher`, `_brewser_price`, `_brewser_price_tier` (`'free'|'paid'`), `_brewser_downloads`, `_brewser_rating`, `_brewser_rating_count`, `_brewser_visits`, `_brewser_screenshots`, `_brewser_documentation`, `_brewser_animated_banner`, `_brewser_featured` (`brewser-submissions.php:117-143`).

### 1.2 Categorisation — what replaced the tiers

**The old `community` / `experimental` / `featured` tiering is gone from the platform.** Grep evidence:

- `experimental` — **zero occurrences** in the whole plugin.
- `community` — only prose (Ideas-board copy `brewser.php:153,224`; rating copy `class-brewser-auth-rating.php:134,207`; `uninstall.php:104`). Never a code value.
- `featured` — survives only as an **admin-curated boolean** post meta `_brewser_featured` (`brewser-submissions.php:140-143`), toggled via admin AJAX (`class-brewser-sub-admin.php:1659-1682`), plus a browse **sort tab** `'featured' => 'Featured'` (`plugins/brewser-apps/includes/class-brewser-browse.php:81`, meta_query `:700-703`). It is not a tier, channel, or storage location.
- No `tier`/`channel`/`track` app-classification column or enum exists anywhere (only `_brewser_price_tier` and permission risk `low|medium|high`, `class-brewser-sub-permission-risk.php:24`).

**The replacement is multi-axis taxonomy metadata**, set by the submitter at submit time and validated against WP taxonomies (all in `plugins/brewser-submissions`; validators in `includes/class-brewser-sub-validate.php`):

| Axis | Required | Storage | Vocabulary source | Validator |
|---|---|---|---|---|
| `categories` | yes (≥1) | row JSON → WP `category` terms | WP core `category` taxonomy | `class-brewser-sub-rest.php:1445` |
| `compatibility` | yes (≥1) | row JSON → `brewser_platform` terms | taxonomy slugs; legacy list `('switch','web','smartphone','android')` `class-brewser-sub-validate.php:213` | `:238-258` |
| `genre` | no | row JSON → `brewser_genre` terms | operator-curated taxonomy | `class-brewser-sub-rest.php:1454` |
| `features` | no | row JSON → `brewser_feature` terms + manifest | operator-curated taxonomy | `:1459` |
| `tags` | no | row JSON → `post_tag` | free text ≤12 chars | `class-brewser-sub-validate.php:371-418` |
| `permissions` | no | row JSON → `brewser_permission` terms | operator-curated taxonomy | `class-brewser-sub-rest.php:1469` |
| `license` | yes | row string → `brewser_license` term | seeded list `class-brewser-sub-validate.php:17` | `:168-176` |
| `price` | yes | row DECIMAL → `_brewser_price_tier` | 0–100000 | `:187-207` |
| featured | — | post meta boolean | admin only | `class-brewser-sub-admin.php:1659-1682` |

✔ **Manifest values are taxonomy term *names*, passed through verbatim** by the manifest builder (`class-brewser-sub-manifest.php:50` `'permissions' => array_values( $fields['permissions'] )`), which is why prod manifests carry Title-Case strings like `"Usb"` and `"Device Info"` (see §5.3-BC5). The builder also hardcodes `'exitGame' => 'PLUS'` and `'fullscreen' => true` (✔ `class-brewser-sub-manifest.php:55-56`).

### 1.3 Lifecycle

Status values of a submission row (no single enum constant; enumerated from write sites):
`submitted` (insert, `class-brewser-sub-rest.php:1780`) → `pushed_to_staging` (HMAC CI callback, `:3057-3074`) or `push_failed` (`:1830-1833`, `:3076-3079`) → `approved` (admin approve, `class-brewser-sub-admin.php:1323`) / `rejected` (`:1390`) → `unpublished` (admin `:1420` or dev `class-brewser-sub-rest.php:1044,1061`) → back to `approved` (`class-brewser-sub-admin.php:1440-1468`; dev `class-brewser-sub-rest.php:1091,1109`). Admin bucket partition at `class-brewser-sub-admin.php:1709-1717`; developer-facing state mapping at `class-brewser-sub-rest.php:317-366`.

Automated transitions: staging deploy callback (CI), go-live verification cron that holds the App Post as `draft` until the prod CDN serves `{play_base}/<pkg>/manifest.json`, then publishes (`brewser-submissions.php:1302-1351`, probe `:1218-1229`); row pruning to ≤2 rows/package (`class-brewser-sub-schema.php:552-652`); optional staging sweep (`brewser-submissions.php:1141-1197`).

**Scanner gate:** verdict arrives inside the HMAC deploy callback (`class-brewser-sub-rest.php:3023-3068`). `DANGEROUS` soft-blocks publish — admin must type OVERRIDE (`class-brewser-sub-admin.php:1215-1234`, audit stamp `scan_override={by,at,verdict}`), and the developer self-publish route refuses outright (`class-brewser-sub-rest.php:1081-1087`). **No scan data is exposed on any runtime-facing route** — the runtime only ever sees already-approved apps via the CDN.

### 1.4 REST surface (40 routes; runtime-relevant subset)

Full inventory: telemetry (`plugins/switch-telemetry/switch-telemetry.php:139-167`), auth/rate/save/leaderboard/comment (`plugins/brewser-auth/includes/*`), browse/favorites (`plugins/brewser-apps/includes/*`), submissions (`plugins/brewser-submissions/includes/class-brewser-sub-rest.php:66-169`), ideas (`plugins/brewser-ideas/includes/class-brewser-ideas-rest.php:42-138`). Routes the Switch runtime can plausibly call:

| Route | Auth | Request | Response | Cite |
|---|---|---|---|---|
| `POST telemetry/v1/log` | none (rate-limited, optional operator schema) | raw JSON event | `{ok:true}` **HTTP 202** | `switch-telemetry.php:139`, `:233` ✔ |
| `GET telemetry/v1/downloads` | none | — | bare map `{"<pkg>": int}` | `:149`, `:316-359` |
| `GET telemetry/v1/ratings` | none | — | bare array `[{packageId,count,average}]` | `:155`, `:336-355` |
| `GET telemetry/v1/ping` | none | — | `{ok:true, v:SWTEL_VERSION}` | `:161-167` |
| `POST brewser/v1/auth/device-mint` | none (verifies Google `id_token`, `aud`=device_client_id) | `{id_token}` | `{token, user:{sub,name,email,picture,exp}}` | `class-brewser-auth.php:66,324-390` |
| `POST brewser/v1/auth/verify` | none | `{token}` | `{ok,sub,name,email,exp}` | `:56,294-303` |
| `POST/GET/DELETE brewser/v1/save` | Bearer | `packageId`, `data` ≤256 KB | `{ok,packageId,data|null,updatedAt|null,stored}` | `class-brewser-auth-save.php:105-316` |
| `POST/GET/DELETE brewser/v1/leaderboard` | Bearer (GET public) | `packageId, score, name?, order?` | `{ok,best,rank,updated,onBoard}` / `{ok,order,count,top[],me?,window?}` | `class-brewser-auth-leaderboard.php:171-559` |
| `POST brewser/v1/rate` | Bearer | `packageId, stars 1-5` | `{ok,packageId,stars}` 202 | `class-brewser-auth-rating.php:37,101-142` |
| `GET brewser/v1/my-rating` | Bearer | `packageId` | `{ok,stars,is_owner}` | `:48,170` |
| `POST brewser/v1/submissions/visit` | none (beacon) | `package_id, vid?` | `{ok,counted}` | `class-brewser-sub-rest.php:98,601-635` |

Web/admin/CI-only (not runtime): `/browse` returns **server-rendered HTML** `{html:"…"}` (`class-brewser-browse.php:603-635`) — **there is no JSON catalogue route in WP**; favorites/comment/ideas are same-origin web-shortcode routes (favorites not CORS-enabled, `class-brewser-favorites.php:138-148`; comment not in `is_cors_route`, `class-brewser-auth.php:84`); `/submissions/*` is the developer portal; `/submissions/callback` + `/intake-asset` are HMAC CI endpoints (`class-brewser-sub-rest.php:2970-3081`, `:180-232`).

CORS allowlists: telemetry + auth default `https://play.brewser.tech` (`switch-telemetry.php:636`, `brewser-auth.php:92`); submissions `https://my.brewser.tech` + `https://play.brewser.tech` (`class-brewser-sub-rest.php:33-34`).

### 1.5 Auth contract

- Token: **opaque two-segment HMAC token, not a JWT** — `base64url(payloadJson) . "." . base64url(HMAC_SHA256(payloadJson, secret))` (`class-brewser-auth.php:462`; contract doc `brewser-auth.php:31`). Payload `{sub,name,email,picture,iat,exp,v:1}` (`:449-457`). Default TTL **720 h = 30 days** (`brewser-auth.php:93`). **No refresh endpoint** — re-login on expiry.
- Device flow: the plugin does **not** implement RFC-8628 issuance/polling; the client runs Google's TV flow directly and exchanges the final `id_token` at `POST /auth/device-mint` (`class-brewser-auth.php:324-390`).
- Presentation on authed routes: `Authorization: Bearer`, `X-Brewser-Session`, cookie, or `token` param (per-plugin `authenticate()` helpers, e.g. `class-brewser-auth-save.php:129`).

### 1.6 App base URLs embedded in the plugin

- Default play base: `'https://natureglass.github.io/Brewser-apps/apps'`, option `brewser_apps_settings.play_base_url` (`brewser-apps.php:52`); admin note says intended move to `https://play.brewser.tech/apps` (`class-brewser-settings.php:98`).
- Per-app resolver `brewser_sub_app_base_url_for($pkg)` handles extended-storage repos (`brewser-submissions.php:804-824`); asset URL = `{base}/{pkg}/{rel}` (`:839-847`).

### 1.7 Version markers

Bundle `1.29.113` (`brewser.php:19`); submissions `BREWSER_SUB_VERSION '1.21.28'` / DB `1.11.0`; apps `0.11.71`; auth `0.6.4`; telemetry `SWTEL_VERSION '1.6.1'`; ideas `0.6.14` / DB `2.0.0`. API versioning is URL-namespace only (`brewser/v1`, `telemetry/v1`); no deprecation mechanism; token payload carries `v:1`.

---

## 2. Platform — prod apps repo (`brewser-apps`, CDN)

### 2.1 Layout & identity

Flat, tier-less:

```
apps/<reverse-dns-id>/          ← folder name MUST byte-match manifest "id"
    manifest.json
    index.html                  (entry)
    assets/appbanner.jpg        (logo, all 12 apps identical convention)
    [app-specific payload…]
artifacts/<id>.json             ← generated file lists
catalogue.json                  ← generated index
stats.json                      ← C2 counters, WP-Cron daily publish
CNAME = play.brewser.tech       .nojekyll present
(REMOVED 2026-08-01: categories.json, tags.json, permissions.json — unused; see below)
(versions.json MOVED to brewser-apps-staging → my.brewser.tech — see §3)
```

Folder/id match is enforced by warning in the generator (`scripts/build_catalog.py:96-102`). IDs are dotted reverse-DNS (`com.natureglass.midilab`) — note the earlier underscore form `com_natureglass_midilab` still exists in `old_apps/com_natureglass_midilab/manifest.json:2` (old snapshot), i.e. at least one app changed identity format.

### 2.2 Manifest schema (union of all 12 real manifests)

Present in ALL 12: `id, name, version, description` (HTML markup), `logo` (= `assets/appbanner.jpg` in all 12), `entry` (= `index.html` in all 12), `categories[]`, `permissions[]`, `compatibility[]` (= `["switch","web"]` in all 12), `allowed_origins[]`, `developer` (string), `license` (= `"MIT"`), `exitGame` (= `"PLUS"`), `fullscreen` (= `true`).
Partial: `genre[]` (2/12), `features[]` (8/12), `tags[]` (6/12).
**Absent from every prod manifest:** `buttonMapping` (grep over `apps/**/manifest.json` = no matches), `source`, `icons`, screenshots.
Value sets seen — `categories`: `Apps, Demos, Games, Measurement, Sensors, Robotics`; `permissions`: `Storage, Network, Usb, Device Info` (Title-Case, ✔ `apps/com.natureglass.midilab/manifest.json` → `["Usb"]`, `apps/com.natureglass.sensorsplayground/manifest.json` → `["Device Info"]`).

**No schema file exists in this repo**; the generator validates only parse + truthy `id` (`scripts/build_catalog.py:55-60,92-94`). The authoritative schema lives in staging (§3.2). `submission_info.md:127-290` documents a *different, obsolete* manifest shape (`developer` object, singular `category`, `icons{}`, boolean `permissions{}`, nested `network.allowed_origins`) — documentation drift, not contract.

### 2.3 Index artefacts

- ✔ `catalogue.json` = `{ "version": 1, "generated": "<ISO8601Z>", "apps": [ …manifest merged verbatim + "sizeBytes": <int>… ] }` (`catalogue.json:1-4`; generator `scripts/build_catalog.py:91,106-107,128-132`; `CATALOG_VERSION = 1` `:37`; sorted by id `:109`). Rebuilt by CI on any push to `apps/**` (`.github/workflows/catalogue.yml:15-20,55`).
- `artifacts/<id>.json` = `{ id, sizeBytes, files:[<sorted relative paths>] }` (`build_catalog.py:63-73`); stale artifacts pruned (`:113-121`).
- `versions.json` — **MOVED to `brewser-apps-staging`** (served at `my.brewser.tech/versions.json`). Its sole producer is now `brewser`'s `make release` mirror of `romfs/configs/current.json`; the old `scripts/collect_versions.py` generator (and the `brewser-apps` Makefile `versions` target) was retired.
- `categories.json`, `tags.json`, `permissions.json` — **REMOVED 2026-08-01** (`brewser-apps` commit "Remove unused …"). Were hand-maintained, generated by nothing, and consumed by nothing (runtime uses a hardcoded `KNOWN_PERMISSION_SLUGS` list; WP calls `permissions.json` the "retired GitHub vocab"). If P1/P4 (permission-slug reconciliation) revives a platform-side `permissions.json`, recreate it there — the deleted copy had lowercase keys `network, storage, system, filesystem_read, filesystem_write, device_info, account, external_links` and **no `usb` entry**.
- `index.html` = crawler redirect to `https://brewser.tech/` (`index.html:9-21`), noindex.

### 2.4 Hosting

`CNAME` = `play.brewser.tech` (`CNAME:1`). A catalogue entry maps to `https://play.brewser.tech/apps/<id>/<entry>`; logo `…/apps/<id>/<logo>`; artifacts `…/artifacts/<id>.json`; catalogue `…/catalogue.json`. (Deduced from CNAME + layout; no consumer code lives in this repo.) The same content is fetchable via `raw.githubusercontent.com/natureglass/Brewser-apps/refs/heads/main/…`, which is what the runtime pins today (§4).

### 2.5 Git history — the tier-removal diff does not exist

The repo history was **hard-reset**: root commit `f4b70b9` "Reset repository (history removed)" (2026-07-21) has no parent, and the layout is already flat at that commit; no `apps/(featured|experimental|community)/` deletion exists in retained history. **The tiered→flat migration diff is unrecoverable from git.** Residual tier references in the working tree are all inert: `.github/ISSUE_TEMPLATE/submit-app.yml:39-40` (stale "Requested channel" dropdown), `submission_info.md` channel docs, `README.md:25-27`, a docstring in `scripts/build_catalog.py:6-8`, and a stale hardcoded path in the unwired tool `tools/vendor-unity-build.mjs:57` (`apps/experimental/com.natureglass.unity-demos`).

---

## 3. Platform — staging repo (`brewser-apps-staging`)

- **Purpose:** intake + scan + developer-portal surface (`CNAME` = `my.brewser.tech`, `CNAME:1`). App payloads exist only transiently at `apps/<pkg>/` during the deploy→promote window (`.github/workflows/submissions.yml:199-206`; `README.md:20-21,159` "latest-wins; no version history"); at HEAD there are no app bodies and `index.json` is `[]`.
- **Authoritative manifest schema:** `manifest.schema.json` (Draft-07, `$id: https://brewser.tech/schema/manifest.json`, `additionalProperties:false`). Required (14): `id,name,version,description,logo,entry,categories,permissions,compatibility,allowed_origins,developer,license,exitGame,fullscreen` (`:8-12`). Only closed enum: `compatibility ∈ {switch, web, smartphone, android}` (`:29-34`). `id` pattern `^com\.[a-z0-9]{3,32}\.[a-z0-9]{2,48}$` (`:16`). Optional: `genre, features, tags, buttonMapping` (string→string map, ≤64 props, `:48-55`), `linked_idea_ids`. **No tier field.** Enforced in CI via `scripts/validate_manifest.py` (`submissions.yml:186-191`).
- **Staging index** `index.json` = bare array of `{id,name,version,owner:<sha256(google sub)>,updated_at,entry,logo,description(≤500)}` (`scripts/upsert_index.py:65-76`) — a dev-portal projection, not runtime-facing.
- **Scanner:** verdicts `GOOD|SUSPICIOUS|DANGEROUS` (`scanner/lib/severity.mjs:25-29`), artifact shape `{verdict,score,scanned_at,scanner_version,package_hash,counts,rationale,truncated,findings[],limitations}` (`scanner/scan.mjs:61-74`), persisted per-package (not per-version) at `scans/<pkg>.json` (`submissions.yml:221`). Callback to WP: `POST …/brewser/v1/submissions/callback` with `X-Brewser-Signature: sha256=hex(hmac_sha256("<ts>.<body>", secret))` + `X-Brewser-Timestamp` (`scripts/build_callback.py:112-114`), body `{package_id,version,zip_sha256,result,error,deploy_commit_sha,scan_verdict,scan_findings_b64}` (`:101-110`).
- **Promotion** lives in the prod repo: `repository_dispatch: promote_app` sparse-clones staging's `apps/<PKG>/` into prod and re-triggers the catalogue rebuild (`brewser-apps/.github/workflows/promote.yml:18-19,50-91`).
- **The runtime is never expected to read staging** — no CORS/preview config; `index.html` is a redirect (`index.html:9-21`).

---

## 4. Runtime side — current contract consumption

### 4.1 Shell (`brewser`) — where the platform is actually spoken

The platform URLs physically ship in the **vendored compiled runtime** `runtime/dist/runtime-defaults.js` (the `@switch-web/runtime` symlink targets `brewser/runtime`, **not** `brewser-runtime`):

✔ `runtime/dist/runtime-defaults.js:1-12` — `telemetry` → WP `/telemetry/v1/log`; `catalogue` → `raw.githubusercontent.com/natureglass/Brewser-apps/…/catalogue.json`; **`downloads`/`ratings` → `raw.githubusercontent.com/natureglass/Brewser-telemetry/…/downloads.json|ratings.json` (the RETIRED repo)**; `versions` → prod `versions.json`; `artifacts` → GitHub Contents API (surfaced but never fetched — `romfs/shell/scripts/download-modal.js:20-21`). Keys are strict-pinned against user config (`:19-27`; enforcement `src/profile/browser-toolbar.ts:593-597`).

✔ The engine **source** already repointed downloads/ratings to WP (`brewser-runtime/src/runtime-defaults.ts:82-83`) — the shell's vendored dist predates that change. This is the only substantive difference between the two copies.

**Catalogue parsing (the core breakage):**
- ✔ Type `CatalogGroup = 'featured' | 'community' | 'experimental'` (`src/profile/browser-toolbar.ts:706`, `CATALOG_GROUPS :708`).
- ✔ `readCatalogGroup` pulls `parsed[group]` (`:887`) — with the new `{apps:[]}` envelope every group resolves `undefined` → `[]` → **all tabs/rails render empty, silently**.
- Entry validation requires `id`, `name`, `entry` strings (`:889-897`); consumed fields: `id, entry, name, version, logo, description, license, category, developer, source, features, permissions, allowed_origins, sizeBytes` (`:775-834`). `category` is read **singular** (`:821`) — the new contract has plural `categories`.
- Path/URL construction bakes the tier in everywhere: launch `brewser://apps/${group}/${e.id}/${entryRel}` (`:818`), logo (`:801`), installed-manifest probe `${appRoot}apps/${group}/${id}/manifest.json` (`:853`), sandbox/nav parsing expects exactly `apps/<group>/<id>/…` (`src/shell/nav-helpers.ts:124-133`).
- Page scripts mirror it: `updates-modal.js:107` `GROUPS=['featured','community','experimental']`; remote app files fetched from `…/apps/<group>/<id>/<rel>` (`download-modal.js:313-323,419`; `updates-modal.js:308-318`) — **the CDN no longer has a `<group>` path segment**, so these would 404 even with the envelope fixed.
- ✔ Seed cache `romfs/configs/catalogue.json` still holds the old envelope (`featured` first key; its first entry `com.natureglass.lumaclips` no longer exists in prod). Check-for-Updates overwrites `sdmc:/…/configs/catalogue.json` with whatever the remote returns (`updates-modal.js:84,590,621`).
- UI copy: tab labels in `romfs/shell/apps.html:25-42`, `about.html:102`; `config.json:34` `homeSection:"featured"` (validated against the three tier names, `browser-toolbar.ts:557-561`).

**Telemetry / ratings:**
- ✔ Rating POST (`romfs/shell/scripts/missing-app-modal.js:505-511`) sends `{packageId, userId, reqType:'like', data:['like', n], platform:'switch'}` and treats HTTP 202 as success (`:525`). ✔ WP aggregates only `data:["stars", n]` (`switch-telemetry.php:283-288` — `'stars' !== $d[0]` → return). **Result: WP replies 202, buffers the raw event, but never folds the rating into the aggregate — a silent contract mismatch.** `userId` is the raw provider account id from the local auth record (`missing-app-modal.js:469,484`), not the Brewser token.
- downloads/ratings display reads local `configs/downloads.json` (`{pkg:count}`) and `configs/ratings.json` (`[{packageId,count,average}]`) (`missing-app-modal.js:564-591`) — shapes match the WP routes exactly (the WP routes were deliberately shape-compatible: `switch-telemetry.php:145-148` "repoint by URL only"). Only the URL is stale.

**Versions check:** fetch `versions.json` (now `my.brewser.tech`, brewser-apps-staging), compare string-inequality per key against seeded `configs/current.json` (`updates-modal.js:374-455`). File has exactly the three expected keys — **compatible**. (`config.json:18` `checkVerOnBoot` is an orphan — parsed nowhere.)

**Artifacts:** `download-modal.js:496-501` fetches `…/artifacts/<id>.json` and accepts `parsed | parsed.files | parsed.paths | [{path|name|url|download_url}]` (`:284-323`) — prod's `{id,sizeBytes,files[]}` **matches**.

**Auth:** Google device flow against Google endpoints, then ✔ mint at `https://brewser.tech/wp-json/brewser/v1/auth/device-mint` with `{id_token}` expecting `{token, user:{sub,…,exp}}` (`romfs/shell/scripts/google-auth.js:39-45,459-485`) — **matches WP** (`class-brewser-auth.php:324-390`). Record stored at `sdmc:/switch/brewser/shell/auth/google-auth.json` (`google-auth.js:599-608`); expiry checked locally against `user.exp` (`:636-637`), consistent with the no-refresh 30-day token. Microsoft flow exists but is inert (empty client id) and is not bridged to apps.

### 4.2 Engine (`brewser-runtime`)

The engine is a library: it **defines** contracts but performs no platform HTTP itself (only the donations QR string is consumed in-repo — `src/scripts/html-to-live.ts:363`).

- Endpoint constants: `src/runtime-defaults.ts:77-88` (✔ downloads/ratings already point at WP).
- Auth bridge: reads `shell/auth/active.json` (`provider==='google'`) + `google-auth.json` `{token, user.sub}` and mirrors to `localStorage['brewser_auth'] = {token,user}` for apps, plus `globalThis.__brewserPlatform='switch'` (`src/auth/brewser-auth-bridge.ts:35-36,70-84,89-114,166-167`; contract `docs/CONTRACT_switch_auth_record.md:13-39`). No `brewser.login()` SDK dispatcher exists yet (`:160-164`).
- Manifest ingestion seams: `setAppButtonOverlay(manifest.buttonMapping)` (`src/input/button-router.ts:245-250`) and ✔ `setManifestPermissions(appId, perms, sandboxRoot)` which **lowercases** the strings (`src/permissions/browser-permission-policy.ts:91-95`) and gates on `network / storage / system / filesystem_read / filesystem_write` (+ `device_info, account, external_links` labels per `permissions/permission-policy.ts:1-42`, `warnings.json` keys).
- Old tiers: only docs/examples/comments (e.g. `src/scripts/live-form.ts:123-124` tiered-path example; `examples/app-runner/Makefile:16`); no runtime constant enumerates tiers.
- Storage layout, `brewser://`→`sdmc:/switch/brewser/` rewrite (`src/resources/switch-path-resolver.ts:79-81`), and localStorage/IndexedDB backing files are platform-independent.

### 4.3 Runtime call-site → contract status table

| Runtime call-site | Platform contract | Status |
|---|---|---|
| `browser-toolbar.ts:887` `parsed[group]`; `updates-modal.js:107,467-469` | catalogue envelope `{featured,community,experimental}` | **REMOVED** → now `{apps:[]}` (`build_catalog.py:128-132`). Silent empty. |
| `browser-toolbar.ts:785,801,818,853`; `nav-helpers.ts:124-133`; `download-modal.js:313-323`; `updates-modal.js:308` | tiered path `apps/<group>/<id>/…` (disk + CDN) | **REMOVED** → CDN is `apps/<id>/…`. Remote fetches 404; disk layout self-defined but tier-shaped. |
| `browser-toolbar.ts:821` `e.category` | entry `category` (singular string) | **RENAMED** → `categories[]` (all 12 manifests). Yields `undefined`. |
| `runtime/dist/runtime-defaults.js:6-7` downloads/ratings | Brewser-telemetry repo raw JSON | **REMOVED** (repo retired; WP is authoritative — `switch-telemetry.php:4,145-148`). Engine source already fixed (`runtime-defaults.ts:82-83`); shell vendored dist stale. |
| `missing-app-modal.js:509` `data:['like',n]` | `/log` like-event aggregation requires `data:["stars",n]` | **MISMATCH (silent)** — 202 but never aggregated (`switch-telemetry.php:284`). |
| `browser-shell.ts:1908-1912` → `browser-permission-policy.ts:91-95` perm labels | manifest `permissions[]` values | **MISMATCH** — platform emits Title-Case term names (`Usb`, `Device Info`); policy/warnings key on `network/storage/system/filesystem_*/device_info/…`; `usb` has no policy/warning entry at all (`permissions.json:1-50`). |
| `updates-modal.js:463-520` entry diff on `id,entry,name,version,logo` | catalogue entry core fields | **MATCHES** (all present in new entries). |
| `download-modal.js:496-501` artifacts/<id>.json | `{id,sizeBytes,files[]}` | **MATCHES**. |
| `updates-modal.js:374-455` versions.json vs current.json | `{nx.js,runtime,brewser}` | **MATCHES**. |
| `missing-app-modal.js:564-591` downloads/ratings shapes | map / array-of-`{packageId,count,average}` | **MATCHES** (URL stale only). |
| `google-auth.js:459-485`; `brewser-auth-bridge.ts` | `/auth/device-mint` `{token,user{…,exp}}`, token v1, no refresh | **MATCHES**. |
| shell — nothing calls | `/save`, `/leaderboard`, `/rate`, `/my-rating`, `/visit`, `/ping` | **NEW-AND-UNCONSUMED**. |
| catalogue fields `tags, genre, compatibility, exitGame, fullscreen, buttonMapping, sizeBytes(partially)` | new/optional entry fields | **UNCONSUMED** from catalogue (`browser-toolbar.ts:726-728` documents ignoring four of them; manifest-side `exitGame/fullscreen/buttonMapping` ARE consumed at launch, `browser-shell.ts:1877-1918`). |
| `browser-shell.ts:1046` probeNetwork | non-platform (1.1.1.1 / example.com, `network-probe.ts:29-33`) | n/a. |

---

## 5. Contract diff

### 5.1 Old → new, catalogue and manifest

| Aspect | OLD (runtime's model; `old_apps/` + romfs seed) | NEW (platform) |
|---|---|---|
| Catalogue envelope | `{version:1, generated, featured:[], experimental:[], community:[]}` (✔ `brewser/romfs/configs/catalogue.json:1-4`) | `{version:1, generated, apps:[]}` (✔ `brewser-apps/catalogue.json:1-4`) |
| Repo layout | `<tier>/<id>/` (`old_apps/featured/com.natureglass.speedtest/`) | flat `apps/<id>/` (`build_catalog.py:83-102`) |
| Tier semantics | storage + UI grouping | gone; `featured` is an admin boolean post meta + browse sort (`brewser-submissions.php:140-143`) not exported to the catalogue |
| Entry category | `category:"app"` singular (✔ `old_apps/featured/com.natureglass.speedtest/manifest.json`) | `categories:[…]` required array (schema `:8-12`) + optional `genre[]`, `tags[]`, `features[]` |
| Permissions values | lowercase caps (`["network"]`, `["midi","usb","audio","webgl2"]` in `old_apps/com_natureglass_midilab/manifest.json`) | Title-Case taxonomy term names (`["Usb"]`, `["Device Info"]`) passed through verbatim (`class-brewser-sub-manifest.php:50`) |
| Logo | per-app files (`assets/speedtest_logo.png`) | uniform `assets/appbanner.jpg` (480×380 banner; all 12) + repo-served `appbanner.gif` for animated banners (WP meta `_brewser_animated_banner`) |
| `buttonMapping` | present in some old manifests (`old_apps/featured/com.natureglass.speedtest/manifest.json`) | schema-optional (`manifest.schema.json:48-55`), **absent from all 12 current prod manifests**; `exitGame:'PLUS'`/`fullscreen:true` now builder-hardcoded (✔ `class-brewser-sub-manifest.php:55-56`) |
| App id | mixed: dotted + one underscore app (`com_natureglass_midilab`) | schema-enforced dotted `^com\.[a-z0-9]{3,32}\.[a-z0-9]{2,48}$`; midilab is now `com.natureglass.midilab` |
| `sizeBytes` | absent | injected per entry (`build_catalog.py:106`) |
| downloads/ratings source | Brewser-telemetry repo raw JSON | WP `telemetry/v1/downloads|ratings`, same shapes (`switch-telemetry.php:145-148`) |
| Manifest description | plain text | HTML markup (all 12), up to 20000 chars (`manifest.schema.json` via staging `7e99c1f`) |

### 5.2 Routes: nothing the runtime used was renamed; the failures are data-shape and URL-source changes. `/auth/device-mint`, `/telemetry/v1/log`, catalogue/versions/artifacts raw URLs all still exist.

### 5.3 Breaking changes, by blast radius

1. **BC1 — Catalogue envelope** (`{tiers}` → `{apps}`): Apps page, Home rail, Check-for-Updates diff all silently empty. Worse: one Check-for-Updates run **overwrites the SDMC catalogue cache with the new shape** (`updates-modal.js:84,621`), so the breakage persists offline.
2. **BC2 — Tiered CDN paths**: even with BC1 fixed, per-file installs and logo fetches build `…/apps/<group>/<id>/…` (`download-modal.js:313-323`; `updates-modal.js:308`) → 404 on the flat CDN. Existing SDMC installs under `apps/<group>/<id>/` become orphans the moment path construction is flattened.
3. **BC3 — downloads/ratings URLs** point at the retired Brewser-telemetry repo (vendored dist only; engine source already correct). Counts freeze or 404.
4. **BC4 — Rating event silently dropped**: `data:['like',n]` vs required `['stars',n]` (`switch-telemetry.php:284`). User sees success; aggregate never updates.
5. **BC5 — Permission vocabulary**: Title-Case term names vs lowercase policy/warning keys; `Device Info`→`device info`≠`device_info`; `Usb` unrecognized everywhere (`permissions.json` has no usb entry). Risk warnings and permission gating misbehave per-app.
6. **BC6 — `category` → `categories`**: card metadata shows `undefined`; low blast (display only).
7. **BC7 — midilab identity change** `com_natureglass_midilab` → `com.natureglass.midilab`: any existing install under the old id is orphaned (runtime treats ids opaquely, so no code break).

### 5.4 New platform capabilities the runtime does not use

- **Cloud saves** `brewser/v1/save` (256 KB JSON blob per user×app, Bearer) — the Switch already holds a token able to call it.
- **Leaderboards** `brewser/v1/leaderboard` (submit/list/delete, `top/me/window`).
- **Authed ratings** `POST /rate` + `GET /my-rating` — would replace the broken raw `/log` like-event AND give per-user dedupe.
- **Visits beacon** `POST /submissions/visit`.
- **`GET /telemetry/v1/ping`** — cheap connectivity + version probe (better than 1.1.1.1 for "is the platform up").
- Catalogue riches: `tags`, `genre`, `features`, `sizeBytes` (pre-download size display), `compatibility` filter (hide non-`switch` apps), HTML descriptions.
- **Animated banners** `assets/appbanner.gif` (repo-served, cache-busted by WP `animated_banner_rev`).
- Per-developer donation URLs (WP `donation_url`, `brewser_sub_developers`) vs today's single pinned PayPal QR.
- Scan verdicts exist platform-side but have **no runtime-facing route** — catalogue membership already implies an approved (or overridden) app.

### 5.5 Security observations (out of scope but found)

- Live GitHub fine-grained PAT committed at `brewser-runtime/telemetry/Test-GitHubDispatch.ps1:38` (targets the retired telemetry repo). Should be revoked regardless of adaptation choice.
- Google OAuth client secret in `runtime-defaults.ts:86` / vendored dist (required by Google's TV device flow for installed apps, but it ships in a public artifact).
- Plaintext `access_token`/`refresh_token` in `microsoft-auth.json` (`microsoft-auth.js:598-609`) and tokens in `logs/<provider>-auth.log`.

### 5.6 Open questions (each answerable in one line)

1. **Canonical runtime base URL:** should the pinned catalogue/app URLs move from `raw.githubusercontent.com/natureglass/Brewser-apps/…` to `https://play.brewser.tech/…` (CNAME is live in the repo; the WP option still defaults to `natureglass.github.io`)? Which of the three hosts is the contract?
2. **Featured rail:** should the platform export the admin `_brewser_featured` flag into `catalogue.json` (a `featured: true` field via manifest or generator) so the shell can rebuild a Featured rail — or should the Switch UI drop curated rails entirely?
3. **Permission vocabulary:** will the platform emit term **slugs** (`usb`, `device_info`, …) in manifests instead of Title-Case names, or must the runtime carry a name→slug mapping table? (Also: should `permissions.json` gain a `usb` entry?)
4. **Ratings path:** prefer fixing the `/log` payload to `data:['stars',n]`, or switching the Switch to the authed `POST /rate` (Bearer token it already stores)?
5. **Is the operator-defined `/log` schema** on live WP configured, and does it accept the shell's event shape (`swtel_validate_schema` is operator data, not code)?
6. **Brewser-telemetry repo status:** archived/deleted, or still serving frozen JSON? (Determines whether BC3 is "stale data" or "hard 404" today.)
7. **`homeSection` config migration:** what should existing user configs holding `"featured"|"community"|"experimental"` map to?
8. **Old installs:** is it acceptable that existing SDMC installs under `apps/<tier>/<id>/` (and `com_natureglass_midilab`) are treated as not-installed after flattening (user re-downloads), or is an install-migration step required?
