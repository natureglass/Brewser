// Three.js r162 webgl_morphtargets_sphere example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_morphtargets_sphere.html
//
// Pre-authorized deviations:
//   1. `THREE = globalThis.__THREE_R162_STAGED__` instead of importmap.
//   2. Fullscreen-responsive canvas; resize listener / setPixelRatio dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each render.
//   6. `renderer.setSize(W, H, false)`.
//   7. Stats addon dropped.
//   8. OrbitControls → SwitchOrbitControls (gamepad left-stick orbit).
//   9. Timer addon inlined (~20 LOC of getDelta() / update()).
//
// Per-milestone-#17 deviations (per recon brief, user-approved
// 2026-05-21):
//   A. **GLTFLoader → pre-parsed binary**. `AnimatedMorphSphere.gltf`
//      + `AnimatedMorphSphere.bin` are decomposed at build time by
//      `scripts/pack-morph-sphere.mjs` into a single `morph-sphere.bin`
//      with a fixed header (magic + counts) followed by positions /
//      normals / morph0 / morph1 / indices packed contiguously. Demo
//      reads via `fetch` + `arrayBuffer` + manual `BufferAttribute`
//      setup. Animation track on weights (217 keyframes) was ignored
//      by upstream code (which drives `morphTargetInfluences[1]`
//      manually) — also skipped from the pack.
//   B. **MeshStandardMaterial → MeshPhongMaterial({ color: 0xcccccc })**.
//      The GLTF's pbrMetallicRoughness material would compile to a
//      heavy PBR shader chain (envmap, irradiance, BRDF) — substantial
//      compilation risk on Tegra GLES through raw_passthrough. Visual
//      end-result of two PointLights illuminating a morphing sphere
//      is preserved via Phong.
//   C. **TextureLoader → Image + OffscreenCanvas + DataTexture**
//      pipeline for `disc.png` (the Points sprite); `Image.src`
//      points at the SDMC path per [[nxjs-image-bypasses-global-fetch]].
//
// Bridge surface this milestone forced:
//   - `#define USE_MORPHTARGETS` added to `nx_webgl_compile_shader`'s
//     auto-promote source-scan in `nxjs-source/source/webgl.c`,
//     alongside the existing USE_SHADOWMAP / DEPTH_PACKING markers
//     and the `#pragma raw_passthrough` explicit opt-in. Three.js
//     emits `#define USE_MORPHTARGETS` into the vertex shader prefix
//     when the geometry has `morphAttributes.position`. Without
//     auto-promote the bridge's hardcoded color/texture programs
//     silently no-op the morph compose → sphere wouldn't deform.

globalThis.__morphError = null;
globalThis.__morphFrameCount = 0;
globalThis.__morphFps = 0;
globalThis.__morphAssetLoaded = false;
globalThis.__morphVertexCount = 0;
globalThis.__morphTargetCount = 0;
globalThis.__morphInfluence1 = 0;
globalThis.__morphPointTexLoaded = false;
globalThis.__morphGlErrorBefore = 0;
globalThis.__morphGlErrorAfter = 0;

