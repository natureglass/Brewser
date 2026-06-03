// Three.js r162 webgl_custom_attributes example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_custom_attributes.html
//
// Pre-authorized deviations (per the milestone-protocol cross-milestone gotchas):
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__` (no importmap).
//   2. Fullscreen-responsive: canvas dimensions read at script-load time.
//      `window.innerWidth/Height`, `setPixelRatio`, resize listener dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each render call.
//   6. `renderer.setSize(W, H, false)`.
//   7. Stats addon dropped.
//   8. TextureLoader -> Image + OffscreenCanvas + DataTexture pipeline,
//      since nx.js's `texImage2D` only accepts buffer sources. Image src
//      points at the SDMC path (brewser:// scheme rejected by Image —
//      [[nxjs-image-bypasses-global-fetch]]). Re-using the same water.jpg
//      from milestone #9 (webgl-geometry-dynamic) — no separate asset shipped.
//   9. `#pragma raw_passthrough` prepended to both shader source strings
//      so Three.js's ShaderMaterial passes through the bridge's
//      passthrough path ([[bridge-raw-shader-passthrough]]) — needed
//      because custom attributes / uniforms aren't in nx.js's
//      [[nxjs-webgl-shader-names]] allowlist.
//
// Bridge surface this milestone forced:
//   - Lazy-promote of CPU-data textures to persistent GLES handles inside
//     `try_draw_passthrough`. Without it, the bound DataTexture stays
//     `gles_handle = 0` -> bindTexture skips the native forward ->
//     passthrough draw samples nothing -> sphere renders black.

globalThis.__caError = null;
globalThis.__caFrameCount = 0;
globalThis.__caFps = 0;
globalThis.__caVertexCount = 0;
globalThis.__caTextureLoaded = false;
globalThis.__caDisplacementLoc = null;
globalThis.__caAmplitudeLocOk = false;
globalThis.__caColorTextureLocOk = false;
globalThis.__caGlErrorBefore = 0;
globalThis.__caGlErrorAfter = 0;

