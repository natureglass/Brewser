// Three.js r162 webgl_materials_texture_filters example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_materials_texture_filters.html
//
// Pre-authorized deviations:
//   1. `THREE = globalThis.__THREE_R162_STAGED__` instead of importmap.
//   2. Fullscreen-responsive canvas; resize listener / setPixelRatio dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each render.
//   6. `renderer.setSize(W, H, false)`.
//   7. Stats addon dropped.
//   8. Mouse-driven camera → gamepad left stick.
//   9. `TextureLoader(jpg)` → Image + OffscreenCanvas + DataTexture
//      pipeline; `Image.src` to SDMC path.
//
// Per-milestone-#24 deviation (user-approved 2026-05-22):
//   A. **`CanvasTexture(htmlCanvas)` → `DataTexture(pixelArray)`**.
//      Upstream builds an 8x8 checkerboard pattern via
//      `document.createElement('canvas')` + `ctx.fillRect` calls,
//      wrapping in `CanvasTexture`. nx.js's `texImage2D` doesn't
//      accept canvas elements directly (the established cross-
//      milestone gotcha), so we encode the same 8x8 checker pattern
//      directly into a 128x128x4 `Uint8Array` and wrap in
//      `DataTexture`. Equivalent visual; sidesteps the canvas-as-
//      texture upload gap.
//
// Bridge surface this milestone forced (see [[swb-threejs-webgl-materials-texture-filters]]):
//   - `tex_parameteri` widened to accept the 4 mipmap MIN_FILTER
//     variants (pre-fix returned INVALID_ENUM on all of them).
//   - `generateMipmap` implementation real instead of no-op
//     (promote-if-needed via shared `ensure_texture_promoted` helper +
//     call native `glGenerateMipmap`).
//   - `persistent_texture_image_2d` now passes mipmap minFilter
//     variants through to native instead of collapsing to NEAREST.

globalThis.__filtersError = null;
globalThis.__filtersFrameCount = 0;
globalThis.__filtersFps = 0;
globalThis.__filtersPaintingLoaded = false;
globalThis.__filtersPaintingW = 0;
globalThis.__filtersPaintingH = 0;
globalThis.__filtersGenMipmapCalls = 0;
globalThis.__filtersMipmapFilterOk = false;
globalThis.__filtersGlErrorBefore = 0;
globalThis.__filtersGlErrorAfter = 0;