(async () => {
try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) throw new Error('THREE not loaded - is libs/three.iife.js missing?');
  if (!globalThis.SwitchOrbitControls) throw new Error('SwitchOrbitControls not loaded');

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const morphCanvasEl = document.getElementById('morph-canvas');
  if (!morphCanvasEl) throw new Error('#morph-canvas missing in HTML');
  const WIDTH = morphCanvasEl.width || 640;
  const HEIGHT = morphCanvasEl.height || 360;

  const canvas = morphCanvasEl;
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

  // Inlined Timer (three/addons/misc/Timer.js).
  class Timer {
    constructor() {
      this._previousTime = 0;
      this._currentTime = 0;
      this._startTime = Date.now();
      this._delta = 0;
      this._elapsed = 0;
    }
    getDelta() { return this._delta / 1000; }
    update(timestamp) {
      this._previousTime = this._currentTime;
      this._currentTime = (timestamp !== undefined ? timestamp : Date.now()) - this._startTime;
      this._delta = this._currentTime - this._previousTime;
      this._elapsed += this._delta;
      return this;
    }
  }

  // Decode the packed binary asset (see scripts/pack-morph-sphere.mjs).
  async function loadMorphSphere() {
    const url = 'brewser://apps/ThreeJSDemos/webgl-morphtargets-sphere/assets/morph-sphere.bin';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('morph-sphere.bin fetch ' + resp.status);
    const buf = await resp.arrayBuffer();
    const view = new DataView(buf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1),
                                      view.getUint8(2), view.getUint8(3));
    if (magic !== 'MRPH') throw new Error('bad magic: ' + magic);
    const version = view.getUint32(4, true);
    if (version !== 1) throw new Error('unsupported version ' + version);
    const vertexCount = view.getUint32(8, true);
    const indexCount = view.getUint32(12, true);
    const morphTargetCount = view.getUint32(16, true);
    const HEADER = 32;
    const vec3Bytes = vertexCount * 3 * 4;
    let cursor = HEADER;
    const position = new Float32Array(buf, cursor, vertexCount * 3); cursor += vec3Bytes;
    const normal = new Float32Array(buf, cursor, vertexCount * 3); cursor += vec3Bytes;
    const morph0Pos = new Float32Array(buf, cursor, vertexCount * 3); cursor += vec3Bytes;
    const morph0Norm = new Float32Array(buf, cursor, vertexCount * 3); cursor += vec3Bytes;
    const morph1Pos = new Float32Array(buf, cursor, vertexCount * 3); cursor += vec3Bytes;
    const morph1Norm = new Float32Array(buf, cursor, vertexCount * 3); cursor += vec3Bytes;
    const indices = new Uint16Array(buf, cursor, indexCount);
    return {
      vertexCount, indexCount, morphTargetCount,
      position, normal, indices,
      morphTargets: [
        { position: morph0Pos, normal: morph0Norm, name: 'Ship' },
        { position: morph1Pos, normal: morph1Norm, name: 'Blob' },
      ],
    };
  }

  // Load disc.png as a DataTexture (the Points sprite).
  async function loadDiscTexture() {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(new Error('disc.png load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
      img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-morphtargets-sphere/assets/disc.png';
    });
    const tw = img.width;
    const th = img.height;
    const off = new OffscreenCanvas(tw, th);
    const oc = off.getContext('2d');
    oc.drawImage(img, 0, 0);
    const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
    const tex = new THREE.DataTexture(pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  let camera, scene, renderer, controls, timer;
  let mesh;
  let sign = 1;
  const speed = 0.5;

  await init();
  animate();

  async function init() {
    camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.2, 100);
    camera.position.set(0, 5, 5);

    scene = new THREE.Scene();
    timer = new Timer();

    const light1 = new THREE.PointLight(0xff2200, 50000);
    light1.position.set(100, 100, 100);
    scene.add(light1);

    const light2 = new THREE.PointLight(0x22ff00, 10000);
    light2.position.set(-100, -100, -100);
    scene.add(light2);

    scene.add(new THREE.AmbientLight(0x111111));

    const data = await loadMorphSphere();
    globalThis.__morphAssetLoaded = true;
    globalThis.__morphVertexCount = data.vertexCount;
    globalThis.__morphTargetCount = data.morphTargetCount;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    // Morph attributes — Three.js's WebGLMorphtargets reads geometry.morphAttributes.position
    // and exposes the active subset via morphTarget0..7 (WebGL 1 path).
    geometry.morphAttributes.position = data.morphTargets.map(
      (t) => new THREE.BufferAttribute(t.position, 3));
    geometry.morphAttributes.normal = data.morphTargets.map(
      (t) => new THREE.BufferAttribute(t.normal, 3));
    // GLTF morph targets are stored as deltas (per GLTF 2.0 spec) and
    // Three.js's GLTFLoader sets this flag to true — meaning the morph
    // attribute values are added to the base attribute via
    // `position += sum(influence_i * morphTarget_i)` rather than the
    // false case where each morph target is an absolute shape and the
    // base is blended via `morphTargetBaseInfluence`. Must match what
    // the pre-parse extracted from the .bin (raw GLTF deltas).
    geometry.morphTargetsRelative = true;

    // Material substitution (deviation B) — MeshPhongMaterial instead
    // of MeshStandardMaterial. The morphTargets flag tells Three.js to
    // emit `#define USE_MORPHTARGETS` even for materials that don't
    // auto-detect; with morphAttributes.position set on the geometry,
    // r162 auto-detects so this flag is redundant but harmless.
    const material = new THREE.MeshPhongMaterial({
      color: 0xcccccc,
      flatShading: false,
      morphTargets: true,
      morphNormals: true,
    });

    mesh = new THREE.Mesh(geometry, material);
    // Apply the upstream GLTF node transform: scale 100×, then
    // rotation.z = π/2 (the demo OVERWRITES the GLTF's quaternion via
    // mesh.rotation.z setter, which discards X/Y rotation entirely).
    mesh.scale.set(100, 100, 100);
    mesh.rotation.z = Math.PI / 2;
    mesh.updateMorphTargets();  // populates morphTargetInfluences = [0, 0]
    scene.add(mesh);

    // Co-located Points rendition. Shares the geometry — so its
    // bound morph attributes are the same buffers, and propagating
    // morphTargetInfluences keeps the two renditions in sync.
    const discTex = await loadDiscTexture();
    globalThis.__morphPointTexLoaded = true;
    const pointsMaterial = new THREE.PointsMaterial({
      size: 10,
      sizeAttenuation: false,
      map: discTex,
      alphaTest: 0.5,
    });
    const points = new THREE.Points(geometry, pointsMaterial);
    points.morphTargetInfluences = mesh.morphTargetInfluences;
    points.morphTargetDictionary = mesh.morphTargetDictionary;
    mesh.add(points);

    renderer = new THREE.WebGLRenderer({ canvas, context });
    renderer.setSize(WIDTH, HEIGHT, false);

    controls = new globalThis.SwitchOrbitControls(THREE, camera);
    controls.minDistance = 1;
    controls.maxDistance = 20;
    controls.enableDamping = true;

    // One render up-front so the program links + uniforms populate.
    globalThis.__morphGlErrorBefore = gl.getError();
    renderer.resetState();
    renderer.render(scene, camera);
    globalThis.__morphGlErrorAfter = gl.getError();
  }

  function animate() {
    requestAnimationFrame(animate);
    timer.update();
    render();

    globalThis.__morphFrameCount = (globalThis.__morphFrameCount | 0) + 1;
    if (!animate._fpsStart) animate._fpsStart = Date.now();
    if (!animate._fpsFrames) animate._fpsFrames = 0;
    animate._fpsFrames++;
    const elapsed = Date.now() - animate._fpsStart;
    if (elapsed >= 3000) {
      globalThis.__morphFps = Math.round(animate._fpsFrames * 1000 / elapsed);
      animate._fpsStart = Date.now();
      animate._fpsFrames = 0;
    }
  }

  function render() {
    const delta = timer.getDelta();

    if (mesh !== undefined) {
      const step = delta * speed;
      mesh.rotation.y += step;
      mesh.morphTargetInfluences[1] = mesh.morphTargetInfluences[1] + step * sign;
      if (mesh.morphTargetInfluences[1] <= 0 || mesh.morphTargetInfluences[1] >= 1) {
        sign *= -1;
      }
      globalThis.__morphInfluence1 = mesh.morphTargetInfluences[1];
    }

    if (controls && typeof controls.update === 'function') controls.update();

    renderer.resetState();
    renderer.render(scene, camera);
  }
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__morphError) {
    globalThis.__morphError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
})();