(async () => {
try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) throw new Error('THREE not loaded - is libs/three.iife.js missing?');

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const caCanvasEl = document.getElementById('custom-attrs-canvas');
  if (!caCanvasEl) throw new Error('#custom-attrs-canvas missing in HTML');
  const WIDTH = caCanvasEl.width || 640;
  const HEIGHT = caCanvasEl.height || 360;

  const canvas = caCanvasEl;
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
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

  // Load water.jpg as a DataTexture (re-using milestone #9's asset).
  async function loadColorTexture() {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(new Error('image load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
      img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-geometry-dynamic/assets/water.jpg';
    });
    const tw = img.width;
    const th = img.height;
    const off = new OffscreenCanvas(tw, th);
    const oc = off.getContext('2d');
    oc.drawImage(img, 0, 0);
    const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
    const tex = new THREE.DataTexture(pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  let renderer, scene, camera;
  let sphere, uniforms;
  let displacement, noise;

  await init();
  animate();

  async function init() {
    camera = new THREE.PerspectiveCamera(30, WIDTH / HEIGHT, 1, 10000);
    camera.position.z = 300;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050505);

    const colorTexture = await loadColorTexture();
    globalThis.__caTextureLoaded = true;

    uniforms = {
      'amplitude': { value: 1.0 },
      'color': { value: new THREE.Color(0xff2200) },
      'colorTexture': { value: colorTexture },
    };

    // Upstream's vertexshader / fragmentshader from the inline
    // <script type="x-shader/...> blocks, copied verbatim except for the
    // `#pragma raw_passthrough` injection on the first line. Three.js's
    // WebGLProgram wraps with its own preamble (precision, position/
    // normal/uv attribute decls, projectionMatrix/modelViewMatrix
    // uniforms) but doesn't strip pragmas. `strstr` in
    // nx_webgl_compile_shader picks it up and marks the program as
    // passthrough at link time. See [[bridge-raw-shader-passthrough]].
    const vertexShader = `#pragma raw_passthrough

      uniform float amplitude;

      attribute float displacement;

      varying vec3 vNormal;
      varying vec2 vUv;

      void main() {

        vNormal = normal;
        vUv = ( 0.5 + amplitude ) * uv + vec2( amplitude );

        vec3 newPosition = position + amplitude * normal * vec3( displacement );
        gl_Position = projectionMatrix * modelViewMatrix * vec4( newPosition, 1.0 );

      }`;

    const fragmentShader = `#pragma raw_passthrough

      varying vec3 vNormal;
      varying vec2 vUv;

      uniform vec3 color;
      uniform sampler2D colorTexture;

      void main() {

        vec3 light = vec3( 0.5, 0.2, 1.0 );
        light = normalize( light );

        float dProd = dot( vNormal, light ) * 0.5 + 0.5;

        vec4 tcolor = texture2D( colorTexture, vUv );
        vec4 gray = vec4( vec3( tcolor.r * 0.3 + tcolor.g * 0.59 + tcolor.b * 0.11 ), 1.0 );

        gl_FragColor = gray * vec4( vec3( dProd ) * vec3( color ), 1.0 );

      }`;

    const shaderMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
    });

    const radius = 50, segments = 128, rings = 64;

    const geometry = new THREE.SphereGeometry(radius, segments, rings);

    displacement = new Float32Array(geometry.attributes.position.count);
    noise = new Float32Array(geometry.attributes.position.count);

    for (let i = 0; i < displacement.length; i++) {
      noise[i] = Math.random() * 5;
    }

    geometry.setAttribute('displacement', new THREE.BufferAttribute(displacement, 1));

    sphere = new THREE.Mesh(geometry, shaderMaterial);
    scene.add(sphere);

    globalThis.__caVertexCount = geometry.attributes.position.count;

    renderer = new THREE.WebGLRenderer({ canvas, context });
    renderer.setSize(WIDTH, HEIGHT, false);

    // One render up front so the program links + uniforms get their
    // initial uploads, then introspect to populate the status canvas.
    globalThis.__caGlErrorBefore = gl.getError();
    renderer.resetState();
    renderer.render(scene, camera);
    globalThis.__caGlErrorAfter = gl.getError();
    try {
      const programInfo = renderer.info && renderer.info.programs && renderer.info.programs[0];
      const program = programInfo && programInfo.program;
      if (program) {
        globalThis.__caDisplacementLoc = gl.getAttribLocation(program, 'displacement');
        globalThis.__caAmplitudeLocOk = gl.getUniformLocation(program, 'amplitude') !== null;
        globalThis.__caColorTextureLocOk = gl.getUniformLocation(program, 'colorTexture') !== null;
      }
    } catch (e) {
      // status canvas already shows the error
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    render();

    globalThis.__caFrameCount = (globalThis.__caFrameCount | 0) + 1;
    if (!animate._fpsStart) animate._fpsStart = Date.now();
    if (!animate._fpsFrames) animate._fpsFrames = 0;
    animate._fpsFrames++;
    const elapsed = Date.now() - animate._fpsStart;
    if (elapsed >= 3000) {
      globalThis.__caFps = Math.round(animate._fpsFrames * 1000 / elapsed);
      animate._fpsStart = Date.now();
      animate._fpsFrames = 0;
    }
  }

  function render() {
    const time = Date.now() * 0.01;

    sphere.rotation.y = sphere.rotation.z = 0.01 * time;

    uniforms['amplitude'].value = 2.5 * Math.sin(sphere.rotation.y * 0.125);
    uniforms['color'].value.offsetHSL(0.0005, 0, 0);

    for (let i = 0; i < displacement.length; i++) {
      displacement[i] = Math.sin(0.1 * i + time);

      noise[i] += 0.5 * (0.5 - Math.random());
      noise[i] = THREE.MathUtils.clamp(noise[i], -5, 5);

      displacement[i] += noise[i];
    }

    sphere.geometry.attributes.displacement.needsUpdate = true;

    renderer.resetState();
    renderer.render(scene, camera);
  }
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__caError) {
    globalThis.__caError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
})();
