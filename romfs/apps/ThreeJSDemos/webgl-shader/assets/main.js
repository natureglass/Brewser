// Three.js r162 webgl_shader example (Monjori) - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_shader.html
//
// Pre-authorized deviations (per the milestone-protocol cross-milestone gotchas):
//   1. `THREE = globalThis.__THREE_R162_STAGED__` instead of importmap.
//   2. Fullscreen-responsive canvas; resize listener / setPixelRatio dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each render.
//   6. `renderer.setSize(W, H, false)`.
//   7. `#pragma raw_passthrough` prepended to both shader source strings
//      so the bridge routes through the raw-shader passthrough path
//      ([[bridge-raw-shader-passthrough]]) — needed because the custom
//      `time` uniform name isn't in [[nxjs-webgl-shader-names]] allowlist,
//      and the bridge's hardcoded color/texture programs can't run the
//      Monjori procedural fragment shader anyway.
//
// No new bridge surface forced — entirely rides infrastructure from
// milestones #14/#20/#22.

globalThis.__shaderError = null;
globalThis.__shaderFrameCount = 0;
globalThis.__shaderFps = 0;
globalThis.__shaderTimeLocOk = false;
globalThis.__shaderTimeValue = 0;
globalThis.__shaderGlErrorBefore = 0;
globalThis.__shaderGlErrorAfter = 0;

try {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) throw new Error('THREE not loaded - is libs/three.iife.js missing?');

  console.warn = () => {};
  console.log = () => {};
  console.error = () => {};
  console.info = () => {};

  const shaderCanvasEl = document.getElementById('shader-canvas');
  if (!shaderCanvasEl) throw new Error('#shader-canvas missing in HTML');
  const WIDTH = shaderCanvasEl.width || 640;
  const HEIGHT = shaderCanvasEl.height || 360;

  const canvas = shaderCanvasEl;
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

  // Upstream's vertexShader / fragmentShader from the inline
  // <script type="x-shader/...> blocks, copied verbatim except for the
  // `#pragma raw_passthrough` injection on the first line. Three.js's
  // WebGLProgram wraps with its own preamble (precision, position/uv
  // attribute decls, projectionMatrix/modelViewMatrix uniforms) but
  // doesn't strip pragmas. `strstr` in nx_webgl_compile_shader picks
  // it up and marks the program as passthrough at link time.
  const vertexShader = `#pragma raw_passthrough

    varying vec2 vUv;

    void main() {

      vUv = uv;

      gl_Position = vec4( position, 1.0 );

    }`;

  const fragmentShader = `#pragma raw_passthrough

    varying vec2 vUv;

    uniform float time;

    void main() {

      vec2 p = - 1.0 + 2.0 * vUv;
      float a = time * 40.0;
      float d, e, f, g = 1.0 / 40.0 ,h ,i ,r ,q;

      e = 400.0 * ( p.x * 0.5 + 0.5 );
      f = 400.0 * ( p.y * 0.5 + 0.5 );
      i = 200.0 + sin( e * g + a / 150.0 ) * 20.0;
      d = 200.0 + cos( f * g / 2.0 ) * 18.0 + cos( e * g ) * 7.0;
      r = sqrt( pow( abs( i - e ), 2.0 ) + pow( abs( d - f ), 2.0 ) );
      q = f / r;
      e = ( r * cos( q ) ) - a / 2.0;
      f = ( r * sin( q ) ) - a / 2.0;
      d = sin( e * g ) * 176.0 + sin( e * g ) * 164.0 + r;
      h = ( ( f + d ) + a / 2.0 ) * g;
      i = cos( h + r * p.x / 1.3 ) * ( e + e + a ) + cos( q * g * 6.0 ) * ( r + h / 3.0 );
      h = sin( f * g ) * 144.0 - sin( e * g ) * 212.0 * p.x;
      h = ( h + ( f - e ) * q + sin( r - ( a + h ) / 7.0 ) * 10.0 + i / 4.0 ) * g;
      i += cos( h * 2.3 * sin( a / 350.0 - q ) ) * 184.0 * sin( q - ( r * 4.3 + a / 12.0 ) * g ) + tan( r * g + h ) * 184.0 * cos( r * g + h );
      i = mod( i / 5.6, 256.0 ) / 64.0;
      if ( i < 0.0 ) i += 4.0;
      if ( i >= 2.0 ) i = 4.0 - i;
      d = r / 350.0;
      d += sin( d * d * 8.0 ) * 0.52;
      f = ( sin( a * g ) + 1.0 ) / 2.0;
      gl_FragColor = vec4( vec3( f * i / 1.6, i / 2.0 + d / 13.0, i ) * d * p.x + vec3( i / 1.3 + d / 8.0, i / 2.0 + d / 18.0, i ) * d * ( 1.0 - p.x ), 1.0 );

    }`;

  let camera, scene, renderer, uniforms;

  init();
  animate();

  function init() {
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    scene = new THREE.Scene();

    const geometry = new THREE.PlaneGeometry(2, 2);

    uniforms = {
      time: { value: 1.0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    renderer = new THREE.WebGLRenderer({ canvas, context });
    renderer.setSize(WIDTH, HEIGHT, false);

    // One render up-front so the program links + uniforms populate.
    globalThis.__shaderGlErrorBefore = gl.getError();
    renderer.resetState();
    renderer.render(scene, camera);
    globalThis.__shaderGlErrorAfter = gl.getError();
    try {
      const programInfo = renderer.info && renderer.info.programs && renderer.info.programs[0];
      const program = programInfo && programInfo.program;
      if (program) {
        globalThis.__shaderTimeLocOk = gl.getUniformLocation(program, 'time') !== null;
      }
    } catch (e) {
      // status canvas already shows the demo error
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    uniforms['time'].value = performance.now() / 1000;
    globalThis.__shaderTimeValue = uniforms['time'].value;
    renderer.resetState();
    renderer.render(scene, camera);

    globalThis.__shaderFrameCount = (globalThis.__shaderFrameCount | 0) + 1;
    if (!animate._fpsStart) animate._fpsStart = Date.now();
    if (!animate._fpsFrames) animate._fpsFrames = 0;
    animate._fpsFrames++;
    const elapsed = Date.now() - animate._fpsStart;
    if (elapsed >= 3000) {
      globalThis.__shaderFps = Math.round(animate._fpsFrames * 1000 / elapsed);
      animate._fpsStart = Date.now();
      animate._fpsFrames = 0;
    }
  }
} catch (err) {
  const msg = (err && err.message) ? err.message : String(err);
  if (!globalThis.__shaderError) {
    globalThis.__shaderError = 'threw: ' + msg + (err && err.stack ? ' | stack: ' + String(err.stack).slice(0, 200) : '');
  }
}
