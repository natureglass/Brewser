// Three.js r162 webgl_buffergeometry_indexed example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_buffergeometry_indexed.html
//
// Pre-authorized deviations (per the milestone-protocol cross-milestone gotchas):
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__` (no importmap).
//   2. Fullscreen-responsive: canvas dimensions read at script-load time
//      so the demo auto-scales when the shell reruns it at 1280×720.
//      `window.innerWidth/Height`, `setPixelRatio`, resize listener dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each `renderer.render()`.
//   6. `renderer.setSize(W, H, false)` — skip Three.js's canvas.style write.
//   7. Stats addon dropped (DOM gap).
//   8. lil-gui `material.wireframe` toggle dropped (DOM gap; the toggle
//      is a single bool with no obvious gamepad mapping — drop entirely
//      rather than add a clutter binding).
//
// Bridge surface this milestone forced:
//   - HemisphereLight uniform recognition + irradiance composition in
//     both `bridge_color_program` and `bridge_texture_program`. See
//     [[bridge-lighting-support]] + [[nxjs-webgl-shader-names]] (added
//     2026-05-21 for milestone #21).

globalThis.__bgiError = null;
globalThis.__bgiFrameCount = 0;
globalThis.__bgiFps = 0;
globalThis.__bgiVertexCount = 0;
globalThis.__bgiIndexCount = 0;
globalThis.__bgiHemiUniformsFound = 0;
globalThis.__bgiGlErrorBefore = 0;
globalThis.__bgiGlErrorAfter = 0;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) throw new Error('THREE not loaded - is libs/three.iife.js missing?');

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const bgiCanvasEl = document.getElementById('bgi-canvas');
  if (!bgiCanvasEl) throw new Error('#bgi-canvas missing in HTML');
  const WIDTH = bgiCanvasEl.width || 640;
  const HEIGHT = bgiCanvasEl.height || 360;

  const canvas = bgiCanvasEl;
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

  let camera, scene, renderer;
  let mesh;

  init();
  animate();

  function init() {
    //

    camera = new THREE.PerspectiveCamera(27, WIDTH / HEIGHT, 1, 3500);
    camera.position.z = 64;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050505);

    //

    const light = new THREE.HemisphereLight();
    light.intensity = 3;
    scene.add(light);

    //

    const geometry = new THREE.BufferGeometry();

    const indices = [];

    const vertices = [];
    const normals = [];
    const colors = [];

    const size = 20;
    const segments = 10;

    const halfSize = size / 2;
    const segmentSize = size / segments;

    const _color = new THREE.Color();

    // generate vertices, normals and color data for a simple grid geometry

    for (let i = 0; i <= segments; i++) {
      const y = (i * segmentSize) - halfSize;

      for (let j = 0; j <= segments; j++) {
        const x = (j * segmentSize) - halfSize;

        vertices.push(x, -y, 0);
        normals.push(0, 0, 1);

        const r = (x / size) + 0.5;
        const g = (y / size) + 0.5;

        _color.setRGB(r, g, 1, THREE.SRGBColorSpace);

        colors.push(_color.r, _color.g, _color.b);
      }
    }

    // generate indices (data for element array buffer)

    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const a = i * (segments + 1) + (j + 1);
        const b = i * (segments + 1) + j;
        const c = (i + 1) * (segments + 1) + j;
        const d = (i + 1) * (segments + 1) + (j + 1);

        // generate two faces (triangles) per iteration

        indices.push(a, b, d); // face one
        indices.push(b, c, d); // face two
      }
    }

    //

    geometry.setIndex(indices);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    globalThis.__bgiVertexCount = geometry.attributes.position.count;
    globalThis.__bgiIndexCount = geometry.index.count;

    const material = new THREE.MeshPhongMaterial({
      side: THREE.DoubleSide,
      vertexColors: true,
    });

    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    //

    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
    renderer.setSize(WIDTH, HEIGHT, false);

    // Status: verify the bridge sees Three.js's three hemisphere-light
    // uniforms after the first render. Run AFTER one render() so the
    // program has been linked and uniforms populated; nx.js's
    // getUniformLocation returns null for names the program never
    // bound. See [[nxjs-active-uniforms-attribs-lists]].
    globalThis.__bgiGlErrorBefore = gl.getError();
    renderer.resetState();
    renderer.render(scene, camera);
    globalThis.__bgiGlErrorAfter = gl.getError();
    try {
      const programInfo = renderer.info && renderer.info.programs && renderer.info.programs[0];
      const program = programInfo && programInfo.program;
      if (program) {
        let found = 0;
        for (const n of [
          'hemisphereLights[0].direction',
          'hemisphereLights[0].skyColor',
          'hemisphereLights[0].groundColor',
        ]) {
          if (gl.getUniformLocation(program, n) !== null) found++;
        }
        globalThis.__bgiHemiUniformsFound = found;
      }
    } catch (e) {
      globalThis.__bgiHemiUniformsFound = 'introspect threw: ' + (e && e.message);
    }
  }

  //

  function animate() {
    requestAnimationFrame(animate);

    render();

    globalThis.__bgiFrameCount = (globalThis.__bgiFrameCount | 0) + 1;
    if (!animate._fpsStart) animate._fpsStart = Date.now();
    if (!animate._fpsFrames) animate._fpsFrames = 0;
    animate._fpsFrames++;
    const elapsed = Date.now() - animate._fpsStart;
    if (elapsed >= 3000) {
      globalThis.__bgiFps = Math.round(animate._fpsFrames * 1000 / elapsed);
      animate._fpsStart = Date.now();
      animate._fpsFrames = 0;
    }
  }

  function render() {
    const time = Date.now() * 0.001;

    mesh.rotation.x = time * 0.25;
    mesh.rotation.y = time * 0.5;

    renderer.resetState();
    renderer.render(scene, camera);
  }
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__bgiError) {
    globalThis.__bgiError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
