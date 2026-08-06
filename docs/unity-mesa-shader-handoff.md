# Handoff — Deep-dive: Mesa/Tegra shader support for Unity WebGL on Brewser

Paste the block below into a fresh session to continue. Everything else
(the full multi-session journey) is already in auto-memory under
`[[project_brewser_unity_demos_probe]]`.

---

We are continuing a project: getting **Unity WebGL demos to actually RENDER**
(not a black canvas) inside **Brewser Runtime** on a real **Nintendo Switch**
(Tegra X1, Mesa-Nouveau GL). The probe app is
`D:\Workspace\custom_apps\com.natureglass.unity-demos` (a picker at
index.html → runner.html?demo=<slug> that boots one real Unity WebGL build
at a time and logs to NDJSON).

**Where we are (big win already banked):** Unity now fully **boots and runs**
its render loop on Brewser — every probe reports `COMPLETED`,
`raf_count` climbs, `first-frame-rendered` fires. Getting here took fixing a
stack of engine blockers (all DONE, shipped in the current clean NRO):
`document.URL` DOM shim, `.data` MIME in the shell resource loader,
TextDecoder UTF-16, a `Response.arrayBuffer()` in-memory fast-path, an async
`WebAssembly` sync-shim, and a `CanvasShim.id` DOM reflection. Read
`[[project_brewser_unity_demos_probe]]` in memory for the complete history +
exact fixes.

**THE REMAINING PROBLEM = shaders (this is the deep-dive):** the canvas is
**black** because Unity's **`Standard` (Built-in RP / PBR) shader fails to
compile** on Tegra/Mesa-Nouveau. Evidence is in the engine debug log
`D:\Desktop\nxjs-debug.log` — grep for `Creation of internal variant of
shader 'Standard' failed` (32×), `GL_EXT_shader_texture_lod`,
`GL_EXT_shader_framebuffer_fetch`, and `no matching function for call to
texture()`. Root cause: Unity's Standard shader is **GLSL ES 1.0** and uses
`#extension GL_EXT_shader_texture_lod` for reflection-probe LOD sampling
(`texture2DLodEXT` / `textureCubeLodEXT` / Unity's `cubeUVSample(...)`), but
**Mesa-Nouveau on Tegra does NOT support `GL_EXT_shader_texture_lod` in
fragment shaders**, so the LOD `texture()` calls hit `no matching function`
/ `type mismatch`. `GL_EXT_shader_framebuffer_fetch` is likewise
unsupported. The bridge currently passes the shader to Mesa untranslated.

**GOAL:** make the WebGL bridge translate/adapt Unity's shaders so Mesa
compiles them and the demos render. Likely fix direction: in the bridge's
shader path, rewrite `texture2DLodEXT`/`textureCubeLodEXT` (and the
`#extension GL_EXT_shader_texture_lod` directive) to **desktop-core
`textureLod`** (desktop GL, which Mesa exposes, *has* `textureLod`) before
handing the source to Mesa; decide what to do about
`GL_EXT_shader_framebuffer_fetch`. This is the same Tegra/Mesa class we've
solved before for Three.js — read these memories first:
`[[reference_pmrem_tegra_compiler_workaround]]`,
`[[reference_mesa_nouveau_layered_sampling_unsupported]]`,
`[[feedback_mesa_nouveau_mrt_quirks]]`,
`[[reference_citron_shader_translation_cache_cliff]]`,
`[[reference_nxjs_webgl_names]]`.

**Where the code lives:** the WebGL→GL bridge is
`D:\Workspace\nxjs-extended\source\webgl.cc` (~6700 lines). Start by finding
how it handles `shaderSource`/`compileShader` (grep `w_shader_source`,
`w_compile_shader`, `glShaderSource`, any existing GLSL rewriting/translation
pass, `#version`, `precision`, `#extension`). Determine whether it already
does any source rewriting we can extend, or passes GLSL straight to Mesa.
FIRST STEP should be to **read the actual failing shader source** — the
debug log shows only Mesa's errors, not the source; consider adding a
temporary trace in `w_compile_shader` (or `w_shader_source`) that dumps the
incoming GLSL to `nxjs-debug.log` so we can see exactly what Unity emits and
what needs rewriting. (Runtime `console.log`/stderr goes to
`D:\Desktop\nxjs-debug.log`, NOT the NDJSON — that's how we read Unity's own
output. NDJSON at `D:\Desktop\unity-demos` is harness milestones only.)

**Build + deploy loop (I build, USER tests):**
- Current clean NRO already built: `D:\Workspace\brewser\brewser.nro`
  (~69,438,806 bytes, 2026-08-05 12:51) — Unity boots+runs, no debug traces.
- For a `webgl.cc` (C++) change: rebuild via the devkitPro msys2 shell (NO
  bundle.mjs needed — that's only for TS/runtime changes):
  `MSYSTEM=MSYS "C:/devkitPro/msys2/usr/bin/bash.exe" -l /d/tmp/<script>.sh`
  where the script does `export PATH=/c/nvm4w/nodejs:$PATH; cd
  /d/Workspace/nxjs-extended && make` (needs `DEVKITPRO=/opt/devkitpro`,
  which the msys2 login shell sets). Then overlay:
  `cp /d/Workspace/nxjs-extended/nxjs.nro
  /d/Workspace/brewser/node_modules/@nx.js/nro/dist/nxjs.nro`, then
  `PATH=/c/nvm4w/nodejs:$PATH HOME=/c/Users/NatureGlass make -C
  /d/Workspace/brewser PYTHON=py nro`. Output: repo-root
  `D:\Workspace\brewser\brewser.nro`. Full flow +gotchas:
  `[[reference_nxjs_source_v8_build_flow]]`, `[[reference_brewser_v8_build_flow]]`.
- USER flashes `brewser.nro` to the Switch SD, runs the probes, and returns
  BOTH `D:\Desktop\nxjs-debug.log` (the important one — GL/shader output) and
  `D:\Desktop\unity-demos\*.ndjson`.

**Working rules (durable):** USER only tests; I run all builds/NRO steps.
Fixes are ENGINE-ONLY (don't patch the probe/app source). No design changes
without asking. Any change to the nx.js library
(`D:\Workspace\nxjs-extended`) needs a PR draft in
`D:\Workspace\nxjs-extended\upstream-prs\` (see the four PR-*.md I just wrote
for the format). Each Unity build's `brewser.nro` file size is distinct — use
it to confirm which build is actually deployed if results look stale.

Start by reading `[[project_brewser_unity_demos_probe]]` and the Tegra/Mesa
shader memories, then investigate `webgl.cc`'s shader-compile path and add a
shader-source dump so we can see Unity's actual GLSL. Then propose the
translation approach before building.
