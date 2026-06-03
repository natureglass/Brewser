// Three.js r162 webgl_materials_wireframe example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_materials_wireframe.html
//
// Adapted as 1:1 to upstream as possible. Pre-authorized deviations:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Fixed 640x360 canvas; window/resize/setPixelRatio dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. OrbitControls replaced with gamepad-driven SwitchOrbitControls
//      (left stick = orbit). Pan and zoom disabled per upstream.
//   7. lil-gui replaced with a no-op stub. Upstream's slider controls the
//      barycentric shader's `thickness` uniform — we keep `thickness = 1`
//      (upstream default). The right-hand mesh still exercises the
//      passthrough path.
//   8. Render-on-demand: only call `renderer.render()` when the orbit
//      stick is deflected or on first frame after model load. Mirrors
//      upstream's `controls.addEventListener('change', render)`.
//   9. `BufferGeometryLoader.load(url, ...)` replaced with direct
//      `fetch(...) + BufferGeometryLoader.parse(json)` — the loader's
//      FileLoader codepath constructs `ProgressEvent` which nx.js's
//      runtime doesn't define. URL goes through `brewser://` because
//      the WebView has `enableLocalFetch: false` (direct `sdmc:/` 403s).
//  10. mesh2 gets `transparent: true` + `depthWrite: false`. Upstream
//      relies on `alphaToCoverage: true` + MSAA so the GPU's multisample
//      mask discards alpha=0 samples (preserving depth-write only where
//      coverage is non-zero). Citron has no MSAA, so the closest
//      functional equivalent is enabling alpha blending so interior
//      alpha=0 fragments don't overwrite color, and disabling depth
//      writes so mesh1 can still be visible through mesh2's empty
//      interior. Without this, the right head renders as a solid-colored
//      silhouette and always occludes mesh1.
//
// Bridge requirement: this milestone introduces the **raw-shader
// passthrough** path. Programs whose shader source contains
// `#pragma raw_passthrough` skip the bridge's hardcoded-program swap and
// run user GLSL on the GPU directly. Without it, mesh2's custom shader
// (fwidth() + gl_FrontFacing for barycentric wireframe) would be silently
// replaced by the bridge's color program. See [[nxjs-no-custom-fragment-shader]]
// (now obsolete for this case) and [[bridge-raw-shader-passthrough]].

