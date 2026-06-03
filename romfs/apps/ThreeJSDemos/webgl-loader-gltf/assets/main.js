// Three.js webgl_loader_gltf example — adapted port for switch-web-browser.
//
// Source: three-latest/examples/webgl_loader_gltf.html (Three.js r184).
//
// **Library version reverted to r162** for this Citron release. The
// straight 1:1 r184 port was attempted (see git history / [[swb-threejs-webgl-loader-gltf]])
// but r184's PMREMGenerator blur ping-pong wedges Citron's Mesa
// Nouveau GLES backend ([[mesa-nouveau-pmrem-wedge]]) — meaning IBL
// reflections on the helmet visor went matte. r162's PMREM works on
// Citron (smaller cubeUV layout + WebGL 1 bridge path) so we stay on
// r162 here until real Tegra hardware is available. The demo's
// upstream-fidelity features (model browser, currentLoadId, fit-camera,
// AnimationMixer) all port across versions cleanly.
//
// Pre-authorized deviations:
//
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__` (r162
//      IIFE) instead of an import map. Upstream is r184; ours is r162.
//   2. Canvas: reuse <canvas id="gltf-canvas"> from index.html; no
//      `container.appendChild(...)`. setPixelRatio + resize listener
//      dropped — canvas dims come from element attrs.
//   3. WebGL 1 context: `canvas.getContext('webgl')` with a Proxy
//      whose `constructor.name === 'WebGLRenderingContext'`.
//   4. `fetch('https://raw.githubusercontent.com/.../model-index.json')`
//      replaced with a bundled hardcoded list of four pre-extracted
//      models (Citron has no TCP sockets). Per-model .gltf + .bin +
//      textures load through our in-house GLTFLoader with
//      `setSdmcModelPath` / `setSdmcImagePath` ([[r184-fetch-hang]]
//      doesn't apply on r162, but the sdmc:/ path keeps the pipeline
//      uniform with the r184 Soldier/Texture3D demos that need it).
//   5. `lil-gui` model-selector + backgroundBlurriness slider replaced
//      with gamepad cycling (A = previous, B = next) and a hardcoded
//      `scene.backgroundBlurriness = 0.0001` — the cubemaps-dodge
//      trick from [[bridge-hdr-pmrem-support]] that routes the
//      WebGLBackground through cubeUV (PMREM-prefiltered) instead of
//      the unsupported real WebGLCubeRenderTarget path.
//   6. `UltraHDRLoader` (r184-only addon) → r162's `RGBELoader` with a
//      `royal_esplanade_1k.hdr` asset. UltraHDRLoader is preserved at
//      libs/ultrahdr-loader.js for the eventual real-hardware retry.
//   7. `OrbitControls(camera, renderer.domElement)` →
//      `SwitchOrbitControls(THREE, camera)` (gamepad sticks).
//   8. `await renderer.compileAsync(...)` dropped — nx.js has no
//      parallel-shader-compile.
//   9. `console.warn/log/error/info` silenced
//      ([[console-error-switches-render-mode]]).
//  10. `renderer.resetState()` before every render
//      ([[threejs-resetstate]]).
//  11. Morph-target animations (Flamingo, Horse) do not play — our
//      in-house GLTFLoader does not yet implement the `weights`
//      animation path. Skeletal + TRS animations do play. Static
//      meshes render correctly.

globalThis.__gltfError = null;
globalThis.__gltfFps = 0;
globalThis.__gltfFrameCount = 0;
globalThis.__gltfHdrLoaded = false;
globalThis.__gltfHdrSize = '';
globalThis.__gltfPmremGenerated = false;
globalThis.__gltfCurrentModel = '';
globalThis.__gltfMeshCount = 0;
globalThis.__gltfTriangleCount = 0;
globalThis.__gltfAnimCount = 0;
globalThis.__gltfLoadCount = 0;
globalThis.__gltfGlErrorAfter = -1;

try {

	const THREE = globalThis.__THREE_R162_STAGED__;
	if ( ! THREE ) throw new Error( 'THREE r162 not loaded' );
	if ( typeof THREE.GLTFLoader !== 'function' ) throw new Error( 'GLTFLoader not loaded' );
	if ( typeof THREE.RGBELoader !== 'function' ) throw new Error( 'RGBELoader not loaded' );

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const canvas = document.getElementById( 'gltf-canvas' );
	if ( ! canvas ) throw new Error( '#gltf-canvas missing' );

	const SCREEN_WIDTH = canvas.width || 640;
	const SCREEN_HEIGHT = canvas.height || 360;

	const gl = canvas.getContext( 'webgl', {
		alpha: false, antialias: false, depth: true,
		stencil: false, preserveDrawingBuffer: false,
	} );
	if ( ! gl ) throw new Error( 'WebGL acquire failed' );

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

	const ASSETS_BASE = 'brewser://apps/ThreeJSDemos/webgl-loader-gltf/assets/';
	const ASSETS_SDMC_BASE = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-loader-gltf/assets/';

	// Bundled stand-in for upstream's model-index.json. Pre-extracted
	// offline via scripts/extract-glb.mjs into per-model folders.
	const models = [
		{
			name: 'DamagedHelmet',
			sdmcPath: ASSETS_SDMC_BASE + 'models/DamagedHelmet/',
			file: 'DamagedHelmet.gltf',
		},
		{
			name: 'Duck',
			sdmcPath: ASSETS_SDMC_BASE + 'models/Duck/',
			file: 'Duck.gltf',
		},
		{
			name: 'Flamingo',
			sdmcPath: ASSETS_SDMC_BASE + 'models/Flamingo/',
			file: 'Flamingo.gltf',
		},
		{
			name: 'Horse',
			sdmcPath: ASSETS_SDMC_BASE + 'models/Horse/',
			file: 'Horse.gltf',
		},
	];
	let modelIdx = 0;

	const renderer = new THREE.WebGLRenderer( { canvas, context, antialias: false } );
	renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );
	renderer.setClearColor( 0x0a1622, 1 );
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.0;

	const camera = new THREE.PerspectiveCamera( 45, SCREEN_WIDTH / SCREEN_HEIGHT, 0.25, 20 );
	camera.position.set( - 1.8, 0.6, 2.7 );

	const scene = new THREE.Scene();

	if ( typeof globalThis.SwitchOrbitControls !== 'function' ) {
		throw new Error( 'SwitchOrbitControls not loaded' );
	}
	const controls = new globalThis.SwitchOrbitControls( THREE, camera );
	controls.target.set( 0, 0, - 0.2 );
	controls.minDistance = 2;
	controls.maxDistance = 10;
	controls.enableDamping = true;
	controls.update();

	// HDR environment — load Royal Esplanade equirect, hand to
	// PMREMGenerator (Three.js does this lazily via scene.environment +
	// the cubeuvmaps path triggered by backgroundBlurriness > 0).
	const rgbeLoader = new THREE.RGBELoader();
	rgbeLoader.setPath( ASSETS_BASE );
	rgbeLoader.load(
		'royal_esplanade_1k.hdr',
		( hdrTex ) => {
			try {
				globalThis.__gltfHdrLoaded = true;
				globalThis.__gltfHdrSize = ( hdrTex.image && hdrTex.image.width
					? hdrTex.image.width + 'x' + hdrTex.image.height
					: '?' );
				hdrTex.mapping = THREE.EquirectangularReflectionMapping;
				scene.background = hdrTex;
				scene.environment = hdrTex;
				// backgroundBlurriness > 0 routes WebGLBackground through the
				// cubeuvmaps (PMREM cubeUV 2D layout) path instead of cubemaps
				// (real WebGLCubeRenderTarget — needs cube-face FBO support
				// we don't have). [[bridge-hdr-pmrem-support]].
				scene.backgroundBlurriness = 0.0001;
				globalThis.__gltfPmremGenerated = true;
			} catch ( e ) {
				globalThis.__gltfError = 'hdr setup: ' + ( e && e.message || e );
			}
		},
		undefined,
		( err ) => { globalThis.__gltfError = 'rgbe loader: ' + ( err && err.message || err ); }
	);

	let currentModel = null, mixer = null;
	let currentLoadId = 0;
	const clock = new THREE.Clock();

	function loadModel( modelInfo ) {

		if ( currentModel ) {
			scene.remove( currentModel );
			currentModel = null;
		}

		if ( mixer ) {
			mixer.stopAllAction();
			mixer = null;
		}

		const loadId = ++ currentLoadId;

		const loader = new THREE.GLTFLoader();
		loader.setSdmcModelPath( modelInfo.sdmcPath );
		loader.setSdmcImagePath( modelInfo.sdmcPath );

		globalThis.__gltfCurrentModel = modelInfo.name + ' (loading)';

		loader.load( modelInfo.file, ( gltf ) => {

			if ( loadId !== currentLoadId ) return;

			currentModel = gltf.scene;
			scene.add( currentModel );

			fitCameraToSelection( camera, controls, currentModel );

			if ( gltf.animations.length > 0 ) {
				mixer = new THREE.AnimationMixer( currentModel );
				for ( const animation of gltf.animations ) {
					mixer.clipAction( animation ).play();
				}
			}

			let meshCount = 0, triCount = 0;
			currentModel.traverse( ( o ) => {
				if ( o.isMesh ) {
					meshCount ++;
					const g = o.geometry;
					if ( g.index ) triCount += g.index.count / 3;
					else if ( g.attributes && g.attributes.position ) {
						triCount += g.attributes.position.count / 3;
					}
				}
			} );
			globalThis.__gltfMeshCount = meshCount;
			globalThis.__gltfTriangleCount = triCount | 0;
			globalThis.__gltfAnimCount = gltf.animations.length;
			globalThis.__gltfLoadCount = ( globalThis.__gltfLoadCount | 0 ) + 1;
			globalThis.__gltfCurrentModel = modelInfo.name;

		}, undefined, ( err ) => {
			globalThis.__gltfError = 'loader (' + modelInfo.name + '): ' +
				( err && err.message ? err.message : String( err ) );
		} );

	}

	function fitCameraToSelection( camera, controls, selection, fitOffset = 1.3 ) {

		const box = new THREE.Box3();
		box.setFromObject( selection );

		const size = box.getSize( new THREE.Vector3() );
		const center = box.getCenter( new THREE.Vector3() );

		const maxSize = Math.max( size.x, size.y, size.z );
		const fitHeightDistance = maxSize / ( 2 * Math.atan( Math.PI * camera.fov / 360 ) );
		const distance = fitOffset * fitHeightDistance;

		const direction = controls.target.clone().sub( camera.position ).normalize().multiplyScalar( distance );

		controls.maxDistance = distance * 10;
		controls.minDistance = distance / 10;
		controls.target.copy( center );

		camera.near = distance / 100;
		camera.far = distance * 100;
		camera.updateProjectionMatrix();

		camera.position.copy( controls.target ).sub( direction );
		controls.update();

	}

	let prevA = false, prevB = false;

	function pollGamepad() {
		const pads = navigator.getGamepads ? navigator.getGamepads() : null;
		const pad = ( pads && pads.length ) ? pads[ 0 ] : null;
		if ( ! pad ) return;
		const a = pad.buttons[ 0 ] && pad.buttons[ 0 ].pressed;
		const b = pad.buttons[ 1 ] && pad.buttons[ 1 ].pressed;
		if ( a && ! prevA ) {
			modelIdx = ( modelIdx - 1 + models.length ) % models.length;
			loadModel( models[ modelIdx ] );
		}
		if ( b && ! prevB ) {
			modelIdx = ( modelIdx + 1 ) % models.length;
			loadModel( models[ modelIdx ] );
		}
		prevA = a;
		prevB = b;
	}

	// Kick off initial load.
	loadModel( models[ modelIdx ] );

	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	function animate() {
		try {
			pollGamepad();
			controls.update();
			if ( mixer ) mixer.update( clock.getDelta() );

			renderer.resetState();
			renderer.render( scene, camera );

			globalThis.__gltfGlErrorAfter = gl.getError();
			globalThis.__gltfFrameCount = ( globalThis.__gltfFrameCount | 0 ) + 1;
			fpsAccumFrames ++;
			const now = Date.now();
			if ( now - fpsAccumStart >= 3000 ) {
				globalThis.__gltfFps = Math.round( ( fpsAccumFrames * 1000 ) / ( now - fpsAccumStart ) );
				fpsAccumStart = now;
				fpsAccumFrames = 0;
			}
		} catch ( e ) {
			if ( ! globalThis.__gltfError ) {
				globalThis.__gltfError = 'render: ' + ( e && e.message ? e.message : String( e ) );
			}
		}
		requestAnimationFrame( animate );
	}
	requestAnimationFrame( animate );

} catch ( e ) {
	if ( ! globalThis.__gltfError ) {
		globalThis.__gltfError = String( e && e.message ? e.message : e );
	}
}