(async () => {
try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) throw new Error('THREE not loaded - is libs/three.iife.js missing?');

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvasEl = document.getElementById('filters-canvas');
  if (!canvasEl) throw new Error('#filters-canvas missing in HTML');
  const SCREEN_WIDTH = canvasEl.width || 640;
  const SCREEN_HEIGHT = canvasEl.height || 360;

  const canvas = canvasEl;
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: true,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL acquire failed');
  if (typeof gl.enableGpuBridgePrototype === 'function') {
    gl.enableGpuBridgePrototype(true);
  }
  const stableConstructor = { name: 'WebGLRenderingContext' };
  const fnCache = new Map();
  const context = new Proxy(gl, {
    get(target, property, receiver) {
      if (property === 'constructor') return stableConstructor;
      if (property === 'canvas') return canvas;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (fnCache.has(property)) return fnCache.get(property);
      const bound = (...args) => value.apply(target, args);
      fnCache.set(property, bound);
      return bound;
    },
  });

  // ===== Build the floor checkerboard as a 128x128 DataTexture =====
  // Upstream's CanvasTexture is built by drawing two 64x64 #fff
  // squares on a #444 background — net effect is a 2x2 macro
  // checkerboard at 128x128 resolution. Replicate exactly via
  // Uint8Array. Light gray (0x44=68) for the background, white
  // (0xff=255) for the two diagonal squares.
  function buildFloorTexture(NearestFilter) {
    const SIZE = 128;
    const pixels = new Uint8Array(SIZE * SIZE * 4);
    const HALF = SIZE / 2;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        const tl = x < HALF && y < HALF;        // top-left → #fff
        const br = x >= HALF && y >= HALF;      // bottom-right → #fff
        const v = (tl || br) ? 255 : 0x44;
        pixels[i + 0] = v;
        pixels[i + 1] = v;
        pixels[i + 2] = v;
        pixels[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(pixels, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Upstream 1000× repeat preserved — the floor uses a custom
    // ShaderMaterial below with `#pragma raw_passthrough` so it runs
    // verbatim on native GLES with perspective-correct UV interpolation.
    // No more affine-UV Moiré. The Three.js auto-shader's `texture.repeat`
    // mapTransform isn't applied for ShaderMaterial — instead the value
    // is read from `tex.repeat` here and passed to the shader via a
    // `mapScale` uniform.
    tex.repeat.set(1000, 1000);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (NearestFilter) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    } else {
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
    }
    tex.needsUpdate = true;
    return tex;
  }

  // Build a ShaderMaterial for the floor that runs verbatim on native
  // GLES via the bridge's raw_passthrough path (per
  // [[bridge-raw-shader-passthrough]]). Bypasses the bridge's CPU-side
  // perspective divide so GLES gets `gl_Position.w` correctly varying →
  // perspective-correct varying interpolation → no affine-UV Moiré at
  // any UV scale. This lets us keep upstream's 1000× repeat and a
  // light 8×8 tessellation while still rendering cleanly at near-,
  // mid-, and far-camera distances. Also dramatically faster than the
  // bridge_texture_program path for huge geometry (the CPU divide was
  // the FPS bottleneck at the higher tessellations).
  //
  // Per-milestone-#24 deviation: the upstream demo uses
  // MeshBasicMaterial, which would go through the bridge's
  // bridge_texture_program and hit the affine-UV issue. The
  // ShaderMaterial below implements the same fragment compose (texture
  // sample × color tint, plus linear fog) but in user GLSL routed
  // through native GLES.
  function buildFloorMaterial(floorTexture, repeat, tintColor) {
    return new THREE.ShaderMaterial({
      uniforms: {
        map: { value: floorTexture },
        mapScale: { value: new THREE.Vector2(repeat, repeat) },
        tintColor: { value: new THREE.Color(tintColor) },
        fogColor: { value: new THREE.Color(0x000000) },
        fogNear: { value: 1500 },
        fogFar: { value: 4000 },
      },
      vertexShader: `#pragma raw_passthrough
        uniform vec2 mapScale;
        varying vec2 vUv;
        varying float vFogDepth;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vFogDepth = -mvPosition.z;
          vUv = uv * mapScale;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `#pragma raw_passthrough
        precision mediump float;
        uniform sampler2D map;
        uniform vec3 tintColor;
        uniform vec3 fogColor;
        uniform float fogNear;
        uniform float fogFar;
        varying vec2 vUv;
        varying float vFogDepth;
        void main() {
          vec4 texel = texture2D(map, vUv);
          vec3 color = texel.rgb * tintColor;
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
          color = mix(color, fogColor, fogFactor);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }

  // ===== Load the Caravaggio painting as a DataTexture =====
  async function loadPaintingTexture(NearestFilter) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(new Error('caravaggio.jpg load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
      img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-materials-texture-filters/assets/caravaggio.jpg';
    });
    const tw = img.width;
    const th = img.height;
    const off = new OffscreenCanvas(tw, th);
    const oc = off.getContext('2d');
    oc.drawImage(img, 0, 0);
    const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
    const tex = new THREE.DataTexture(pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    if (NearestFilter) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
    } else {
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
    }
    tex.needsUpdate = true;
    return { tex, w: tw, h: th };
  }

  // Probe the new bridge surface so the status canvas can report it.
  // We wrap gl.generateMipmap to count calls, and we test a
  // LinearMipmapLinear texParameteri once with a throwaway texture
  // (cleaning up the error queue afterwards).
  const origGenerateMipmap = gl.generateMipmap.bind(gl);
  gl.generateMipmap = function (target) {
    globalThis.__filtersGenMipmapCalls = (globalThis.__filtersGenMipmapCalls | 0) + 1;
    return origGenerateMipmap(target);
  };
  {
    const probeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, probeTex);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    globalThis.__filtersMipmapFilterOk = gl.getError() === gl.NO_ERROR;
    gl.deleteTexture(probeTex);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
  }

  let camera, scene, scene2, renderer;
  let mouseX = 0, mouseY = 0;

  // Gamepad-driven camera (replaces upstream's pointermove handler).
  // Declared BEFORE `animate()` so the synchronous first-frame call's
  // pollGamepad() doesn't hit a temporal-dead-zone on these consts.
  // Stick neutral → mouseX/mouseY stay 0 → camera settles at
  // (0, 0, 1500) looking at origin.
  const STICK_DEADZONE = 0.15;
  const STICK_RANGE_X = 800;
  const STICK_RANGE_Y = 400;
  function pollGamepad() {
    const pads = navigator.getGamepads();
    const pad = pads ? pads.find((g) => g && g.connected) : null;
    if (!pad) return;
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const absX = Math.abs(ax);
    const absY = Math.abs(ay);
    mouseX = absX < STICK_DEADZONE ? 0
      : Math.sign(ax) * ((absX - STICK_DEADZONE) / (1 - STICK_DEADZONE)) * STICK_RANGE_X;
    mouseY = absY < STICK_DEADZONE ? 0
      : Math.sign(ay) * ((absY - STICK_DEADZONE) / (1 - STICK_DEADZONE)) * STICK_RANGE_Y;
  }

  await init();
  animate();

  async function init() {
    camera = new THREE.PerspectiveCamera(35, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 5000);
    camera.position.z = 1500;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 1500, 4000);

    scene2 = new THREE.Scene();
    scene2.background = new THREE.Color(0x000000);
    scene2.fog = new THREE.Fog(0x000000, 1500, 4000);

    // FLOOR
    const textureFloor1 = buildFloorTexture(false);   // LinearMipmapLinear / Linear
    const textureFloor2 = buildFloorTexture(true);    // Nearest / Nearest

    // Floor uses ShaderMaterial+raw_passthrough so the bridge skips its
    // CPU perspective divide → GLES does perspective-correct UV interp
    // → no Moiré at any scale. The right scene's `color: 0xffccaa` tint
    // is passed through the `tintColor` uniform.
    const materialFloor1 = buildFloorMaterial(textureFloor1, 1000, 0xffffff);
    const materialFloor2 = buildFloorMaterial(textureFloor2, 1000, 0xffccaa);

    // PlaneGeometry tessellation, two scales for two purposes:
    //
    // - **Painting + frame + shadow** (planeGeo, 16×16): upstream's
    //   bare PlaneGeometry(100, 100) is just 2 large triangles, and at
    //   ×7.58 scale they span many screen tiles → diagonal stripes
    //   from Tegra's TBR per-tile UV interpolator quirk
    //   ([[threejs-cube-white-face]]). 16×16 = 512 triangles per quad
    //   keeps each screen-space tri small.
    //
    // - **Floor** (floorGeo, 8×8): with the floor running through
    //   raw_passthrough (perspective-correct UV interp), affine error
    //   isn't a concern anymore. Modest tessellation is still useful
    //   for the TBR per-tile coherency bug on huge screen triangles,
    //   but doesn't need to be high. 8×8 = 128 tris per floor → ~256
    //   tris total → effectively free GPU cost. Citron 60 FPS target.
    const planeGeo = new THREE.PlaneGeometry(100, 100, 16, 16);
    const floorGeo = new THREE.PlaneGeometry(100, 100, 8, 8);

    const meshFloor1 = new THREE.Mesh(floorGeo, materialFloor1);
    meshFloor1.rotation.x = -Math.PI / 2;
    meshFloor1.scale.set(1000, 1000, 1000);

    const meshFloor2 = new THREE.Mesh(floorGeo, materialFloor2);
    meshFloor2.rotation.x = -Math.PI / 2;
    meshFloor2.scale.set(1000, 1000, 1000);

    // PAINTING (loaded once, two textures sharing the pixel data)
    const painting1 = await loadPaintingTexture(false);  // Linear
    const painting2 = await loadPaintingTexture(true);   // Nearest
    globalThis.__filtersPaintingLoaded = true;
    globalThis.__filtersPaintingW = painting1.w;
    globalThis.__filtersPaintingH = painting1.h;

    const materialPainting1 = new THREE.MeshBasicMaterial({ color: 0xffffff, map: painting1.tex });
    const materialPainting2 = new THREE.MeshBasicMaterial({ color: 0xffccaa, map: painting2.tex });

    scene.add(meshFloor1);
    scene2.add(meshFloor2);

    function addPainting(zscene, zmesh, w, h) {
      zmesh.scale.x = w / 100;
      zmesh.scale.y = h / 100;
      zscene.add(zmesh);

      // Frame is at z=-10 upstream — only 10 units behind the painting
      // with a camera 1500 units away. The bridge's CPU-side perspective
      // divide loses too much precision at that ratio → z-fighting
      // between painting and frame manifests as diagonal black stripes
      // following PlaneGeometry's triangle split. Fix: take the frame
      // out of depth testing entirely + force it to render BEFORE the
      // painting via renderOrder. Painting then paints normally on top
      // with no depth-buffer race.
      const meshFrame = new THREE.Mesh(planeGeo,
        new THREE.MeshBasicMaterial({
          color: 0x000000,
          depthTest: false,
          depthWrite: false,
        }));
      meshFrame.position.z = -10.0;
      meshFrame.scale.x = 1.1 * w / 100;
      meshFrame.scale.y = 1.1 * h / 100;
      meshFrame.renderOrder = -1;
      zscene.add(meshFrame);

      const meshShadow = new THREE.Mesh(planeGeo,
        new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.75, transparent: true }));
      meshShadow.position.y = -1.1 * h / 2;
      meshShadow.position.z = -1.1 * h / 2;
      meshShadow.rotation.x = -Math.PI / 2;
      meshShadow.scale.x = 1.1 * w / 100;
      meshShadow.scale.y = 1.1 * h / 100;
      zscene.add(meshShadow);
    }
    addPainting(scene, new THREE.Mesh(planeGeo, materialPainting1), painting1.w, painting1.h);
    addPainting(scene2, new THREE.Mesh(planeGeo, materialPainting2), painting2.w, painting2.h);

    const floorHeight = -1.117 * painting1.h / 2;
    meshFloor1.position.y = meshFloor2.position.y = floorHeight;

    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
    renderer.setSize(SCREEN_WIDTH, SCREEN_HEIGHT, false);
    renderer.autoClear = false;

    globalThis.__filtersGlErrorBefore = gl.getError();
    renderer.resetState();
    renderer.clear();
    renderer.render(scene, camera);
    globalThis.__filtersGlErrorAfter = gl.getError();
  }

  function animate() {
    requestAnimationFrame(animate);
    pollGamepad();
    render();

    globalThis.__filtersFrameCount = (globalThis.__filtersFrameCount | 0) + 1;
    if (!animate._fpsStart) animate._fpsStart = Date.now();
    if (!animate._fpsFrames) animate._fpsFrames = 0;
    animate._fpsFrames++;
    const elapsed = Date.now() - animate._fpsStart;
    if (elapsed >= 3000) {
      globalThis.__filtersFps = Math.round(animate._fpsFrames * 1000 / elapsed);
      animate._fpsStart = Date.now();
      animate._fpsFrames = 0;
    }
  }

  function render() {
    camera.position.x += (mouseX - camera.position.x) * 0.05;
    camera.position.y += (-(mouseY - 200) - camera.position.y) * 0.05;
    camera.lookAt(scene.position);

    // resetState BEFORE setScissor / setScissorTest per
    // [[threejs-resetstate-scissor-ordering]]; resetState clears
    // scissor state so setScissorTest must be re-asserted each pass.
    renderer.resetState();
    renderer.clear();
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, SCREEN_WIDTH / 2 - 2, SCREEN_HEIGHT);
    renderer.render(scene, camera);

    renderer.resetState();
    renderer.setScissorTest(true);
    renderer.setScissor(SCREEN_WIDTH / 2, 0, SCREEN_WIDTH / 2 - 2, SCREEN_HEIGHT);
    renderer.render(scene2, camera);

    renderer.setScissorTest(false);
  }
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__filtersError) {
    globalThis.__filtersError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
})();
