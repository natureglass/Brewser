// Three.js r162 webgl_instancing_dynamic example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_instancing_dynamic.html
//
// Adapted as 1:1 to upstream as possible. Pre-authorized deviations:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Canvas size read from canvas.width/height (fullscreen-responsive).
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. `BufferGeometryLoader.load(url, ...)` replaced with direct
//      `fetch(...) + BufferGeometryLoader.parse(json)` — the loader's
//      FileLoader codepath constructs `ProgressEvent` which nx.js's
//      runtime doesn't define. URL goes through `brewser://`.
//   7. `lil-gui` slider for `mesh.count` stubbed. `mesh.count` is fixed
//      at the full `Math.pow(amount, 3)` (1000 at default amount=10).
//   8. `window.innerWidth/Height`, `setPixelRatio`, and the resize
//      listener dropped. No DOM resize on the Switch.
//   9. `antialias: true` ignored (Citron has no MSAA — same constraint
//      as siblings).
//
// Bridge requirement: this milestone introduces native instancing via
// `ANGLE_instanced_arrays`. Three.js's WebGLRenderer feature-detects the
// extension at construction; nx.js's `getExtension('ANGLE_instanced_arrays')`
// now returns a real object exposing `drawArraysInstancedANGLE`,
// `drawElementsInstancedANGLE`, and `vertexAttribDivisorANGLE` — backed
// by `eglGetProcAddress`-resolved native entry points (Mesa/Tegra both
// expose them under core GLES3 names). The bridge auto-promotes any draw
// with an attrib whose divisor > 0 to the raw-shader passthrough path,
// so Three.js's built-in `MeshNormalMaterial` auto-shader runs end-to-end
// on the GPU with instanceMatrix as a per-instance mat4 attribute.
// See [[bridge-raw-shader-passthrough]] (extended for instancing).

globalThis.__instMainStarted = true;
globalThis.__instAnimateCalled = false;
globalThis.__instError = null;
globalThis.__instModelLoaded = false;
globalThis.__instMeshAdded = false;
globalThis.__instInstanceCount = 0;
globalThis.__instFrameCount = 0;
globalThis.__instRenderCount = 0;
globalThis.__instFps = 0;
globalThis.__instExtAngle = false;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__instError = 'THREE not loaded - is libs/three.iife.js missing?';
		throw new Error('no THREE');
	}

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	// Fullscreen-responsive: read dimensions from the canvas at script
	// execution time so the demo auto-scales when the browser-shell's
	// `toggleFullscreenCanvas` reruns the script at 1280×720.
	const instCanvasEl = document.getElementById('inst-canvas');
	const SCREEN_WIDTH = (instCanvasEl && instCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (instCanvasEl && instCanvasEl.height) || 360;

	let camera, scene, renderer;
	let mesh;
	const amount = 10;
	const count = Math.pow( amount, 3 );
	const dummy = new THREE.Object3D();

	const canvas = document.getElementById('inst-canvas');
	if (!canvas) {
		globalThis.__instError = '#inst-canvas missing in HTML';
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
		globalThis.__instError = 'WebGL acquire failed';
		throw new Error('no gl');
	}

	// Quick sanity probe: does getExtension expose ANGLE_instanced_arrays?
	// (Surfaced on the status canvas so a regression here is obvious.)
	try {
		const ext = gl.getExtension('ANGLE_instanced_arrays');
		globalThis.__instExtAngle = !!ext;
	} catch (e) { globalThis.__instExtAngle = false; }

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

		camera = new THREE.PerspectiveCamera( 60, SCREEN_WIDTH / SCREEN_HEIGHT, 0.1, 100 );
		camera.position.set( amount * 0.9, amount * 0.9, amount * 0.9 );
		camera.lookAt( 0, 0, 0 );

		scene = new THREE.Scene();

		// Deviation #6: bypass BufferGeometryLoader.load() — fetch + parse
		// avoids the FileLoader's ProgressEvent codepath that nx.js can't
		// satisfy. URL through brewser:// (sdmc:/ direct fetch is 403'd by
		// the WebView's `enableLocalFetch: false`).
		(async function loadModel() {
			try {
				const resp = await fetch(
					'brewser://apps/ThreeJSDemos/webgl-instancing-dynamic/assets/suzanne_buffergeometry.json'
				);
				if (!resp.ok) throw new Error('fetch ' + resp.status);
				const json = await resp.json();
				const geometry = new THREE.BufferGeometryLoader().parse(json);

				geometry.computeVertexNormals();
				geometry.scale( 0.5, 0.5, 0.5 );

				const material = new THREE.MeshNormalMaterial();
				// check overdraw
				// let material = new THREE.MeshBasicMaterial( { color: 0xff0000, opacity: 0.1, transparent: true } );

				mesh = new THREE.InstancedMesh( geometry, material, count );
				mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage ); // will be updated every frame
				scene.add( mesh );
				globalThis.__instMeshAdded = true;
				globalThis.__instInstanceCount = count;
				globalThis.__instModelLoaded = true;

				// Deviation #7: lil-gui slider for `mesh.count` stubbed.
				// mesh.count stays at the full Math.pow(amount,3) (1000).
			} catch (err) {
				globalThis.__instError = 'model load failed: ' +
					(err && err.message ? err.message : String(err));
			}
		})();

		renderer = new THREE.WebGLRenderer( {
			canvas: canvas, context: context, antialias: true,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		} );
		// Deviation #8: no setPixelRatio. Always render at the canvas's
		// own pixel dimensions; fullscreen-responsive (script reruns).
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		// Deviation #8: no Stats, no resize listener.

	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__instAnimateCalled = true;
		globalThis.__instFrameCount = ( globalThis.__instFrameCount | 0 ) + 1;

		render();

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__instFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		if ( mesh ) {

			const time = Date.now() * 0.001;

			mesh.rotation.x = Math.sin( time / 4 );
			mesh.rotation.y = Math.sin( time / 2 );

			let i = 0;
			const offset = ( amount - 1 ) / 2;

			for ( let x = 0; x < amount; x ++ ) {

				for ( let y = 0; y < amount; y ++ ) {

					for ( let z = 0; z < amount; z ++ ) {

						dummy.position.set( offset - x, offset - y, offset - z );
						dummy.rotation.y = ( Math.sin( x / 4 + time ) + Math.sin( y / 4 + time ) + Math.sin( z / 4 + time ) );
						dummy.rotation.z = dummy.rotation.y * 2;

						dummy.updateMatrix();

						mesh.setMatrixAt( i ++, dummy.matrix );

					}

				}

			}

			mesh.instanceMatrix.needsUpdate = true;
			mesh.computeBoundingSphere();

		}

		renderer.resetState();
		renderer.render( scene, camera );
		globalThis.__instRenderCount = ( globalThis.__instRenderCount | 0 ) + 1;

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__instError ) {

		globalThis.__instError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
