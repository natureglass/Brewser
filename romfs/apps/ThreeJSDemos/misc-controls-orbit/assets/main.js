// Three.js r162 misc_controls_orbit example - adapted for switch-web-browser.
//
// Source: three-r162/examples/misc_controls_orbit.html
//
// Differences from the upstream HTML:
//   - Canvas is fixed-size 640x360. resize / Stats / setPixelRatio /
//     window.innerWidth / document.body.appendChild dropped.
//   - OrbitControls.js (~1000 LOC, DOM-driven) replaced with our
//     gamepad-driven SwitchOrbitControls in libs/orbit-controls.js.
//     Same API surface (update, enableDamping, dampingFactor,
//     minDistance, maxDistance, maxPolarAngle, screenSpacePanning) so
//     the demo body reads near-identical to upstream. Mapping: left
//     stick orbit, right stick pan, ZL/ZR zoom.
//   - First milestone to exercise the bridge's second-directional-light
//     path (directionalLights[1].direction + .color) and FogExp2
//     (fogDensity), both extended into [[bridge-fog-support]] and
//     [[bridge-lighting-support]] in the same session as this demo.
//   - Don't set `renderer.useLegacyLights = true`. In r162 that property
//     is deprecated AND its semantics are the opposite of the name —
//     `true` multiplies all light colors by π, producing values like
//     (9.4, 9.4, 9.4) that the bridge (no tone mapping) saturates hard,
//     producing chromatic artifacts. Default `false` keeps light values
//     around (3, 3, 3) — still oversaturated but tolerable.
//   - 120 ConeGeometry meshes instead of upstream's 500. On the bridge
//     each cone is one draw call and per-draw overhead dominates; 500
//     ran at ~10 FPS, 120 holds ~25-30 FPS. To restore upstream count
//     we'd need to merge into one BufferGeometry.
//   - MeshPhongMaterial without upstream's `flatShading: true`. With
//     flatShading, Three.js skips writing `vNormal` and the GLES driver
//     optimizes out the `normal` attribute, so getAttribLocation('normal')
//     returns -1 and the bridge can't detect normals → unlit fallback.
//     See [[bridge-flatshading-gap]] for the proper derivative-normals
//     fix in the bridge fragment shader (not yet implemented).
//   - console.warn/log/error/info silenced; renderer.resetState() per
//     frame; stable Proxy on gl (same mandatory pattern as siblings).

globalThis.__orbitMainStarted = true;
globalThis.__orbitAnimateCalled = false;
globalThis.__orbitError = null;
globalThis.__orbitConeCount = 0;
globalThis.__orbitFrameCount = 0;
globalThis.__orbitFps = 0;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    globalThis.__orbitError = 'THREE not loaded - is libs/three.iife.js missing?';
    throw new Error('no THREE');
  }
  if (typeof globalThis.SwitchOrbitControls !== 'function') {
    globalThis.__orbitError = 'SwitchOrbitControls not loaded - is libs/orbit-controls.js missing?';
    throw new Error('no orbit controls');
  }

  // Read dimensions from the canvas itself so the demo responds to
  // the browser-shell's fullscreen-canvas rerun: when the user taps
  // "Toggle Fullscreen", canvas-runner resizes the offscreen to the
  // screen size (1280×720) and re-executes this script. With these
  // pulled from `canvas.width` / `.height`, the renderer + camera
  // automatically scale to the new dimensions.
  const orbitCanvasEl = document.getElementById('orbit-canvas');
  const WIDTH = (orbitCanvasEl && orbitCanvasEl.width) || 640;
  const HEIGHT = (orbitCanvasEl && orbitCanvasEl.height) || 360;

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvas = document.getElementById('orbit-canvas');
  if (!canvas) {
    globalThis.__orbitError = '#orbit-canvas missing in HTML';
    throw new Error('no canvas');
  }

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    globalThis.__orbitError = 'WebGL acquire failed';
    throw new Error('no gl');
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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcccccc);
  scene.fog = new THREE.FogExp2(0xcccccc, 0.002);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context,
    alpha: false,
    antialias: true,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false,
  });
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.setClearColor(0xcccccc, 1);

  const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 1, 1000);
  camera.position.set(400, 200, 0);

  const controls = new SwitchOrbitControls(THREE, camera);
  controls.listenToKeyEvents(globalThis);  // no-op on our shim, kept for fidelity
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;
  controls.minDistance = 100;
  controls.maxDistance = 500;
  controls.maxPolarAngle = Math.PI / 2;

  const CONE_COUNT = 120;
  const geometry = new THREE.ConeGeometry(10, 30, 4, 1);
  const material = new THREE.MeshPhongMaterial({ color: 0xffffff });

  for (let i = 0; i < CONE_COUNT; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = Math.random() * 1600 - 800;
    mesh.position.y = 0;
    mesh.position.z = Math.random() * 1600 - 800;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }
  globalThis.__orbitConeCount = CONE_COUNT;

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 3);
  dirLight1.position.set(1, 1, 1);
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x002288, 3);
  dirLight2.position.set(-1, -1, -1);
  scene.add(dirLight2);

  const ambientLight = new THREE.AmbientLight(0x555555);
  scene.add(ambientLight);

  let fpsWindowStart = 0;
  let fpsWindowFrames = 0;
  const FPS_WINDOW_MS = 3000;

  function animate() {
    globalThis.__orbitAnimateCalled = true;
    globalThis.__orbitFrameCount = (globalThis.__orbitFrameCount | 0) + 1;
    const now = performance.now ? performance.now() : Date.now();
    if (fpsWindowStart === 0) fpsWindowStart = now;
    fpsWindowFrames++;
    const elapsed = now - fpsWindowStart;
    if (elapsed >= FPS_WINDOW_MS) {
      globalThis.__orbitFps = Math.round((fpsWindowFrames * 1000) / elapsed * 10) / 10;
      fpsWindowStart = now;
      fpsWindowFrames = 0;
    }
    controls.update();
    renderer.resetState();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__orbitError) {
    globalThis.__orbitError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