globalThis.__wfMainStarted = true;
globalThis.__wfAnimateCalled = false;
globalThis.__wfError = null;
globalThis.__wfModelLoaded = false;
globalThis.__wfMesh1Added = false;
globalThis.__wfMesh2Added = false;
globalThis.__wfFrameCount = 0;
globalThis.__wfRenderCount = 0;
globalThis.__wfFps = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__wfError = 'THREE not loaded - is libs/three.iife.js missing?';
		throw new Error('no THREE');
	}

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	// Read dimensions from the canvas itself so the demo responds to
	// the browser-shell's fullscreen-canvas rerun: when the user taps
	// "Toggle Fullscreen", canvas-runner resizes the offscreen to the
	// screen size (1280×720) and re-executes this script. With these
	// pulled from `canvas.width` / `.height`, the renderer + camera
	// automatically scale to the new dimensions.
	const wfCanvasEl = document.getElementById('wf-canvas');
	const SCREEN_WIDTH = (wfCanvasEl && wfCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (wfCanvasEl && wfCanvasEl.height) || 360;

	const API = {
		thickness: 1
	};

	let renderer, scene, camera, controls, mesh2;
	let firstRenderPending = true;

	const canvas = document.getElementById('wf-canvas');
	if (!canvas) {
		globalThis.__wfError = '#wf-canvas missing in HTML';
		throw new Error('no canvas');
	}
	const gl = canvas.getContext('webgl', {
		alpha: false,
		antialias: true,  // upstream uses { antialias: true }
		depth: true,
		stencil: false,
		preserveDrawingBuffer: false,
	});
	if (!gl) {
		globalThis.__wfError = 'WebGL acquire failed';
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

	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	init();
	animate();

	function init() {

		renderer = new THREE.WebGLRenderer({
			canvas: canvas, context: context, antialias: true,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		});
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		scene = new THREE.Scene();

		camera = new THREE.PerspectiveCamera( 40, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 500 );
		camera.position.z = 200;

		controls = new SwitchOrbitControls( THREE, camera );
		controls.enableZoom = false;
		// Slow the orbit slightly so coarse stick input still produces
		// fine adjustments — the demo is structurally static, only the
		// camera moves.
		controls.rotateSpeed = 0.6;

		// Bypass `BufferGeometryLoader.load()` because Three.js's underlying
		// FileLoader constructs `ProgressEvent` for the onProgress callback,
		// and nx.js's runtime doesn't define ProgressEvent globally.
		// Direct `fetch` + `parse(json)` skips that codepath entirely.
		// URL goes through BrowserResourceLoader (the WebView has
		// `enableLocalFetch: false` so `sdmc:/` 403s).
		(async function loadModel() {
			try {
				const resp = await fetch(
					'brewser://apps/ThreeJSDemos/webgl-materials-wireframe/assets/WaltHeadLo_buffergeometry.json'
				);
				if (!resp.ok) throw new Error('fetch ' + resp.status);
				const json = await resp.json();
				const geometry = new THREE.BufferGeometryLoader().parse(json);

				geometry.deleteAttribute( 'normal' );
				geometry.deleteAttribute( 'uv' );

				setupAttributes( geometry );

				// left

				const material1 = new THREE.MeshBasicMaterial( {

					color: 0xe0e0ff,
					wireframe: true

				} );

				const mesh1 = new THREE.Mesh( geometry, material1 );
				mesh1.position.set( - 40, 0, 0 );

				scene.add( mesh1 );
				globalThis.__wfMesh1Added = true;

				// right

				const material2 = new THREE.ShaderMaterial( {

					uniforms: { 'thickness': { value: API.thickness } },
					vertexShader: getVertexShader(),
					fragmentShader: getFragmentShader(),
					side: THREE.DoubleSide,
					alphaToCoverage: true, // only works when WebGLRenderer's "antialias" is set to "true"
					// Deviation #10 (see file header): substitute alpha
					// blending for the missing MSAA/alphaToCoverage path.
					transparent: true,
					depthWrite: false

				} );
				material2.extensions.derivatives = true;

				mesh2 = new THREE.Mesh( geometry, material2 );
				mesh2.position.set( 40, 0, 0 );

				scene.add( mesh2 );
				globalThis.__wfMesh2Added = true;
				globalThis.__wfModelLoaded = true;

				firstRenderPending = true;
			} catch (err) {
				globalThis.__wfError = 'model load failed: ' +
					(err && err.message ? err.message : String(err));
			}
		})();

		// lil-gui stub. Upstream wires a slider that updates
		// mesh2.material.uniforms.thickness.value. We keep thickness fixed
		// at 1 (upstream default); see deviation #7.

	}

	function setupAttributes( geometry ) {

		const vectors = [
			new THREE.Vector3( 1, 0, 0 ),
			new THREE.Vector3( 0, 1, 0 ),
			new THREE.Vector3( 0, 0, 1 )
		];

		const position = geometry.attributes.position;
		const centers = new Float32Array( position.count * 3 );

		for ( let i = 0, l = position.count; i < l; i ++ ) {

			vectors[ i % 3 ].toArray( centers, i * 3 );

		}

		geometry.setAttribute( 'center', new THREE.BufferAttribute( centers, 3 ) );

	}

	// Custom shader sources. Match upstream's <script type="x-shader/*">
	// blocks verbatim, with `#pragma raw_passthrough` prepended so nxjs's
	// linkProgram marks the resulting program for native dispatch instead
	// of the bridge's hardcoded program swap. Three.js prepends its own
	// preamble (projectionMatrix/modelViewMatrix/position declarations)
	// before each of these strings, so the pragma lands mid-source but
	// GLSL accepts it anywhere outside other statements.

	function getVertexShader() {
		return [
			'#pragma raw_passthrough',
			'attribute vec3 center;',
			'varying vec3 vCenter;',
			'',
			'void main() {',
			'',
			'	vCenter = center;',
			'',
			'	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
			'',
			'}',
		].join( '\n' );
	}

	function getFragmentShader() {
		return [
			'#pragma raw_passthrough',
			'uniform float thickness;',
			'',
			'varying vec3 vCenter;',
			'',
			'void main() {',
			'',
			'	vec3 afwidth = fwidth( vCenter.xyz );',
			'',
			'	vec3 edge3 = smoothstep( ( thickness - 1.0 ) * afwidth, thickness * afwidth, vCenter.xyz );',
			'',
			'	float edge = 1.0 - min( min( edge3.x, edge3.y ), edge3.z );',
			'',
			'	gl_FragColor.rgb = gl_FrontFacing ? vec3( 0.9, 0.9, 1.0 ) : vec3( 0.4, 0.4, 0.5 );',
			'	gl_FragColor.a = edge;',
			'',
			'}',
		].join( '\n' );
	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__wfAnimateCalled = true;
		globalThis.__wfFrameCount = ( globalThis.__wfFrameCount | 0 ) + 1;

		// Detect orbit-stick deflection to drive render-on-demand. Read
		// the gamepad axes BEFORE controls.update() so we can compare with
		// post-update state via the controls' internal spherical coords.
		const beforeTheta = controls._spherical ? controls._spherical.theta : 0;
		const beforePhi = controls._spherical ? controls._spherical.phi : 0;
		controls.update();
		const afterTheta = controls._spherical ? controls._spherical.theta : 0;
		const afterPhi = controls._spherical ? controls._spherical.phi : 0;
		const stickActive = Math.abs(afterTheta - beforeTheta) > 1e-5 ||
		                    Math.abs(afterPhi - beforePhi) > 1e-5;

		if ( ( stickActive || firstRenderPending ) && globalThis.__wfModelLoaded ) {
			render();
			firstRenderPending = false;
		}

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__wfFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		renderer.resetState();
		renderer.render( scene, camera );
		globalThis.__wfRenderCount = ( globalThis.__wfRenderCount | 0 ) + 1;

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__wfError ) {

		globalThis.__wfError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
