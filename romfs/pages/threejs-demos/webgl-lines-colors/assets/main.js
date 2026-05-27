// Three.js r162 webgl_lines_colors example - adapted for switch-web-browser.
//
// Source: three-r162/examples/webgl_lines_colors.html
//
// Differences from the upstream HTML:
//   - Canvas is fixed-size 640x360 inline; resize listener / setPixelRatio /
//     window.innerWidth are dropped.
//   - hilbert3D is inlined (~25 LOC) — same as the sibling webgl-lines-dashed
//     demo. The upstream's `import { hilbert3D } from
//     'three/addons/utils/GeometryUtils.js'` ESM pathway has no equivalent
//     in our IIFE-only setup.
//   - The pointermove listener and mouseX/mouseY camera follow are replaced
//     with a gamepad-driven equivalent: the left analog stick deflects the
//     camera (axis 0 → mouseX, axis 1 → mouseY) with a deadzone. Same lerp
//     loop as upstream, so the camera still settles at the rest pose
//     `(0, 200, 1000)` when the stick is neutral. Stick range scaled to
//     match the upstream's typical mouse extent. This wiring is anticipated
//     to be the foundation for OrbitControls in milestone #5.
//   - SRGBColorSpace is preserved from upstream. Three.js converts the
//     HSL color values to linear-space before uploading; the bridge's
//     fixed-function output doesn't re-apply gamma, so colors render
//     slightly darker than desktop. Same caveat as geometry-cube. Accept.
//   - console.warn/log/error/info silenced; renderer.resetState() per
//     frame; stable Proxy on gl context (same mandatory pattern as the
//     sibling demos).
//   - document.body.style.touchAction = 'none' and renderer.domElement
//     appending are dropped (DOM gaps; no-op on this runtime).

