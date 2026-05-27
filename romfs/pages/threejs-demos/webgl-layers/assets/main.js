// Three.js r162 webgl_layers example - adapted for switch-web-browser.
//
// Source: three-r162/examples/webgl_layers.html
//
// Differences from the upstream HTML:
//   - Canvas is fixed-size 640x360. setPixelRatio / window.innerWidth /
//     resize listener / Stats / lil-gui / document.body.appendChild all
//     dropped.
//   - lil-gui control panel is replaced with gamepad button bindings.
//     The upstream gui exposes 5 actions: toggle red / green / blue /
//     enable all / disable all. Mapped to standard Switch buttons
//     (Web Gamepad spec indices):
//       B (button 0) → toggle red layer (0)
//       A (button 1) → toggle green layer (1)
//       Y (button 2) → toggle blue layer (2)
//       X (button 3) → enable all layers (resets to default visible state)
//     Rising-edge detection so holding a button doesn't keep toggling.
//   - console.warn/log/error/info silenced; renderer.resetState() per
//     frame; stable Proxy on gl (same mandatory pattern as siblings).
//   - First milestone to exercise the bridge's point-light path
//     ([[bridge-lighting-support]]): the camera-attached PointLight
//     drives `pointLights[0].position` + `.color` uniforms with the
//     per-fragment direction calc against `a_viewPosition`. With
//     `distance: 0, decay: 0` (the upstream values), no attenuation is
//     applied — pure Lambert against a per-fragment light vector.

globalThis.__layersMainStarted = true;
globalThis.__layersAnimateCalled = false;
globalThis.__layersError = null;
globalThis.__layersBoxCount = 0;
globalThis.__layersFrameCount = 0;
globalThis.__layersMask = 0;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    globalThis.__layersError = 'THREE not loaded - is libs/three.iife.js missing?';
    throw new Error('no THREE');
  }

  // Read dimensions from the canvas itself so the demo responds to
  // the browser-shell's fullscreen-canvas rerun: when the user taps
  // "Toggle Fullscreen", canvas-runner resizes the offscreen to the
  // screen size (1280×720) and re-executes this script. With these
  // pulled from `canvas.width` / `.height`, the renderer + camera
  // automatically scale to the new dimensions.
  const layersCanvasEl = document.getElementById('layers-canvas');
  const WIDTH = (layersCanvasEl && layersCanvasEl.width) || 640;
  const HEIGHT = (layersCanvasEl && layersCanvasEl.height) || 360;

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvas = document.getElementById('layers-canvas');
  if (!canvas) {
    globalThis.__layersError = '#layers-canvas missing in HTML';
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
    globalThis.__layersError = 'WebGL acquire failed';
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

  const camera = new THREE.PerspectiveCamera(70, WIDTH / HEIGHT, 0.1, 100);
  camera.position.z = 1800;  // Will be overwritten by orbit math, but start far
  camera.layers.enable(0);   // default enabled
  camera.layers.enable(1);
  camera.layers.enable(2);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf0f0f0);

  const light = new THREE.PointLight(0xffffff, 3, 0, 0);
  light.layers.enable(0);
  light.layers.enable(1);
  light.layers.enable(2);

  scene.add(camera);
  camera.add(light);

  const colors = [0xff0000, 0x00ff00, 0x0000ff];
  // Tessellate to 4×4 segments per axis to dodge the
  // [[threejs-cube-white-face]] tile-coherency bug on the larger cube
  // faces (random scale 0.5-1.5 × random distance from a camera that
  // orbits through the cube cloud means some faces are big enough to
  // trigger the rasterizer artifact). 4 segments rather than the cube
  // demo's 8 because the boxes here are smaller on screen — keeps the
  // tris-per-frame budget reasonable across all 300 boxes. The cubes
  // look visually identical; this is purely an internal subdivision.
  const geometry = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);

  for (let i = 0; i < 300; i++) {
    const layer = i % 3;
    const object = new THREE.Mesh(geometry,
      new THREE.MeshLambertMaterial({ color: colors[layer] }));
    object.position.x = Math.random() * 40 - 20;
    object.position.y = Math.random() * 40 - 20;
    object.position.z = Math.random() * 40 - 20;
    object.rotation.x = Math.random() * 2 * Math.PI;
    object.rotation.y = Math.random() * 2 * Math.PI;
    object.rotation.z = Math.random() * 2 * Math.PI;
    object.scale.x = Math.random() + 0.5;
    object.scale.y = Math.random() + 0.5;
    object.scale.z = Math.random() + 0.5;
    object.layers.set(layer);
    scene.add(object);
  }
  globalThis.__layersBoxCount = 300;

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
  renderer.setClearColor(0xf0f0f0, 1);

  // Gamepad layer toggle, rising-edge detection on each button.
  const prevButtons = [false, false, false, false];

  function pollGamepadButtons() {
    const pads = navigator.getGamepads();
    const pad = pads ? pads.find((g) => g && g.connected) : null;
    if (!pad) return;
    for (let i = 0; i < 4; i++) {
      const pressed = !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (pressed && !prevButtons[i]) {
        if (i === 0) camera.layers.toggle(0);        // B → red
        else if (i === 1) camera.layers.toggle(1);   // A → green
        else if (i === 2) camera.layers.toggle(2);   // Y → blue
        else if (i === 3) {                          // X → enable all
          camera.layers.enable(0);
          camera.layers.enable(1);
          camera.layers.enable(2);
        }
      }
      prevButtons[i] = pressed;
    }
  }

  let theta = 0;
  const radius = 5;

  globalThis.__layersGlErrorBefore = gl.getError();
  // Pre-position the camera so the first render isn't from the initial
  // z=1800 position (which would be outside the scene's ±20 range and
  // most boxes would clip past the far plane on the first frame).
  camera.position.x = 0;
  camera.position.y = 0;
  camera.position.z = radius;
  camera.lookAt(scene.position);
  renderer.resetState();
  renderer.render(scene, camera);
  globalThis.__layersGlErrorAfter = gl.getError();

  function animate() {
    globalThis.__layersAnimateCalled = true;
    globalThis.__layersFrameCount = (globalThis.__layersFrameCount | 0) + 1;

    pollGamepadButtons();

    theta += 0.1;
    camera.position.x = radius * Math.sin(THREE.MathUtils.degToRad(theta));
    camera.position.y = radius * Math.sin(THREE.MathUtils.degToRad(theta));
    camera.position.z = radius * Math.cos(THREE.MathUtils.degToRad(theta));
    camera.lookAt(scene.position);

    // Expose the current layer mask for the diagnostic.
    globalThis.__layersMask = camera.layers.mask & 0x7;

    renderer.resetState();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__layersError) {
    globalThis.__layersError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
