<div align="center">

<img src="https://raw.githubusercontent.com/natureglass/Brewser-press/main/logo/brewser-logo.svg" alt="Brewser" width="260">

**A web runtime and app platform for devices your browser can't reach — starting with the Nintendo Switch.**

[![Latest release](https://img.shields.io/github/v/release/natureglass/Brewser)](https://github.com/natureglass/Brewser/releases/latest)
[![License: MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)
[![Documentation](https://img.shields.io/badge/docs-docs.brewser.io-4c1)](https://docs.brewser.io/docs)

<img src="https://raw.githubusercontent.com/natureglass/Brewser-press/main/screenshots/brewser_shell.png" alt="The Brewser shell running on a Nintendo Switch" width="720">

</div>

Brewser is a platform for creators, tinkerers, and developers — a curiosity-driven playground for sharing your ideas and projects with the world. If you've ever built something clever and then watched it vanish into the void, you're exactly who we made this for.

At its core, Brewser lets you build modern web applications using contemporary Web APIs that are cross-compatible with the **Brewser Runtime for Nintendo Switch**. Write once with standard web technologies, and your work runs across PC, mobile, and modded Switch consoles — no rewrites, no native toolchain, no fuss.

## Get it on your Switch

**You need:** a Switch running [Atmosphère](https://github.com/Atmosphere-NX/Atmosphere) custom firmware — tested on **1.10+** (older versions may work, but are untested) — with a working hbmenu setup. An internet connection is needed for the catalogue, sign-in, and cloud features; local apps work offline.

1. Download `brewser.nro` from the [latest release](https://github.com/natureglass/Brewser/releases/latest).
2. Copy it to your SD card at exactly `sd:/switch/brewser.nro`.
3. Launch it from the Homebrew Menu — for best performance, start hbmenu in full-memory application mode (hold **R** while launching a game) rather than applet mode.

**Prefer a home-menu icon?** Each release also ships `brewser-forwarder.nsp`, a forwarder that launches Brewser directly in full application mode (requires sigpatches — see the release notes for details).

**Updating** is built in: *Apps → Check for Updates*. Every update is cryptographically verified against the signing keyring baked into your build before it's applied, and rollbacks are refused. Bleeding-edge nightlies land in [`dist/`](dist/) on `main`; [releases](https://github.com/natureglass/Brewser/releases) are the tested builds you should run.

**No modded Switch?** The same apps run in any modern desktop or mobile browser — browse the catalogue at [brewser.io](https://brewser.io).

> Brewser runs web content. It does not run — or help run — commercial Switch games, ROMs, or backups. See the [Piracy, Legality & Safety FAQ](https://brewser.io/faq/).

### Bringing hidden work into the light

Too often, a great project's final destination is a GitHub repository — buried among thousands of others, good and bad, waiting for an audience that rarely arrives. Brewser exists to close that gap. We connect tinkerers who struggle to get their work in front of people with the people who actually want to see it, giving independent projects a home where they can be found, run, and appreciated.

> Your project deserves better than page 12 of a search result.

### Built for the physical and the interactive

Brewser is designed around how you create, connect, and interact with the world beyond the screen. Using established browser technologies — **WebUSB**, **Web Bluetooth**, **Web Audio**, the **Sensor APIs**, and more — you can talk directly to smart devices and sensors from your PC, phone, or Switch.

- Read an accelerometer or gyroscope in real time
- Drive a microcontroller or custom hardware
- Capture and process live audio
- Pair with Bluetooth peripherals

All from a standard web application — no native build needed.

### A home for the demoscene

Brewser also doubles as a demoscene environment. Whether it's a polished WebGL experience, a shader experiment, a procedural visual, or a scrappy little interactive demo, you can publish it here and share it with a community that actually appreciates the craft.

### A real platform, not just a browser

Brewser ships with everything an app needs to feel at home on a console: an on-screen keyboard, a proper toolbar, save-data support, leaderboards, the app catalogue right on the console, and sign-in that carries over from your PC. The shell is fully themeable — wallpapers (including animated GLSL shader wallpapers), styles, toolbars, cursors, and keyboards, all plain files on the SD card.

| ![MIDI Surface driving an AKAI LPD8 from the Switch](https://raw.githubusercontent.com/natureglass/Brewser-press/main/gif/web/brewser_midi-controller_web.gif) | ![Driving a WS2812B LED matrix from the Switch](https://raw.githubusercontent.com/natureglass/Brewser-press/main/gif/web/brewser_led_matrix_web.gif) | ![Three.js GLTF loader running at 60fps on the Switch](https://raw.githubusercontent.com/natureglass/Brewser-press/main/gif/web/brewser_threejs-gltf-loader_web.gif) |
|:--:|:--:|:--:|
| Web MIDI on real hardware | Driving an LED matrix | Three.js GLTF loader at 60fps |

More screenshots, GIFs, and the showreel live in the [press kit](https://github.com/natureglass/Brewser-press).

## In the catalogue at launch

The catalogue opens with more than 30 apps, including **DUSK Sky Atlas** (a Three.js planetarium with 132 Messier deep-sky objects, steered by the gyro), **Matrix Studio** (design and drive WS2812B LED panels over an ESP32, straight from the console), **MIDI Surface** (turn the Switch into a touchscreen MIDI controller), a **Home Assistant** dashboard, and on-device **WebNN** handwriting recognition. Alongside those sit a whole shelf of **Three.js WebGL2 demos** showcasing what the GPU can do — and a **Unity 2D platformer** export running unmodified on the console. Explore it all at [brewser.io](https://brewser.io).

---

## Getting your work out there

Publishing and managing your apps happens on the **[brewser.io](https://brewser.io)** website. Sign in, submit your app, try it out in staging on a real Switch, and publish when it's ready. Once it's live, anyone running Brewser Runtime can find and launch it. Every submission passes automated security scanning (static analysis and taint tracking) plus review before it can reach the public catalogue.

Published apps and publisher profiles earn [achievements](https://brewser.io/achievements/) along the way — badges derived from verifiable pipeline evidence, never applied for: from touching real hardware over WebUSB, to sustaining 60fps on the Tegra X1, down to sizecoder badges for apps under 4 KB.

## Documentation

Guides, Web API references, and everything about building for Brewser live at:

**[docs.brewser.io/docs](https://docs.brewser.io/docs)**

---

## Under the hood

Brewser Runtime is built on a fork of [nx.js](https://github.com/TooTallNate/nx.js) by [TooTallNate](https://github.com/TooTallNate), extending its V8/Skia foundation into a full web runtime for the Switch's Tegra X1. The extended engine source is public at [nx.js_extended](https://github.com/natureglass/nx.js_extended/tree/nxjs-extended) (branch `nxjs-extended`):

- **V8** with JIT and WebAssembly, **Skia** rendering, and **WebGL 1/2** on Mesa (Nouveau)
- Runs modern Three.js and WebGL2 apps at speed on the Tegra X1, handheld or docked
- Hardware APIs: **WebUSB**, **Web Serial** (CH340 & CP2102 adapters), **Web Bluetooth**, **Web MIDI**, **WebNN**
- Plus Web Audio, the Sensor APIs, and WASM

## What's in this repository

This repo contains the Brewser shell — the app you actually launch on your Switch — and its release tooling. The engine itself lives in the [nx.js_extended](https://github.com/natureglass/nx.js_extended/tree/nxjs-extended) repository.

| Path | What it is |
|---|---|
| `src/` | The Brewser shell (TypeScript) |
| `romfs/` | Bundled assets and configuration |
| `scripts/` | Build, packaging, and signed self-update tooling |
| `dist/` | Nightly signed builds — `brewser.nro` + `update.json`, served to the self-updater (tagged [releases](https://github.com/natureglass/Brewser/releases) are the tested builds) |
| `keys/` | Brewser's **public** release-signing keys (key IDs and public halves only — see [`keys/README.md`](keys/README.md)) |
| `tests/`, `docs/` | Tests and internal documentation |

## Building from source

```sh
make            # bump + build + package + sign + verify → dist/brewser.nro
```

The default build is pure Node — it needs `node`, `npm`, and `python` on your PATH, and **no devkitPro toolchain**, because it reuses the prebuilt engine NRO. Rebuilding the engine itself (`make -f Makefile_nxjs`) requires devkitPro and is only needed when engine source changes. There's also a no-release dev loop against the Citron emulator (`make sdmc`), so you can iterate on the shell without hardware.

Full details, targets, and the release/signing flow: **[Makefile.md](Makefile.md)**.

## Related repositories

| Repository | Purpose |
|---|---|
| [nx.js_extended](https://github.com/natureglass/nx.js_extended/tree/nxjs-extended) | Brewser's extended nx.js engine fork — full WebGL stack, Skia rendering, and platform APIs (branch `nxjs-extended`) |
| [Brewser-apps](https://github.com/natureglass/Brewser-apps) | The published app catalogue |
| [Brewser-apps-staging](https://github.com/natureglass/Brewser-apps-staging) | Staging — where submissions are tested on real hardware before going public |
| [Brewser-press](https://github.com/natureglass/Brewser-press) | Press kit — logos, screenshots, GIFs, showreel, factsheet |

## Press

Covering Brewser? Logos, screenshots, GIFs, a showreel, and a factsheet are in the [press kit](https://github.com/natureglass/Brewser-press), with full press information at [brewser.io/press](https://brewser.io/press). Press contact: [press@brewser.io](mailto:press@brewser.io).

## Support the project

The runtime, the catalogue, and the publishing pipeline are free to use, and they stay that way. If Brewser has been useful to you, a [small donation](https://brewser.io/donate) helps cover hosting, test hardware, and the late nights that turn a shader experiment into something that boots on a console.

## Acknowledgements

Brewser stands on the shoulders of the homebrew and open-source communities — above all [nx.js](https://github.com/TooTallNate/nx.js) by TooTallNate, whose work made a JavaScript runtime on the Switch possible in the first place, along with V8, Skia, Mesa, libuv, the devkitPro toolchain, and the [Atmosphère](https://github.com/Atmosphere-NX/Atmosphere) / switchbrew ecosystem.

---

Whatever you're building — a hardware experiment, a graphical demo, or a full-blown web app — Brewser gives your work a place to live, an audience to reach, and a runtime that follows it from the browser to the console.

---

## License

Brewser is released under the [Mozilla Public License 2.0](LICENSE).

## Disclaimer

Brewser is an independent homebrew project and is not affiliated with, endorsed by, sponsored by, licensed by, or approved by Nintendo. Nintendo Switch is a trademark of Nintendo Co., Ltd.

Brewser does not include, distribute, or provide Nintendo software, firmware, games, ROMs, encryption keys, copyrighted assets, exploits, or tools/instructions for bypassing technological protection measures. Users and contributors are responsible for complying with applicable laws and third-party terms.