// Three.js r162 webgl_loader_obj example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_loader_obj.html
//
// Adapted as 1:1 to upstream as possible. Pre-authorized deviations:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Fullscreen-responsive: canvas dimensions read at script load time
//      so the demo auto-scales when the shell reruns it at 1280×720.
//      `window.innerWidth/Height`, `setPixelRatio`, and the resize
//      listener dropped per the unified template.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. OrbitControls replaced with gamepad-driven SwitchOrbitControls
//      (left stick = orbit). Pan and zoom disabled per upstream's
//      `minDistance=2, maxDistance=5` constraints.
//   7. OBJLoader bundled as IIFE at libs/obj-loader.js (no importmap on
//      our pages). Exposed as `globalThis.SwitchOBJLoader`. Its
//      `load(url, ...)` is rewritten to `fetch + parse(text)` to skip
//      Three.js's FileLoader (which constructs `ProgressEvent` —
//      undefined on nx.js).
//   8. TextureLoader → Image + OffscreenCanvas + DataTexture (the
//      standard per-demo deviation). Image URL goes through `sdmc:/`
//      because nx.js's Image bypasses the global fetch and rejects
//      `brewser://` ([[nxjs-image-bypasses-global-fetch]]).
//   9. Render-on-demand: only call `renderer.render()` when the orbit
//      stick is deflected, on first frame after model+texture both load,
//      or on initial texture-only load. Mirrors upstream's
//      `controls.addEventListener('change', render)`.
//  10. Upstream applies a single uv_grid_opengl.jpg as a UV-debug texture
//      across every submesh (overriding the OBJ's MTL). This port instead
//      loads the OBJ's actual MTL (male02.mtl) and applies each submesh's
//      real source JPEG (01_-_Default..., male-02-1noCulling,
//      orig_02_-_Defaul...) by matching `child.material.name` against the
//      MTL's `newmtl` entries. MTLLoader is not used — its TextureLoader
//      dep needs the same Image+OffscreenCanvas+DataTexture rewiring
//      anyway, and a minimal inline MTL parser is shorter than porting
//      the loader.
//
// Bridge requirement: this milestone introduces the **derivative-normals
// fallback** for lit materials whose `normal` attribute was dead-coded by
// Three.js's `flatShading: true` optimizer. The OBJ has `s off` smoothing
// groups on several submeshes, which OBJLoader translates to
// `material.flatShading = true` on the auto-generated
// `MeshPhongMaterial`. The bridge fragment shader now computes
// per-fragment normals via `dFdx`/`dFdy` of `v_viewPosition` (requires
// `GL_OES_standard_derivatives`, which Tegra X1 supports via ES3 core)
// whenever lighting uniforms are bound but no `a_normal` was provided.
// See [[bridge-flatshading-gap]] (the gap this milestone closes) and
// [[bridge-lighting-support]] (the parent shader compose).

