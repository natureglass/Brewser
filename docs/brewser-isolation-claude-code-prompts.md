# Brewser Demo Isolation — Claude Code Prompt Sequence

Three prompts, run in order. **Hard stop after each** — Alex runs hardware verification between them. Do not give Prompt 3 to Claude Code until the Prompt 2 probe results are in and Alex has picked a design branch.

---

## PROMPT 1 — Phase A: Lifecycle isolation (GL untouched)

Paste everything below into Claude Code:

---

You are working on Brewser, a Nintendo Switch CFW homebrew browser/runtime (V8 + libuv + Skia on OpenGL ES 3.2, Mesa-Nouveau, Tegra X1). Repos, all on `v8-migration` branches:

- `nxjs-source-v8` — engine fork of nx.js (remotes: upstream = TooTallNate/nx.js, origin = natureglass/nx.js_extended)
- `brewser-runtime` — runtime layer (shims, session management)
- `brewser-apps` — read-only demo tree

**MANDATORY FIRST STEP:** Read both active patch ledgers before touching anything: `nxjs-source-v8/NXJS_PATCHES_NEEDED.md` and `brewser-runtime/RUNTIME_SHIMS.md`. One global entry number space across ledgers; NEVER renumber existing entries; find the next free number from the machine-readable index (#38 is tentatively earmarked for a blob-URL trampoline — skip it and take the next free number, or confirm #38 is unused for that purpose in the ledger).

**The bug class:** All demos run in one process, one V8 context, one shared EGL/GL context. Exiting a demo (`beforeunload` → `endAppSession` cleanup-queue drain in `brewser-runtime/src/session/app-session.ts`, WebGL ref nulling in `src/webgl-shim.ts`) does NOT reset: GL server-side state (bridge `user_snap` is process-global), the boot-allocated tenant FBO (`s_fbo=3`, `s_color_tex`, `s_depth_rb` in `nxjs-source-v8/source/webgl_bridge.cc`), shim closures (`cubeStates`, `fboCubeStates`, `programRewrittenCubeUniforms`, shadow-route equivalents), JS globals, module registry, timers/RAF/listeners, or native handles. Reproduced symptom: run `webgl-postprocessing-unreal-bloom-selective`, exit, run `com.natureglass.sensors` → cube renders broken; fresh boot → sensors renders fine.

**The decision (do not relitigate):** Composite per-demo isolation, staged. Phase A (this task) = JS/lifecycle isolation with GL left exactly as verified. Phase B (later, separately gated on a hardware probe) = per-demo EGL context. In Phase A you must NOT touch the coexistence bracket, `user_snap` shadow-tracking (ledger #35/#36), or any engine GL context plumbing.

### Phase A scope

**A0 — Investigations first (report findings before implementing):**

1. **Module cache keying.** Find how the nx.js V8 embedder caches ES modules (the module map / resolve callback path in `nxjs-source-v8`). Determine: per-isolate or per-context? This decides whether A2 needs a per-context module map. If the cache is per-isolate keyed by URL, a fresh context will NOT re-execute the runtime bundle and the shim closures will survive — the whole design depends on getting this right.
2. **Engine-held callback inventory.** Enumerate every place the engine stores a `v8::Global<Function>` (or equivalent persistent handle) fired later from libuv or native code: setTimeout/setInterval, requestAnimationFrame, DOM/Switch event listeners, fetch/network callbacks, video/audio decoder callbacks, sensor streams, cursor overlay, USB. These do NOT die with a disposed context — undisposed, they fire into the next demo's session AND pin the old context's object graph against GC.
3. **Context boot path.** Locate where the single V8 context is created, where globalThis is populated, and where the runtime bundle is injected, in both engine and `brewser-runtime` boot code.

**A1 — OwnershipRegistry (engine).** A per-context registry, reachable via a `v8::Context` embedder-data slot (pick an unused slot index; document it). API roughly: `register(kind, handle/ptr, dtor)` + typed helpers for timers, RAF entries, event listeners, pending callbacks, native object handles. `DisposeAll(context)` cancels/frees everything and Resets all Globals; it must be idempotent — a binding that forgets to unregister gets a no-op double-free, never a crash or leak. Every existing native binding that wraps an object or stores a callback registers at construct and unregisters at destroy (one-line change each): video decoder, audio context (including the shared-context singleton — decide and document whether it becomes per-context or stays process-lifetime with per-context node teardown), cursor, USB, sensors, timers, RAF, listeners, fetch.

**A2 — Per-demo V8 Context lifecycle (engine + runtime).** The browser shell keeps its own persistent context. Demo launch = create nested fresh context (fresh globalThis, per-context module map per A0.1 findings, runtime bundle re-executes so all shims re-install — their `Symbol.for('brewserCubeRouteInstalled')`-style gates key on the GL object, which persists in Phase A, so verify the shims install idempotently on an already-patched GL object rather than double-wrapping). Demo exit (`endAppSession` path in `browser-shell.ts` / `app-session.ts`) = fire beforeunload, drain cleanup queue, then `OwnershipRegistry::DisposeAll` + context dispose.

**A3 — GL teardown at the shim chokepoint (runtime only, zero engine GL changes).** The WebGL shim wraps every `create*`/`delete*` call — a demo cannot mint a GL name the shim doesn't see. Add name tracking there and a teardown routine run on demo exit: delete every still-live tracked name (buffers, textures, programs, shaders, FBOs, RBOs, VAOs, samplers, queries, sync, TF objects); unbind everything; reset all state to the ES 3.0 spec-default tables (write out the full table explicitly — depth mask TRUE, blend OFF with defaults, cull OFF, scissor OFF, colorMask all TRUE, activeTexture TEXTURE0, viewport to canvas size, clearColor 0,0,0,0, pixel store defaults, etc.); then clear the tenant FBO color+depth — forcing colorMask/depthMask/scissor sane BEFORE the clear, since a stale mask is exactly how the original bug hid clears. This teardown is enumerative but spec-bounded and lives at one chokepoint; it becomes dead code by construction in Phase B — mark it as such in comments.

**A4 — Ledger + verification obligations.** Add ledger entries with the next free global numbers: engine entry (A1+A2) in `NXJS_PATCHES_NEEDED.md`, runtime entry (A3) in `RUNTIME_SHIMS.md` (marker-property guard, never typeof/shape — standing lesson from #34). Add checks to `scripts/verify-patches.sh` and run it (currently 47 checks; must pass with your additions). Follow standing disposition policy: prefer runtime over engine, note upstream-candidate status where honest.

**What you must NOT do:** touch webgl_bridge.cc bracket logic, `user_snap` shadow tracking, s_fbo allocation, or any EGL code; renumber ledger entries; validate render correctness on Citron (functional iteration only — hardware JIT on real CFW Switch is the only authoritative pass, and Alex runs those).

**Deliverables:** A0 findings report first (stop for review if module caching is per-isolate and the fix is invasive), then implementation, then a hardware test checklist for Alex covering: bloom→sensors, sensors→bloom, bloom→bloom relaunch, 3+ other demo pair permutations from the 13-demo suite, 10× repeated launch of the heaviest demo watching for memory growth (GL objects are NOT freed by context disposal in Phase A — that's what A3 covers; JS/native growth is what this test catches), and confirmation that shell UI survives repeated demo cycles.

---

**STOP. Alex runs the hardware checklist. Proceed to Prompt 2 only after Phase A is green on real hardware.**

---

## PROMPT 2 — Phase B probe: share-group vs EGLImage on Mesa-Nouveau/Tegra X1

Paste everything below into Claude Code:

---

Context: Brewser (see repos/branches as before; read both ledgers first). Phase A (per-demo V8 context + ownership registry + shim GL teardown) is landed and hardware-verified. Phase B will replace the single shared GL context + coexistence bracket with a per-demo EGL context. Before any design is committed, build a hardware probe homebrew/demo that answers three questions on real CFW Switch (Mesa-Nouveau on Tegra X1 — this driver has known quirks: no direct layered-texture sampling, rejects native cube uploads, rejects integer readback on user FBOs; assume nothing):

**P1 — Share-group object lifetime.** Create a sibling EGL context in Skia's share group. From it, allocate a measurable, known-size object set (e.g. 32 × 1024×1024 RGBA8 textures = 128 MB, plus buffers and programs). Destroy the context WITHOUT deleting the objects. Measure: (a) are the names still valid/usable from Skia's context (spec says shared objects survive — confirm the driver agrees), (b) is the GPU memory retained (use whatever heap/memory introspection is available — svcGetInfo, Mesa counters, or allocate-until-failure deltas). This quantifies the leak a naive same-share-group design would accumulate per demo launch.

**P2 — Context lifecycle + makeCurrent cost.** Measure on hardware: eglCreateContext + first makeCurrent (cold), eglDestroyContext, and steady-state eglMakeCurrent ping-pong between two contexts (×1000, report mean/p95). The per-frame demo↔Skia makeCurrent cost decides whether Phase B's frame loop is viable at 60fps; the create cost validates or refutes the ~200–500 ms demo-swap estimate.

**P3 — EGLImage color-plane crossing.** Check extension availability: EGL_KHR_image_base, EGL_KHR_gl_texture_2D_image, GL_OES_EGL_image. If present: create a texture in context A (separate share group), wrap in an EGLImage, import into context B via glEGLImageTargetTexture2DOES, render into it from B, sample it from A, verify pixels exactly (magnitude-anchored: state the expected pixel values before running). Also test the reverse direction and repeated create/destroy cycles for stability. This is the risk surface for the full-isolation design — treat any wrong-pixel or crash result as disqualifying, not as something to work around.

Methodology: hypotheses state expected numbers before each run; Citron results are non-authoritative for all three probes (driver-behavior questions — hardware only). Deliverable: a results table + a written go/no-go recommendation between (a) same share group + Phase A's tracked deletion retained as the object-lifetime mechanism, vs (b) separate share group + EGLImage crossing with full structural isolation. Do not implement Phase B. Add a probe-spec/results doc to the repo; no ledger entries needed unless engine code was patched to run the probe (if so, ledger it).

---

**STOP. Alex runs the probe on hardware and picks a design branch.**

---

## PROMPT 3 — Phase B implementation (gated on probe results)

Fill in the bracketed choice, then paste into Claude Code:

---

Context: Brewser (repos/branches as before; **read both ledgers first**). Phase A is landed and verified. The Phase B hardware probe concluded: **[PASTE RESULTS TABLE + CHOSEN DESIGN: (a) same-share-group + tracked deletion, or (b) separate share group + EGLImage]**. Implement per-demo EGL contexts accordingly.

Scope:

- **Engine (`nxjs-source-v8`):** split the shared-context creation (`sharedScreenGL`/`sharedScreenGL2` paths) into real per-demo create/destroy backed by EGL; per-demo tenant FBO + color/depth attachments allocated at demo context creation, freed at destroy (replaces boot-once `s_fbo=3`); Skia `grContext->resetContext()` at every ownership boundary; makeCurrent choreography per frame between demo context and Skia context, replacing the enter/exit bracket.
- **Retire, don't delete blindly:** the coexistence bracket, `user_snap` shadow tracking (#35/#36), and Phase A's A3 GL state-reset/teardown code all become dead by construction. Mark #35/#36 with ledger addenda as OBSOLETED-BY-PHASE-B (never renumber, never remove entries); remove the dead code paths; update `verify-patches.sh` checks that referenced them.
- **Runtime (`brewser-runtime`):** demo context creation hooks into the Phase A lifecycle (V8 context + GL context + OwnershipRegistry now form the single composite teardown on `endAppSession`); routing shims install per new GL context (their per-GL-object gates now naturally reset).
- **If design (a):** keep Phase A's shim name-tracking + deletion as the shared-object lifetime mechanism at teardown; only the state-reset table dies.
- **Ledger + verify:** new entries (next free numbers), verify-patches.sh updated and passing, PR-D note: PR-D remains on hold and will be RE-CUT from the post-Phase-B fork surface (existing draft = genericization blueprint only) — update its ledger note to say so.
- **Hardware:** produce a JIT re-verification checklist for Alex: full 13-demo suite pass, all Phase A pair permutations repeated, demo-swap latency measured against the probe's predictions, 60fps confirmation on the heaviest demo (makeCurrent-per-frame in the loop), and 20× launch/exit soak watching GPU memory.

Do not validate render-path correctness on Citron. Stop and report before any change that would touch surfaces outside this scope.

---

**End of sequence.** After Phase B is hardware-green, the next milestone (Unity WebGL / itch.io HTML5) starts from a per-demo-isolated platform, and PR-D gets re-cut from the new bridge surface.
