// Three.js r162 webgl_materials_cubemap example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_materials_cubemap.html
//
// First milestone (#25) that exercises runtime cubemap URL loading
// end-to-end on the new image-to-texture pipeline ([[nxjs-image-to-texture-pipeline]]).
// Forced bridge surface: per-face cube uploads via
// `nx_webgl_egl_persistent_cube_texture_image_2d`, generateMipmap
// extended to TEXTURE_CUBE_MAP. Reflection + refraction + Mix combine
// all ride the existing raw-shader passthrough path
// ([[bridge-raw-shader-passthrough]] + [[swb-passthrough-pivot]]) since
// the `SHADER_NAME ` marker covers stock MeshLambertMaterial.
//
// Adapted as 1:1 to upstream as possible. Pre-authorized deviations:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Fullscreen-responsive: canvas dimensions read at script load time
//      so the demo auto-scales when the shell reruns it at 1280x720.
//      `window.innerWidth/Height`, `setPixelRatio`, and the resize
//      listener dropped per the unified template.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. OrbitControls replaced with gamepad-driven SwitchOrbitControls
//      (left stick = orbit). Pan and zoom disabled per upstream.
//   7. OBJLoader bundled as IIFE at libs/obj-loader.js (no importmap on
//      our pages). Same FileLoader replacement as milestone #16.
//   8. Stats addon dropped (no DOM; status canvas surfaces FPS instead).
//   9. CubeTextureLoader replaced by manual Image + `CubeTexture.images[]`
//      assignment. nx.js's Image bypasses the global fetch
//      ([[nxjs-image-bypasses-global-fetch]]), so URLs go through
//      `sdmc:/` rather than `brewser://`. Three.js's WebGLTextures
//      uploadCubeTexture path treats `texture.image[i]` as raw image
//      sources and calls `texImage2D(face_target, 0, format, format,
//      type, image)` per face - which the new nxjs cube path handles
//      ([[nxjs-image-to-texture-pipeline]] + this milestone's
//      cube-face upload helper).

