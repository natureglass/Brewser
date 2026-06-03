// Three.js r162 textured rotating cube — adapted for switch-web-browser.
//
// A 1x1x1 BoxGeometry textured with a 4x4 RGBA checkerboard DataTexture,
// rotated each frame. The reference implementation for the inline-canvas
// WebGL + bridge readback path (see [[swb-threejs-cube]] for the perf
// journey).
//
// Differences from the upstream pattern:
//   - Tessellate the BoxGeometry to 8x8 segments per face to work around
//     the Tegra X1 TBR per-tile UV-interpolator bug (see [[threejs-cube-white-face]]).
//   - WebGLRenderer is given an explicit `context: gl` so Three.js never
//     tries to construct its own context from the canvas; the
//     canvas-runner already routed canvas.getContext('webgl') to the
//     shared screen GL context with bridge enabled.
//   - Stable Proxy on the gl context so Three.js's `instanceof
//     WebGLRenderingContext` and `gl.canvas` reads don't trip on the
//     shared screen context's shape.
//   - console.warn/log/error/info silenced because nx.js routes them
//     through $.print which flips the canvas into text-rendering mode
//     (see [[console-error-switches-render-mode]]).
//   - renderer.resetState() called before every render so Three.js's
//     WebGLState cache stays in sync with the bridge's independent GL
//     state writes (see [[threejs-resetstate-per-frame]]).

(function () {
  // Record progress to globals so the post-flight diagnostic script in
  // index.html can show which step failed when the cube doesn't render.
  globalThis.__cubeMainStarted = true;
  globalThis.__cubeAnimateCalled = false;
  globalThis.__cubeError = null;
  try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    globalThis.__cubeError = 'THREE not loaded — is assets/three.iife.js missing?';
    return;
  }

  // Read dimensions from the canvas itself so the demo responds to
  // the browser-shell's fullscreen-canvas rerun: when the user taps
  // "Toggle Fullscreen", canvas-runner resizes the offscreen to the
  // screen size (1280×720) and re-executes this script. With these
  // pulled from `canvas.width` / `.height`, the renderer + camera
  // automatically scale to the new dimensions.
  const cubeCanvasEl = document.getElementById('cube-canvas');
  const WIDTH = (cubeCanvasEl && cubeCanvasEl.width) || 640;
  const HEIGHT = (cubeCanvasEl && cubeCanvasEl.height) || 360;

  // Silence Three.js's noisy warnings so they don't flip the canvas to
  // text-render mode mid-frame. Permanent for the page's lifetime.
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvas = document.getElementById('cube-canvas');
  if (!canvas) {
    globalThis.__cubeError = '#cube-canvas missing in HTML';
    return;
  }

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    globalThis.__cubeError = 'WebGL acquire failed';
    return;
  }

  // Stable .constructor + .canvas Proxy so Three.js's internal
  // `instanceof WebGLRenderingContext` checks and `gl.canvas` reads
  // don't trip on the shared screen context shape. Function lookups
  // are cached so each call site doesn't allocate a new bound fn.
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

  // 4x4 checkerboard so the cube faces are obviously textured.
  const size = 4;
  const texData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const bright = ((x ^ y) & 1) === 0;
      texData[o + 0] = bright ? 240 : 40;
      texData[o + 1] = bright ? 240 : 180;
      texData[o + 2] = bright ? 240 : 90;
      texData[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(
    texData, size, size, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context,
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false,
  });
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.setClearColor(0x101820, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 100);
  camera.position.z = 3;

  // Tessellate each face into an 8x8 grid of quads (768 triangles total vs
  // the default 12) so no triangle spans more than a few hardware tiles.
  // Works around the Tegra X1 TBR's per-tile UV-interpolator coherency bug
  // ([[threejs-cube-white-face]]) — a single face-sized triangle triggers
  // the bug and renders an entire face as the brightest texel of the
  // texture, which on the 4x4 checkerboard texture below produces a fully
  // white face. Visible cube is exactly the same 1x1x1 size; only the
  // internal mesh subdivision changes. Same pattern as the sibling
  // geometry-cube demo.
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1, 8, 8, 8),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  cube.rotation.x = 0.45;
  cube.rotation.y = 0.65;
  scene.add(cube);

  // Probe 1: manual bridge clear to magenta BEFORE Three.js's render.
  // If this readback shows magenta, the bridge clear+readback path
  // works for this canvas — then any failure in Probe 2 is Three.js's
  // drawElements not reaching the bridge. Three.js's WebGLState may
  // have left SCISSOR_TEST enabled with a (0,0,0,0) box (it manages
  // scissor heavily and we never reset it after the renderer init);
  // a scissored clear writes nothing, so explicitly disable here.
  gl.disable(gl.SCISSOR_TEST);
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.clearColor(1, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const clearProbe = new Uint8Array(4);
  gl.readPixels(320, 180, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, clearProbe);
  globalThis.__cubeClearProbe =
    clearProbe[0] + ',' + clearProbe[1] + ',' + clearProbe[2] + ',' + clearProbe[3];
  globalThis.__cubeStatusAfterClear =
    (gl.getBackendInfo && gl.getBackendInfo().status) || '(no status)';

  // Probe 2: render once via Three.js and re-probe.
  globalThis.__cubeGlErrorBefore = gl.getError();
  renderer.render(scene, camera);
  globalThis.__cubeGlErrorAfter = gl.getError();
  try {
    const probe = new Uint8Array(4);
    gl.readPixels(320, 180, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
    globalThis.__cubeBridgeProbe =
      probe[0] + ',' + probe[1] + ',' + probe[2] + ',' + probe[3];
    globalThis.__cubeStatusAfterRender =
      (gl.getBackendInfo && gl.getBackendInfo().status) || '(no status)';
  } catch (e) {
    globalThis.__cubeBridgeProbe = 'threw: ' + ((e && e.message) || String(e));
  }

  function animate() {
    globalThis.__cubeAnimateCalled = true;
    cube.rotation.x += 0.01;
    cube.rotation.y += 0.015;
    // Three.js's `WebGLState` cache drifts each frame because nxjs's
    // bridge `gl.clear` and bridge native draws set viewport / scissor
    // / color-mask / program / texture binding independently of
    // Three.js's tracker. Calling `resetState()` per frame is the
    // simplest way to keep the renderer in sync. Tried calling it
    // only once on the first rAF tick (to save ~1 ms/frame) — the
    // cube stopped rendering after frame 2 as the cache fell out of
    // sync. So we eat the ~1 ms/frame cost for a correct cube.
    renderer.resetState();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    globalThis.__cubeError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
})();
