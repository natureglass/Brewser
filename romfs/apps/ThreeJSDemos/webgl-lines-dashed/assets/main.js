// Three.js r162 webgl_lines_dashed example - adapted for switch-web-browser.
//
// Source: three-r162/examples/webgl_lines_dashed.html
//
// Differences from the upstream HTML:
//   - Canvas is fixed-size 640x360 inline; the resize listener / setPixelRatio
//     / window.innerWidth are dropped.
//   - hilbert3D is inlined here (~25 LOC) because the upstream's
//     `import { hilbert3D } from 'three/addons/utils/GeometryUtils.js'` ESM
//     pathway has no equivalent in our IIFE-only setup. Function body is
//     identical to GeometryUtils.js's hilbert3D, except it constructs
//     THREE.Vector3 via the global instead of an ESM import.
//   - Stats.js and renderer.domElement appending are dropped (the inline
//     canvas is already the target).
//   - console.warn/log/error/info are silenced because nx.js routes them
//     through $.print which flips the rendering mode away from canvas
//     (see [[console-error-switches-render-mode]]).
//   - renderer.resetState() is called before every renderer.render so
//     Three.js's WebGLState cache stays in sync with the bridge's
//     independent GL state writes (see [[threejs-resetstate-per-frame]]).
//   - Stable Proxy on the gl context, same pattern as the sibling cube
//     demos, so Three.js's instanceof / .canvas reads don't trip on the
//     shared screen GL context's shape.
//   - scene.fog is preserved from upstream. nxjs-source's bridge programs
//     were extended in the same session this demo was authored to handle
//     Three.js's linear `Fog(color, near, far)`: a_fogDepth attribute +
//     u_fogColor/u_fogNear/u_fogFar uniforms in bridge_line_program,
//     bridge_color_program, and bridge_texture_program. CPU-side dispatch
//     in webgl.c::expand_lines_to_pairs / draw_arrays_lines / etc.
//     computes view-space -mz per vertex via compute_fog_depth().

globalThis.__linesMainStarted = true;
globalThis.__linesAnimateCalled = false;
globalThis.__linesError = null;
globalThis.__linesObjectCount = 0;
globalThis.__linesFrameCount = 0;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    globalThis.__linesError = 'THREE not loaded - is assets/three.iife.js missing?';
    throw new Error('no THREE');
  }

  // Read dimensions from the canvas itself so the demo responds to
  // the browser-shell's fullscreen-canvas rerun: when the user taps
  // "Toggle Fullscreen", canvas-runner resizes the offscreen to the
  // screen size (1280×720) and re-executes this script. With these
  // pulled from `canvas.width` / `.height`, the renderer + camera
  // automatically scale to the new dimensions.
  const linesCanvasEl = document.getElementById('lines-canvas');
  const WIDTH = (linesCanvasEl && linesCanvasEl.width) || 640;
  const HEIGHT = (linesCanvasEl && linesCanvasEl.height) || 360;

  // Silence Three.js's noisy warnings so they don't flip the canvas into
  // text-rendering mode mid-frame.
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvas = document.getElementById('lines-canvas');
  if (!canvas) {
    globalThis.__linesError = '#lines-canvas missing in HTML';
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
    globalThis.__linesError = 'WebGL acquire failed';
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

  // Inlined from three-r162/examples/jsm/utils/GeometryUtils.js — pure JS,
  // no external dependencies beyond THREE.Vector3.
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

  // box() builds a 24-vertex BufferGeometry: 12 line segments (one per cube
  // edge), 2 vertices per segment. Drawn as THREE.LineSegments below.
  function box(width, height, depth) {
    width = width * 0.5;
    height = height * 0.5;
    depth = depth * 0.5;
    const geometry = new THREE.BufferGeometry();
    const position = [
      -width, -height, -depth,  -width,  height, -depth,
      -width,  height, -depth,   width,  height, -depth,
       width,  height, -depth,   width, -height, -depth,
       width, -height, -depth,  -width, -height, -depth,
      -width, -height,  depth,  -width,  height,  depth,
      -width,  height,  depth,   width,  height,  depth,
       width,  height,  depth,   width, -height,  depth,
       width, -height,  depth,  -width, -height,  depth,
      -width, -height, -depth,  -width, -height,  depth,
      -width,  height, -depth,  -width,  height,  depth,
       width,  height, -depth,   width,  height,  depth,
       width, -height, -depth,   width, -height,  depth,
    ];
    geometry.setAttribute('position',
      new THREE.Float32BufferAttribute(position, 3));
    return geometry;
  }

  const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 1, 200);
  camera.position.z = 150;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  // Linear fog matched to upstream — supported by the bridge as of the
  // companion nxjs-source patch (see file header comment).
  scene.fog = new THREE.Fog(0x111111, 150, 200);

  const subdivisions = 6;
  const recursion = 1;

  const points = hilbert3D(new THREE.Vector3(0, 0, 0), 25.0, recursion,
                            0, 1, 2, 3, 4, 5, 6, 7);
  const spline = new THREE.CatmullRomCurve3(points);
  const samples = spline.getPoints(points.length * subdivisions);
  const geometrySpline = new THREE.BufferGeometry().setFromPoints(samples);

  const line = new THREE.Line(geometrySpline,
    new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1, gapSize: 0.5 }));
  line.computeLineDistances();
  scene.add(line);

  const geometryBox = box(50, 50, 50);
  const lineSegments = new THREE.LineSegments(geometryBox,
    new THREE.LineDashedMaterial({ color: 0xffaa00, dashSize: 3, gapSize: 1 }));
  lineSegments.computeLineDistances();
  scene.add(lineSegments);

  const objects = [line, lineSegments];
  globalThis.__linesObjectCount = objects.length;

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
  renderer.setClearColor(0x111111, 1);

  // Initial render so the first content-cache snapshot has lines in it
  // rather than an empty FBO. The shell's per-frame overlay takes over
  // on subsequent rAF ticks.
  globalThis.__linesGlErrorBefore = gl.getError();
  renderer.resetState();
  renderer.render(scene, camera);
  globalThis.__linesGlErrorAfter = gl.getError();

  function animate() {
    globalThis.__linesAnimateCalled = true;
    globalThis.__linesFrameCount = (globalThis.__linesFrameCount | 0) + 1;
    const time = Date.now() * 0.001;
    for (const o of objects) {
      o.rotation.x = 0.25 * time;
      o.rotation.y = 0.25 * time;
    }
    renderer.resetState();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__linesError) {
    globalThis.__linesError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
