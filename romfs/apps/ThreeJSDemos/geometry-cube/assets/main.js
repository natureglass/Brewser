// Three.js r162 webgl_geometry_cube example - adapted for switch-web-browser.
//
// Source: three-r162/examples/webgl_geometry_cube.html
//
// Differences from the upstream HTML:
//   - Canvas is fixed-size 640x360 inline; the resize listener is dropped.
//   - Three.js's TextureLoader is bypassed: it ultimately calls
//     `gl.texImage2D(target, level, internalformat, format, type, image)`
//     with an Image object as the data source, but nx.js's WebGL only
//     accepts buffer sources for texImage2D (see webgl.c). Instead we
//     load the image via nx.js's Image class, draw it to a temporary
//     OffscreenCanvas, then read the pixels with getImageData and wrap
//     them in a THREE.DataTexture.
//   - `texture.colorSpace = THREE.SRGBColorSpace` is preserved from the
//     upstream example for fidelity; the bridge's fixed-function
//     textured-triangle path doesn't run a gamma-correction shader so the
//     visible effect is small, but Three.js's WebGLState still flags the
//     texture as sRGB and that doesn't break anything.
//   - `WebGLRenderer` is given an explicit `context: gl` so Three.js
//     never tries to construct its own context from the canvas (the
//     canvas-runner already routed canvas.getContext('webgl') to the
//     shared screen GL context with bridge enabled).
//   - console.warn/log/error/info are silenced because nx.js routes them
//     through $.print which flips the rendering mode away from canvas
//     (see [[console-error-switches-render-mode]]).
//   - renderer.resetState() is called before every renderer.render so
//     Three.js's WebGLState cache stays in sync with the bridge's
//     independent GL state writes (see [[threejs-resetstate-per-frame]]).

globalThis.__cubeMainStarted = true;
globalThis.__cubeAnimateCalled = false;
globalThis.__cubeError = null;
globalThis.__cubeTextureLoaded = false;
globalThis.__cubeTextureW = 0;
globalThis.__cubeTextureH = 0;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    globalThis.__cubeError = 'THREE not loaded - is assets/three.iife.js missing?';
    throw new Error('no THREE');
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

  // Silence Three.js's noisy warnings so they don't flip the canvas into
  // text-rendering mode mid-frame. Permanent for the page's lifetime.
  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const canvas = document.getElementById('cube-canvas');
  if (!canvas) {
    globalThis.__cubeError = '#cube-canvas missing in HTML';
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
    globalThis.__cubeError = 'WebGL acquire failed';
    throw new Error('no gl');
  }

  // Stable Proxy so Three.js's internal `instanceof WebGLRenderingContext`
  // and `gl.canvas` reads don't trip on the shared screen context's shape.
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

  // Load the crate texture. `Image.src` calls nx.js's module-local
  // `fetch` directly (see nxjs-source/packages/runtime/src/image.ts),
  // which bypasses the `globalThis.fetch` override that switch-web-browser
  // installs to route `brewser://` URLs through `BrowserResourceLoader`.
  // So a `brewser://...` Image src throws "scheme 'browser' not supported".
  // Work around by pointing Image at the underlying `sdmc:` path the
  // resource loader would have read from anyway. Profile name is
  // hardcoded since the script body has no way to read browser-config's
  // DEFAULT_PROFILE_ROOT.
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (e) => reject(new Error('image load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
    img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/geometry-cube/assets/crate.png';
  });

  // Decode the loaded image into RGBA un-premultiplied bytes via an
  // OffscreenCanvas. nx.js's image decoder stores BGRA-premultiplied
  // internally, but getImageData returns RGBA un-premultiplied per the
  // canvas spec, which is exactly what THREE.DataTexture wants.
  const tw = img.width;
  const th = img.height;
  const off = new OffscreenCanvas(tw, th);
  const oc = off.getContext('2d');
  oc.drawImage(img, 0, 0);
  const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
  globalThis.__cubeTextureLoaded = true;
  globalThis.__cubeTextureW = tw;
  globalThis.__cubeTextureH = th;

  const texture = new THREE.DataTexture(
    pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  // The upstream example sets colorSpace = SRGBColorSpace; preserve that
  // so the texture matches what desktop Three.js would do, even if the
  // bridge's textured path is fixed-function and ignores it visually.
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // DataTexture defaults flipY to false; nx.js's bridge UV convention
  // also samples top-down (UNPACK_FLIP_Y_WEBGL is a no-op there) so the
  // checkerboard sibling demo also leaves flipY at its default. Match.
  texture.needsUpdate = true;

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

  // Match the upstream geometry-cube example: fov=70, camera.z=2.
  const camera = new THREE.PerspectiveCamera(70, WIDTH / HEIGHT, 0.1, 100);
  camera.position.z = 2;

  const scene = new THREE.Scene();

  // Deviation from the upstream example's `new BoxGeometry()`: we
  // tessellate each face into an 8x8 grid of quads (768 triangles total
  // vs the default 12). Works around the Tegra X1 rasterizer's per-tile
  // UV-interpolator coherency bug ([[threejs-cube-white-face]]) — a
  // single face-sized triangle triggers the bug and renders an entire
  // face as a uniform corner-texel color. The visible cube is exactly
  // the same 1x1x1 box. Tried fixing this at the nx.js bridge level by
  // recursively subdividing large triangles before glDrawArrays but it
  // didn't clear the bug, even at matching 64x blowup — the rasterizer
  // is apparently sensitive to which screen positions the sub-triangles
  // land at, not just their size. Three.js's grid-in-object-space
  // approach produces foreshortened sub-triangles that the bug doesn't
  // hit; bridge midpoint-in-NDC produces uniformly-sized sub-triangles
  // that still trigger it.
  const geometry = new THREE.BoxGeometry(1, 1, 1, 8, 8, 8);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Initial render so the first content-cache snapshot has a textured
  // cube rather than an empty FBO. The shell's per-frame overlay path
  // takes over on subsequent rAF ticks.
  globalThis.__cubeGlErrorBefore = gl.getError();
  renderer.resetState();
  renderer.render(scene, camera);
  globalThis.__cubeGlErrorAfter = gl.getError();

  function animate() {
    globalThis.__cubeAnimateCalled = true;
    mesh.rotation.x += 0.005;
    mesh.rotation.y += 0.01;
    renderer.resetState();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__cubeError) {
    globalThis.__cubeError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