globalThis.__cubeMainStarted = true;
globalThis.__cubeAnimateCalled = false;
globalThis.__cubeError = null;
globalThis.__cubeFacesLoaded = 0;
globalThis.__cubeFacesLoadedRefr = 0;
globalThis.__cubeObjLoaded = false;
globalThis.__cubeHeadCount = 0;
globalThis.__cubeFrameCount = 0;
globalThis.__cubeRenderCount = 0;
globalThis.__cubeFps = 0;
globalThis.__cubeBgPass = false;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if ( ! THREE ) {
		globalThis.__cubeError = 'THREE not loaded - is libs/three.iife.js missing?';
		throw new Error( 'no THREE' );
	}
	if ( ! globalThis.SwitchOBJLoader ) {
		globalThis.__cubeError = 'SwitchOBJLoader not loaded - is libs/obj-loader.js missing?';
		throw new Error( 'no OBJLoader' );
	}

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const cubeCanvasEl = document.getElementById( 'cube-canvas' );
	const SCREEN_WIDTH = ( cubeCanvasEl && cubeCanvasEl.width ) || 640;
	const SCREEN_HEIGHT = ( cubeCanvasEl && cubeCanvasEl.height ) || 360;

	let camera, scene, renderer, controls;
	let pointLight;
	let firstRenderPending = true;

	// nx.js's Image fetches through a module-local loader that doesn't
	// recognise `brewser://`, so every Image src has to point at sdmc:/.
	// Path matches the romfs install + the Citron-profile mirror.
	const ASSET_PREFIX_SDMC =
		'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-materials-cubemap/assets/';
	const ASSET_PREFIX_BROWSER =
		'brewser://apps/ThreeJSDemos/webgl-materials-cubemap/assets/';

	const canvas = document.getElementById( 'cube-canvas' );
	if ( ! canvas ) {
		globalThis.__cubeError = '#cube-canvas missing in HTML';
		throw new Error( 'no canvas' );
	}
	const gl = canvas.getContext( 'webgl', {
		alpha: false,
		antialias: true,
		depth: true,
		stencil: false,
		preserveDrawingBuffer: false,
	} );
	if ( ! gl ) {
		globalThis.__cubeError = 'WebGL acquire failed';
		throw new Error( 'no gl' );
	}
	const stableConstructor = { name: 'WebGLRenderingContext' };
	const fnCache = new Map();
	const context = new Proxy( gl, {
		get( target, property, receiver ) {
			if ( property === 'constructor' ) return stableConstructor;
			if ( property === 'canvas' ) return canvas;
			const value = Reflect.get( target, property, receiver );
			if ( typeof value !== 'function' ) return value;
			if ( fnCache.has( property ) ) return fnCache.get( property );
			const bound = ( ...args ) => value.apply( target, args );
			fnCache.set( property, bound );
			return bound;
		},
	} );

	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	init();
	animate();

	function init() {

		camera = new THREE.PerspectiveCamera( 50, SCREEN_WIDTH / SCREEN_HEIGHT, 0.1, 100 );
		camera.position.z = 13;

		// cubemap - upstream uses `new THREE.CubeTextureLoader().load(urls)`
		// which internally creates a CubeTexture and an ImageLoader per face.
		// We bypass ImageLoader (XHR-based, not supported on nx.js) and load
		// the 6 Image objects ourselves, populating `cubeTex.images[]`
		// directly. Three.js's WebGLTextures.uploadCubeTexture treats these
		// HTMLImageElement-like sources as ready-to-upload after
		// `needsUpdate = true`, calling `texImage2D(face_target, ..., image)`
		// per face. The new nxjs cube-face upload helper takes it from there.
		const FACES = [ 'px', 'nx', 'py', 'ny', 'pz', 'nz' ];

		function loadCubeTexture( counterKey, mapping ) {
			const tex = new THREE.CubeTexture();
			tex.images = new Array( 6 );
			if ( mapping !== undefined ) tex.mapping = mapping;
			let loaded = 0;
			FACES.forEach( ( face, i ) => {
				const img = new Image();
				img.onload = () => {
					tex.images[ i ] = img;
					loaded ++;
					globalThis[ counterKey ] = loaded;
					if ( loaded === 6 ) {
						tex.needsUpdate = true;
						firstRenderPending = true;
					}
				};
				img.onerror = () => {
					globalThis.__cubeError = 'cube face load: ' + face;
				};
				img.src = ASSET_PREFIX_SDMC + 'cube/' + face + '.jpg';
			} );
			return tex;
		}

		const reflectionCube = loadCubeTexture( '__cubeFacesLoaded' );
		const refractionCube = loadCubeTexture( '__cubeFacesLoadedRefr',
			THREE.CubeRefractionMapping );

		scene = new THREE.Scene();
		scene.background = reflectionCube;

		// lights
		const ambient = new THREE.AmbientLight( 0xffffff, 3 );
		scene.add( ambient );

		pointLight = new THREE.PointLight( 0xffffff, 200 );
		scene.add( pointLight );

		// materials
		const cubeMaterial3 = new THREE.MeshLambertMaterial( {
			color: 0xffaa00, envMap: reflectionCube,
			combine: THREE.MixOperation, reflectivity: 0.3,
		} );
		const cubeMaterial2 = new THREE.MeshLambertMaterial( {
			color: 0xfff700, envMap: refractionCube, refractionRatio: 0.95,
		} );
		const cubeMaterial1 = new THREE.MeshLambertMaterial( {
			color: 0xffffff, envMap: reflectionCube,
		} );

		// models - upstream's OBJLoader bypassed for the same reasons as
		// milestone #16 (libs/obj-loader.js with fetch-based load).
		// SwitchOBJLoader.load(url) fetches `url` directly (doesn't read
		// `this.path`), so the full brewser:// URL goes in.
		const objLoader = new SwitchOBJLoader();
		objLoader.load( ASSET_PREFIX_BROWSER + 'WaltHead.obj', function ( object ) {

			const head = object.children[ 0 ];
			head.scale.setScalar( 0.1 );
			head.position.y = - 3;
			head.material = cubeMaterial1;

			const head2 = head.clone();
			head2.position.x = - 6;
			head2.material = cubeMaterial2;

			const head3 = head.clone();
			head3.position.x = 6;
			head3.material = cubeMaterial3;

			scene.add( head, head2, head3 );

			globalThis.__cubeObjLoaded = true;
			globalThis.__cubeHeadCount = 3;
			firstRenderPending = true;

		}, function () {}, function ( err ) {
			globalThis.__cubeError = 'obj load: ' +
				( err && err.message ? err.message : String( err ) );
		} );

		// renderer
		renderer = new THREE.WebGLRenderer( {
			canvas: canvas, context: context, antialias: true,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		} );
		// Upstream `setPixelRatio(window.devicePixelRatio)` +
		// `setSize(window.innerWidth, window.innerHeight)` dropped per
		// unified template.
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		// controls — upstream:
		//   controls.enableZoom = false;  controls.enablePan = false;
		//   controls.minPolarAngle = PI/4;  controls.maxPolarAngle = PI/1.5;
		// SwitchOrbitControls defaults `enablePan = false` per project
		// convention (right stick is reserved for shell navigation); we
		// still set enableZoom = false here to match upstream's fixed-
		// distance camera (initial r=13 stays the orbit radius).
		controls = new SwitchOrbitControls( THREE, camera );
		controls.enableZoom = false;
		controls.minPolarAngle = Math.PI / 4;
		controls.maxPolarAngle = Math.PI / 1.5;
		// Surface for the status canvas's stick-axes diagnostic.
		globalThis.__cubeControls = controls;

	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__cubeAnimateCalled = true;
		globalThis.__cubeFrameCount = ( globalThis.__cubeFrameCount | 0 ) + 1;

		// Render-on-demand keeps idle FPS sane. Upstream rerenders every
		// frame because the heads are static but Stats updates each tick;
		// we detect orbit-stick deflection like milestone #16.
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
			globalThis.__cubeFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		renderer.resetState();
		renderer.render( scene, camera );
		globalThis.__cubeRenderCount = ( globalThis.__cubeRenderCount | 0 ) + 1;
		// Background pass fires whenever scene.background is a CubeTexture
		// AND all 6 faces have uploaded (gles_handle != 0). Use the faces-
		// loaded counter as a proxy for "skybox should be on screen now".
		if ( ( globalThis.__cubeFacesLoaded | 0 ) === 6 ) {
			globalThis.__cubeBgPass = true;
		}

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__cubeError ) {
		globalThis.__cubeError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );
	}

}
