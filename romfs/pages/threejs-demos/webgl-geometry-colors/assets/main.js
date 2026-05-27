// Three.js r162 webgl_geometry_colors example - adapted for switch-web-browser.
//
// Source: three-r162/examples/webgl_geometry_colors.html
//
// Differences from the upstream HTML:
//   - Canvas is fixed-size 640x360 inline. setPixelRatio / window.innerWidth /
//     resize listener / Stats.js / document.body.appendChild(renderer.domElement)
//     all dropped.
//   - The shadow texture is built via an OffscreenCanvas (the upstream uses
//     document.createElement('canvas') for the same purpose). Read pixels with
//     getImageData and wrap in a DataTexture because nx.js's gl.texImage2D
//     only accepts buffer sources — `CanvasTexture` would call texImage2D
//     with the canvas element which throws.
//   - The 3 shadow planes use `PlaneGeometry(300, 300, 8, 8)` instead of
//     `(1, 1)` to dodge the Tegra X1 TBR per-tile UV-interpolator bug
//     ([[threejs-cube-white-face]]) — each shadow plane fills ~94% of the
//     viewport width so a single 300×300 triangle pair would absolutely
//     trigger the bug. Visible result is unchanged.
//   - Wireframe materials use `transparent: false` instead of upstream's
//     `transparent: true`. The wireframes are solid black with no alpha so
//     this has no visual effect, but dodges the bridge's
//     [[bridge-multi-transparent-batches-lost]] quirk where 3+ transparent
//     batches in one render() drop after the first.
//   - Mouse-driven camera replaced with gamepad left stick (same pattern as
//     the sibling webgl-lines-colors demo). Stick neutral → camera settles at
//     the natural rest pose (0, 0, 1800) looking at origin.
//   - SRGBColorSpace passed to setHSL/setRGB exactly as upstream. The bridge's
//     fixed-function output doesn't re-apply gamma so colors render slightly
//     darker than desktop Three.js. Accept; document in [[swb-threejs-cube]].
//   - First milestone to exercise the bridge's directional lighting path —
//     `bridge_color_program` now supports `a_normal` + `u_lightDirection` +
//     `u_lightColor` + `u_ambientLightColor` (see [[bridge-lighting-support]]).
//     MeshPhongMaterial with `shininess: 0` matches what the bridge does
//     (Lambert diffuse only, no specular).