globalThis.__linesColorsMainStarted = true;
globalThis.__linesColorsAnimateCalled = false;
globalThis.__linesColorsError = null;
globalThis.__linesColorsObjectCount = 0;
globalThis.__linesColorsFrameCount = 0;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    globalThis.__linesColorsError = 'THREE not loaded - is assets/three.iife.js missing?';
    throw new Error('no THREE');
  }

  // Read dimensions from the canvas itself so the demo responds to
  // the browser-shell's fullscreen-canvas rerun: when the user taps
  // "Toggle Fullscreen", canvas-runner resizes the offscreen to the
  // screen size (1280×720) and re-executes this script. With these
  // pulled from `canvas.width` / `.height`, the renderer + camera
  // automatically scale to the new dimensions.
  const linesColorsCanvasEl = document.getElementById('lines-colors-canvas');
  const WIDTH = (linesColorsCanvasEl && linesColorsCanvasEl.width) || 640;
  const HEIGHT = (linesColorsCanvasEl && linesColorsCanvasEl.height) || 360;

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvas = document.getElementById('lines-colors-canvas');
  if (!canvas) {
    globalThis.__linesColorsError = '#lines-colors-canvas missing in HTML';
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
    globalThis.__linesColorsError = 'WebGL acquire failed';
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

  // Inlined from three-r162/examples/jsm/utils/GeometryUtils.js.
  function hilbert3D(center, size, iterations, v0, v1, v2, v3, v4, v5, v6, v7) {
    const half = size / 2;
    const vec_s = [
      new THREE.Vector3(center.x - half, center.y + half, center.z - half),
      new THREE.Vector3(center.x - half, center.y + half, center.z + half),
      new THREE.Vector3(center.x - half, center.y - half, center.z + half),
      new THREE.Vector3(center.x - half, center.y - half, center.z - half),
      new THREE.Vector3(center.x + half, center.y - half, center.z - half),
      new THREE.Vector3(center.x + half, center.y - half, center.z + half),
      new THREE.Vector3(center.x + half, center.y + half, center.z + half),
      new THREE.Vector3(center.x + half, center.y + half, center.z - half),
    ];
    const vec = [
      vec_s[v0], vec_s[v1], vec_s[v2], vec_s[v3],
      vec_s[v4], vec_s[v5], vec_s[v6], vec_s[v7],
    ];
    if (--iterations >= 0) {
      return [
        ...hilbert3D(vec[0], half, iterations, v0, v3, v4, v7, v6, v5, v2, v1),
        ...hilbert3D(vec[1], half, iterations, v0, v7, v6, v1, v2, v5, v4, v3),
        ...hilbert3D(vec[2], half, iterations, v0, v7, v6, v1, v2, v5, v4, v3),
        ...hilbert3D(vec[3], half, iterations, v2, v3, v0, v1, v6, v7, v4, v5),
        ...hilbert3D(vec[4], half, iterations, v2, v3, v0, v1, v6, v7, v4, v5),
        ...hilbert3D(vec[5], half, iterations, v4, v3, v2, v5, v6, v1, v0, v7),
        ...hilbert3D(vec[6], half, iterations, v4, v3, v2, v5, v6, v1, v0, v7),
        ...hilbert3D(vec[7], half, iterations, v6, v5, v2, v1, v0, v3, v4, v7),
      ];
    }
    return vec;
  }

  const camera = new THREE.PerspectiveCamera(33, WIDTH / HEIGHT, 1, 10000);
  camera.position.z = 1000;

  const scene = new THREE.Scene();

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
  renderer.setClearColor(0x000000, 1);

  const hilbertPoints = hilbert3D(new THREE.Vector3(0, 0, 0), 200.0, 1,
                                   0, 1, 2, 3, 4, 5, 6, 7);

  const geometry1 = new THREE.BufferGeometry();
  const geometry2 = new THREE.BufferGeometry();
  const geometry3 = new THREE.BufferGeometry();

  const subdivisions = 6;

  let vertices = [];
  let colors1 = [];
  let colors2 = [];
  let colors3 = [];

  const point = new THREE.Vector3();
  const color = new THREE.Color();

  const spline = new THREE.CatmullRomCurve3(hilbertPoints);

  for (let i = 0; i < hilbertPoints.length * subdivisions; i++) {
    const t = i / (hilbertPoints.length * subdivisions);
    spline.getPoint(t, point);
    vertices.push(point.x, point.y, point.z);

    color.setHSL(0.6, 1.0, Math.max(0, -point.x / 200) + 0.5, THREE.SRGBColorSpace);
    colors1.push(color.r, color.g, color.b);

    color.setHSL(0.9, 1.0, Math.max(0, -point.y / 200) + 0.5, THREE.SRGBColorSpace);
    colors2.push(color.r, color.g, color.b);

    color.setHSL(i / (hilbertPoints.length * subdivisions), 1.0, 0.5, THREE.SRGBColorSpace);
    colors3.push(color.r, color.g, color.b);
  }

  geometry1.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry2.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry3.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

  geometry1.setAttribute('color', new THREE.Float32BufferAttribute(colors1, 3));
  geometry2.setAttribute('color', new THREE.Float32BufferAttribute(colors2, 3));
  geometry3.setAttribute('color', new THREE.Float32BufferAttribute(colors3, 3));

  const geometry4 = new THREE.BufferGeometry();
  const geometry5 = new THREE.BufferGeometry();
  const geometry6 = new THREE.BufferGeometry();

  vertices = [];
  colors1 = [];
  colors2 = [];
  colors3 = [];

  for (let i = 0; i < hilbertPoints.length; i++) {
    const p = hilbertPoints[i];
    vertices.push(p.x, p.y, p.z);

    color.setHSL(0.6, 1.0, Math.max(0, (200 - p.x) / 400) * 0.5 + 0.5, THREE.SRGBColorSpace);
    colors1.push(color.r, color.g, color.b);

    color.setHSL(0.3, 1.0, Math.max(0, (200 + p.x) / 400) * 0.5, THREE.SRGBColorSpace);
    colors2.push(color.r, color.g, color.b);

    color.setHSL(i / hilbertPoints.length, 1.0, 0.5, THREE.SRGBColorSpace);
    colors3.push(color.r, color.g, color.b);
  }

  geometry4.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry5.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry6.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

  geometry4.setAttribute('color', new THREE.Float32BufferAttribute(colors1, 3));
  geometry5.setAttribute('color', new THREE.Float32BufferAttribute(colors2, 3));
  geometry6.setAttribute('color', new THREE.Float32BufferAttribute(colors3, 3));

  const material = new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true });
  const baseScale = 0.3 * 1.5;
  const d = 225;

  const parameters = [
    [material, baseScale, [-d, -d / 2, 0], geometry1],
    [material, baseScale, [ 0, -d / 2, 0], geometry2],
    [material, baseScale, [ d, -d / 2, 0], geometry3],
    [material, baseScale, [-d,  d / 2, 0], geometry4],
    [material, baseScale, [ 0,  d / 2, 0], geometry5],
    [material, baseScale, [ d,  d / 2, 0], geometry6],
  ];

  for (let i = 0; i < parameters.length; i++) {
    const p = parameters[i];
    const line = new THREE.Line(p[3], p[0]);
    line.scale.x = line.scale.y = line.scale.z = p[1];
    line.position.x = p[2][0];
    line.position.y = p[2][1];
    line.position.z = p[2][2];
    scene.add(line);
  }
  globalThis.__linesColorsObjectCount = parameters.length;

  // Gamepad-driven camera (replaces the upstream pointermove handler).
  // Left stick X/Y → camera follow in the same screen-space sense as the
  // upstream mouse handler. Stick neutral → mouseX/mouseY stay 0 → the
  // lerp settles the camera at (0, 200, 1000) looking at origin. Stick
  // deflected → camera pans up to ±STICK_RANGE pixels in the lerp's
  // target space. Range matched to roughly the upstream's typical mouse
  // travel so the visible effect on the lines is comparable.
  const STICK_DEADZONE = 0.15;
  const STICK_RANGE = 500;
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

  globalThis.__linesColorsGlErrorBefore = gl.getError();
  renderer.resetState();
  renderer.render(scene, camera);
  globalThis.__linesColorsGlErrorAfter = gl.getError();

  function animate() {
    globalThis.__linesColorsAnimateCalled = true;
    globalThis.__linesColorsFrameCount = (globalThis.__linesColorsFrameCount | 0) + 1;

    pollGamepad();

    camera.position.x += (mouseX - camera.position.x) * 0.05;
    camera.position.y += (-mouseY + 200 - camera.position.y) * 0.05;
    camera.lookAt(scene.position);

    const time = Date.now() * 0.0005;
    for (let i = 0; i < scene.children.length; i++) {
      const object = scene.children[i];
      if (object.isLine) {
        object.rotation.y = time * (i % 2 ? 1 : -1);
      }
    }

    renderer.resetState();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__linesColorsError) {
    globalThis.__linesColorsError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