globalThis.__objMainStarted = true;
globalThis.__objAnimateCalled = false;
globalThis.__objError = null;
globalThis.__objTextureLoaded = false;
globalThis.__objTexturesTotal = 0;
globalThis.__objTexturesLoaded = 0;
globalThis.__objMtlLoaded = false;
globalThis.__objModelLoaded = false;
globalThis.__objMeshCount = 0;
globalThis.__objFlatShadingCount = 0;
globalThis.__objMappedCount = 0;
globalThis.__objFrameCount = 0;
globalThis.__objRenderCount = 0;
globalThis.__objFps = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__objError = 'THREE not loaded - is libs/three.iife.js missing?';
		throw new Error('no THREE');
	}
	if (!globalThis.SwitchOBJLoader) {
		globalThis.__objError = 'SwitchOBJLoader not loaded - is libs/obj-loader.js missing?';
		throw new Error('no OBJLoader');
	}

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	// Fullscreen-responsive: read dimensions from the canvas. When the
	// browser-shell reruns this script at 1280×720, the renderer +
	// camera auto-scale.
	const objCanvasEl = document.getElementById('obj-canvas');
	const SCREEN_WIDTH = (objCanvasEl && objCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (objCanvasEl && objCanvasEl.height) || 360;

	let camera, scene, renderer, controls;
	let object;
	let mtlMap = {};                  // matName → { mapKd: 'filename.JPG' }
	const textureByFile = {};         // 'filename.JPG' → THREE.DataTexture
	let firstRenderPending = true;

	const ASSET_PREFIX_SDMC =
		'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-loader-obj/assets/';
	const ASSET_PREFIX_BROWSER =
		'brewser://apps/ThreeJSDemos/webgl-loader-obj/assets/';

	// Parse the bits of a Wavefront .mtl file we actually use: `newmtl
	// <name>` starts a new entry; `map_Kd <filename>` (diffuse map) is the
	// only attribute we care about. Returns { matName: { mapKd } }.
	function parseMtl( text ) {
		const out = {};
		let current = null;
		text.split( '\n' ).forEach( ( raw ) => {
			const line = raw.trim();
			if ( line.startsWith( 'newmtl ' ) ) {
				current = line.slice( 7 ).trim();
				out[ current ] = {};
			} else if ( current && line.startsWith( 'map_Kd ' ) ) {
				out[ current ].mapKd = line.slice( 7 ).trim();
			}
		} );
		return out;
	}

	const canvas = document.getElementById('obj-canvas');
	if (!canvas) {
		globalThis.__objError = '#obj-canvas missing in HTML';
		throw new Error('no canvas');
	}
	const gl = canvas.getContext('webgl', {
		alpha: false,
		antialias: true,
		depth: true,
		stencil: false,
		preserveDrawingBuffer: false,
	});
	if (!gl) {
		globalThis.__objError = 'WebGL acquire failed';
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

		camera = new THREE.PerspectiveCamera( 45, SCREEN_WIDTH / SCREEN_HEIGHT, 0.1, 20 );
		camera.position.z = 2.5;

		// scene

		scene = new THREE.Scene();

		const ambientLight = new THREE.AmbientLight( 0xffffff );
		scene.add( ambientLight );

		const pointLight = new THREE.PointLight( 0xffffff, 15 );
		camera.add( pointLight );
		scene.add( camera );

		// manager

		function loadModel() {

			object.traverse( function ( child ) {

				if ( child.isMesh ) {
					const matName = child.material && child.material.name;
					const mtlEntry = matName ? mtlMap[ matName ] : null;
					const mapKd = mtlEntry && mtlEntry.mapKd;
					if ( mapKd && textureByFile[ mapKd ] ) {
						child.material.map = textureByFile[ mapKd ];
						globalThis.__objMappedCount =
							( globalThis.__objMappedCount | 0 ) + 1;
					}
					globalThis.__objMeshCount =
						( globalThis.__objMeshCount | 0 ) + 1;
					if ( child.material.flatShading ) {
						globalThis.__objFlatShadingCount =
							( globalThis.__objFlatShadingCount | 0 ) + 1;
					}
				}

			} );

			object.position.y = - 0.95;
			object.scale.setScalar( 0.01 );
			scene.add( object );

			firstRenderPending = true;
			render();

		}

		const manager = new THREE.LoadingManager( loadModel );

		// MTL + per-material textures
		//
		// Replaces upstream's single uv_grid_opengl.jpg + `child.material.map
		// = texture` blanket override with: parse male02.mtl, load each
		// unique `map_Kd` JPEG via Image+OffscreenCanvas+DataTexture, then
		// in loadModel match `child.material.name` (set by OBJLoader from
		// the source `usemtl` name) against the MTL's `newmtl` entries.
		// MTLLoader skipped — see file-header deviation #10.
		//
		// All loads are registered with the LoadingManager so `loadModel`
		// fires only after MTL + OBJ + every unique texture is done.

		manager.itemStart( 'mtl://male02.mtl' );
		fetch( ASSET_PREFIX_BROWSER + 'male02.mtl' ).then( ( resp ) => {
			if ( ! resp.ok ) throw new Error( 'mtl fetch ' + resp.status );
			return resp.text();
		} ).then( ( text ) => {
			try {
				mtlMap = parseMtl( text );
				const uniqueFiles = new Set();
				Object.values( mtlMap ).forEach( ( m ) => {
					if ( m.mapKd ) uniqueFiles.add( m.mapKd );
				} );
				globalThis.__objMtlLoaded = true;
				globalThis.__objTexturesTotal = uniqueFiles.size;
				// Register the texture items BEFORE itemEnd'ing the MTL,
				// so the manager's total grows before the MTL completion
				// would otherwise satisfy it.
				uniqueFiles.forEach( ( file ) => {
					manager.itemStart( 'tex://' + file );
					const img = new Image();
					img.onload = () => {
						try {
							const off = new OffscreenCanvas( img.width, img.height );
							const ctx2d = off.getContext( '2d' );
							ctx2d.drawImage( img, 0, 0 );
							const imgData = ctx2d.getImageData(
								0, 0, img.width, img.height );
							const tex = new THREE.DataTexture(
								new Uint8Array( imgData.data.buffer ),
								img.width, img.height,
								THREE.RGBAFormat, THREE.UnsignedByteType
							);
							tex.colorSpace = THREE.SRGBColorSpace;
							tex.needsUpdate = true;
							tex.wrapS = THREE.RepeatWrapping;
							tex.wrapT = THREE.RepeatWrapping;
							textureByFile[ file ] = tex;
							globalThis.__objTexturesLoaded =
								( globalThis.__objTexturesLoaded | 0 ) + 1;
							if ( globalThis.__objTexturesLoaded >=
								globalThis.__objTexturesTotal ) {
								globalThis.__objTextureLoaded = true;
							}
							if ( ! globalThis.__objModelLoaded )
								firstRenderPending = true;
							manager.itemEnd( 'tex://' + file );
						} catch ( err ) {
							globalThis.__objError = 'tex decode (' + file + '): ' +
								( err && err.message ? err.message : String( err ) );
							manager.itemError( 'tex://' + file );
						}
					};
					img.onerror = () => {
						globalThis.__objError = 'tex load error: ' + file;
						manager.itemError( 'tex://' + file );
					};
					img.src = ASSET_PREFIX_SDMC + file;
				} );
				manager.itemEnd( 'mtl://male02.mtl' );
			} catch ( err ) {
				globalThis.__objError = 'mtl parse: ' +
					( err && err.message ? err.message : String( err ) );
				manager.itemError( 'mtl://male02.mtl' );
			}
		} ).catch( ( err ) => {
			globalThis.__objError = 'mtl fetch: ' +
				( err && err.message ? err.message : String( err ) );
			manager.itemError( 'mtl://male02.mtl' );
		} );

		// model
		//
		// Upstream uses `new OBJLoader(manager).load(url, onLoad, onProgress, onError)`.
		// Our SwitchOBJLoader keeps the same API surface but routes the
		// load through `fetch + parse(text)` internally (see
		// libs/obj-loader.js header for why).

		function onProgress( /* xhr */ ) {
			// Upstream logs download progress via console.log. Dropped —
			// nx.js's `console.log` flips canvas into text-render mode
			// ([[console-error-switches-render-mode]]).
		}

		function onError( err ) {
			// Upstream's onError is an empty function. We surface the
			// failure into the status canvas so a missing/broken OBJ
			// doesn't manifest as a misleading "cannot read 'traverse'"
			// error from loadModel firing with object undefined.
			globalThis.__objError = 'obj load: ' +
				( err && err.message ? err.message : String( err ) );
		}

		const loader = new SwitchOBJLoader( manager );
		loader.load(
			'brewser://apps/ThreeJSDemos/webgl-loader-obj/assets/male02.obj',
			function ( obj ) {

				object = obj;
				globalThis.__objModelLoaded = true;

			},
			onProgress,
			onError
		);

		//

		renderer = new THREE.WebGLRenderer( {
			canvas: canvas, context: context, antialias: true,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		} );
		// Upstream `renderer.setPixelRatio(window.devicePixelRatio)` +
		// `renderer.setSize(window.innerWidth, window.innerHeight)` →
		// dropped per unified template; we use the canvas dimensions
		// captured above.
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		//

		controls = new SwitchOrbitControls( THREE, camera );
		controls.minDistance = 2;
		controls.maxDistance = 5;
		// Upstream registers `controls.addEventListener('change', render)`.
		// SwitchOrbitControls doesn't expose 'change' events (it's a
		// pull-model wrapper). The animate() loop below detects
		// stick deflection via theta/phi deltas — same effect.

		//

		// Upstream `window.addEventListener('resize', onWindowResize)` —
		// dropped (canvas-runner fullscreen rerun handles sizing).

	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__objAnimateCalled = true;
		globalThis.__objFrameCount = ( globalThis.__objFrameCount | 0 ) + 1;

		// Render-on-demand. Detect stick deflection via the orbit
		// controls' internal spherical coords (same pattern as
		// milestone #14 — [[swb-threejs-webgl-materials-wireframe]]).
		const beforeTheta = controls && controls._spherical ? controls._spherical.theta : 0;
		const beforePhi = controls && controls._spherical ? controls._spherical.phi : 0;
		if ( controls ) controls.update();
		const afterTheta = controls && controls._spherical ? controls._spherical.theta : 0;
		const afterPhi = controls && controls._spherical ? controls._spherical.phi : 0;
		const stickActive = Math.abs( afterTheta - beforeTheta ) > 1e-5 ||
		                    Math.abs( afterPhi - beforePhi ) > 1e-5;

		if ( stickActive || firstRenderPending ) {
			render();
			firstRenderPending = false;
		}

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__objFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		renderer.resetState();
		renderer.render( scene, camera );
		globalThis.__objRenderCount = ( globalThis.__objRenderCount | 0 ) + 1;

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__objError ) {

		globalThis.__objError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