globalThis.__geoColorsMainStarted = true;
globalThis.__geoColorsAnimateCalled = false;
globalThis.__geoColorsError = null;
globalThis.__geoColorsObjectCount = 0;
globalThis.__geoColorsFrameCount = 0;
globalThis.__geoColorsShadowTextureLoaded = false;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    globalThis.__geoColorsError = 'THREE not loaded - is libs/three.iife.js missing?';
    throw new Error('no THREE');
  }

  // Read dimensions from the canvas itself so the demo responds to
  // the browser-shell's fullscreen-canvas rerun: when the user taps
  // "Toggle Fullscreen", canvas-runner resizes the offscreen to the
  // screen size (1280×720) and re-executes this script. With these
  // pulled from `canvas.width` / `.height`, the renderer + camera
  // automatically scale to the new dimensions.
  const geoColorsCanvasEl = document.getElementById('geo-colors-canvas');
  const WIDTH = (geoColorsCanvasEl && geoColorsCanvasEl.width) || 640;
  const HEIGHT = (geoColorsCanvasEl && geoColorsCanvasEl.height) || 360;

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvas = document.getElementById('geo-colors-canvas');
  if (!canvas) {
    globalThis.__geoColorsError = '#geo-colors-canvas missing in HTML';
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
    globalThis.__geoColorsError = 'WebGL acquire failed';
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

  const camera = new THREE.PerspectiveCamera(20, WIDTH / HEIGHT, 1, 10000);
  camera.position.z = 1800;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(0, 0, 1);
  scene.add(light);

  // KNOWN ISSUE — open as of 2026-05-17 (milestone #3 close):
  //   The center icosahedron (position 0,0,0 — closest to camera in the
  //   front-to-back opaque sort) renders with 2-3 missing triangles in its
  //   top-left visible region. Wireframe lines still draw over the gap so
  //   the colored-fill draw is the one losing primitives, not the wireframe.
  //   Things ruled out so far:
  //     - Not the [[threejs-cube-white-face]] tile-coherency bug — bumping
  //       IcosahedronGeometry to detail=2 (4x more, 4x smaller triangles)
  //       did not change the symptom.
  //     - Not [[bridge-first-textured-draw-lost]] — a JS-side degenerate
  //       warmup mesh at renderOrder=-1 to absorb any leaked corrupted
  //       primitives did not change the symptom.
  //   The right icosahedron at x=+400 is also unrotated (same orientation
  //   as center) and renders fine. So the bug is position-sensitive — it
  //   fires specifically when this geometry lands at center-of-screen
  //   tiles. Likely a new bridge quirk surfaced by this milestone's
  //   draw-call mix (lighting + dense per-vertex color + closely-spaced
  //   opaque batches). To be revisited; closing milestone with the
  //   artifact accepted.

  // Build the shadow texture from a radial gradient. The upstream uses
  // document.createElement('canvas') for this; OffscreenCanvas works fine
  // here (we don't need to attach to a DOM). Read pixels with getImageData
  // and wrap in a DataTexture because nx.js's texImage2D only accepts
  // buffer sources, not canvas elements.
  const shadowSize = 128;
  const shadowOC = new OffscreenCanvas(shadowSize, shadowSize);
  const shadowCtx = shadowOC.getContext('2d');
  const gradient = shadowCtx.createRadialGradient(
    shadowSize / 2, shadowSize / 2, 0,
    shadowSize / 2, shadowSize / 2, shadowSize / 2);
  gradient.addColorStop(0.1, 'rgba(210,210,210,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,1)');
  shadowCtx.fillStyle = gradient;
  shadowCtx.fillRect(0, 0, shadowSize, shadowSize);
  const shadowPixels = new Uint8Array(
    shadowCtx.getImageData(0, 0, shadowSize, shadowSize).data.buffer);
  globalThis.__geoColorsShadowTextureLoaded = true;
  const shadowTexture = new THREE.DataTexture(
    shadowPixels, shadowSize, shadowSize,
    THREE.RGBAFormat, THREE.UnsignedByteType);
  shadowTexture.magFilter = THREE.LinearFilter;
  shadowTexture.minFilter = THREE.LinearFilter;
  shadowTexture.wrapS = THREE.ClampToEdgeWrapping;
  shadowTexture.wrapT = THREE.ClampToEdgeWrapping;
  shadowTexture.generateMipmaps = false;
  shadowTexture.needsUpdate = true;

  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture });
  // PlaneGeometry tessellation: upstream uses (300, 300, 1, 1) which would
  // hit the bridge's tile-coherency bug at this scale (each shadow plane
  // covers ~94% of viewport width). Bump to 8x8 segments per the
  // tessellation rule. ~128 triangles per shadow vs the default 2.
  const shadowGeo = new THREE.PlaneGeometry(300, 300, 8, 8);

  let shadowMesh;
  shadowMesh = new THREE.Mesh(shadowGeo, shadowMaterial);
  shadowMesh.position.y = -250;
  shadowMesh.rotation.x = -Math.PI / 2;
  scene.add(shadowMesh);

  shadowMesh = new THREE.Mesh(shadowGeo, shadowMaterial);
  shadowMesh.position.y = -250;
  shadowMesh.position.x = -400;
  shadowMesh.rotation.x = -Math.PI / 2;
  scene.add(shadowMesh);

  shadowMesh = new THREE.Mesh(shadowGeo, shadowMaterial);
  shadowMesh.position.y = -250;
  shadowMesh.position.x = 400;
  shadowMesh.rotation.x = -Math.PI / 2;
  scene.add(shadowMesh);

  const radius = 200;
  const geometry1 = new THREE.IcosahedronGeometry(radius, 1);

  const count = geometry1.attributes.position.count;
  geometry1.setAttribute('color',
    new THREE.BufferAttribute(new Float32Array(count * 3), 3));

  const geometry2 = geometry1.clone();
  const geometry3 = geometry1.clone();

  const color = new THREE.Color();
  const positions1 = geometry1.attributes.position;
  const positions2 = geometry2.attributes.position;
  const positions3 = geometry3.attributes.position;
  const colors1 = geometry1.attributes.color;
  const colors2 = geometry2.attributes.color;
  const colors3 = geometry3.attributes.color;

  for (let i = 0; i < count; i++) {
    color.setHSL((positions1.getY(i) / radius + 1) / 2, 1.0, 0.5,
      THREE.SRGBColorSpace);
    colors1.setXYZ(i, color.r, color.g, color.b);

    color.setHSL(0, (positions2.getY(i) / radius + 1) / 2, 0.5,
      THREE.SRGBColorSpace);
    colors2.setXYZ(i, color.r, color.g, color.b);

    color.setRGB(1, 0.8 - (positions3.getY(i) / radius + 1) / 2, 0,
      THREE.SRGBColorSpace);
    colors3.setXYZ(i, color.r, color.g, color.b);
  }

  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    flatShading: true,
    vertexColors: true,
    shininess: 0,
  });

  // Wireframe materials: upstream uses `transparent: true` for Three.js's
  // render-order sorting. The bridge has the
  // [[bridge-multi-transparent-batches-lost]] quirk (3+ transparent batches
  // in one render() drop after the first). These wireframes are solid black
  // with no alpha so `transparent: false` looks identical and dodges the bug.
  const wireframeMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000, wireframe: true, transparent: false,
  });

  let mesh = new THREE.Mesh(geometry1, material);
  let wireframe = new THREE.Mesh(geometry1, wireframeMaterial);
  mesh.add(wireframe);
  mesh.position.x = -400;
  mesh.rotation.x = -1.87;
  scene.add(mesh);

  mesh = new THREE.Mesh(geometry2, material);
  wireframe = new THREE.Mesh(geometry2, wireframeMaterial);
  mesh.add(wireframe);
  mesh.position.x = 400;
  scene.add(mesh);

  mesh = new THREE.Mesh(geometry3, material);
  wireframe = new THREE.Mesh(geometry3, wireframeMaterial);
  mesh.add(wireframe);
  scene.add(mesh);

  globalThis.__geoColorsObjectCount = scene.children.length;

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
  renderer.setClearColor(0xffffff, 1);

  // Gamepad-driven camera (replaces upstream's pointermove handler).
  // Stick neutral → mouseX/mouseY stay 0 → lerp settles at (0, 0, 1800)
  // looking at origin. Same pattern as the sibling webgl-lines-colors demo.
  const STICK_DEADZONE = 0.15;
  const STICK_RANGE = 800;
  let mouseX = 0;
  let mouseY = 0;

  function pollGamepad() {
    const pads = navigator.getGamepads();
    const pad = pads ? pads.find((g) => g && g.connected) : null;
    if (!pad) return;
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const absX = Math.abs(ax);
    const absY = Math.abs(ay);
    mouseX = absX < STICK_DEADZONE ? 0
      : Math.sign(ax) * ((absX - STICK_DEADZONE) / (1 - STICK_DEADZONE)) * STICK_RANGE;
    mouseY = absY < STICK_DEADZONE ? 0
      : Math.sign(ay) * ((absY - STICK_DEADZONE) / (1 - STICK_DEADZONE)) * STICK_RANGE;
  }

  globalThis.__geoColorsGlErrorBefore = gl.getError();
  renderer.resetState();
  renderer.render(scene, camera);
  globalThis.__geoColorsGlErrorAfter = gl.getError();

  function animate() {
    globalThis.__geoColorsAnimateCalled = true;
    globalThis.__geoColorsFrameCount = (globalThis.__geoColorsFrameCount | 0) + 1;

    pollGamepad();

    camera.position.x += (mouseX - camera.position.x) * 0.05;
    camera.position.y += (-mouseY - camera.position.y) * 0.05;
    camera.lookAt(scene.position);

    renderer.resetState();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__geoColorsError) {
    globalThis.__geoColorsError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
