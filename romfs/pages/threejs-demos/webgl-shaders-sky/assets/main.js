// Three.js webgl_shaders_sky example — 1:1 port for switch-web-browser.
//
// Source: three-latest/examples/webgl_shaders_sky.html (Three.js r184).
//
// Pre-authorized deviations:
//
//   1. Library load: `THREE = globalThis.__THREE_R184_STAGED__` instead
//      of an import map; r184 nx.js shims from libs/r184-nxjs-bridge.js
//      (bypassWebGL1Check + rAF heartbeat).
//   2. `GUI` from `globalThis.lilGui.GUI` (unpatched IIFE).
//   3. `Sky` from `globalThis.Sky` (IIFE).
//   4. OrbitControls dropped — static camera at upstream's start pos
//      (0, 100, 2000). No gamepad input. Per session constraint.
//   5. Canvas: reuse <canvas id="sky-canvas">; no
//      `document.body.appendChild(renderer.domElement)`.
//      setPixelRatio + resize listener dropped.
//   6. WebGL 2 context: explicit `canvas.getContext('webgl2')` with a
//      Proxy whose `constructor.name === 'WebGL2RenderingContext'`,
//      wrapped in `bypassWebGL1Check`.
//   7. console.warn/log/error/info silenced
//      ([[console-error-switches-render-mode]]).
//   8. `renderer.resetState()` before every render
//      ([[threejs-resetstate]]).

globalThis.__skyError = null;
globalThis.__skyFps = 0;
globalThis.__skyFrameCount = 0;
globalThis.__skyIsWebGL2 = false;
globalThis.__skySceneReady = false;
globalThis.__skyGuiCreated = false;
globalThis.__skyGlErrorAfter = -1;

( function run() {
try {

	const THREE = globalThis.__THREE_R184_STAGED__;
	if ( ! THREE ) throw new Error( 'THREE r184 not loaded' );

	const Sky = globalThis.Sky;
	if ( ! Sky ) throw new Error( 'Sky class not loaded' );

	const lilGui = globalThis.lilGui;
	if ( ! lilGui ) throw new Error( 'lilGui not loaded' );
	const GUI = lilGui.GUI;

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const canvas = document.getElementById( 'sky-canvas' );
	if ( ! canvas ) throw new Error( '#sky-canvas missing' );

	const gl = canvas.getContext( 'webgl2', {
		alpha: false, antialias: false, depth: true,
		stencil: false, preserveDrawingBuffer: false,
	} );
	if ( ! gl ) throw new Error( 'WebGL 2 not supported' );
	globalThis.__skyIsWebGL2 = true;
	if ( typeof gl.enableGpuBridgePrototype === 'function' ) {
		gl.enableGpuBridgePrototype( true );
	}

	const stableConstructor = { name: 'WebGL2RenderingContext' };
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

	const SCREEN_WIDTH = canvas.width || 640;
	const SCREEN_HEIGHT = canvas.height || 360;

	let camera, scene, renderer;
	let sky, sun;

	init();

	function initSky() {

		// Add Sky
		sky = new Sky();
		sky.scale.setScalar( 450000 );
		scene.add( sky );

		sun = new THREE.Vector3();

		/// GUI

		const effectController = {
			turbidity: 10,
			rayleigh: 3,
			mieCoefficient: 0.005,
			mieDirectionalG: 0.7,
			elevation: 2,
			azimuth: 180,
			exposure: renderer.toneMappingExposure,
			cloudCoverage: 0.4,
			cloudDensity: 0.4,
			cloudElevation: 0.5,
			showSunDisc: true
		};

		function guiChanged() {

			const uniforms = sky.material.uniforms;
			uniforms[ 'turbidity' ].value = effectController.turbidity;
			uniforms[ 'rayleigh' ].value = effectController.rayleigh;
			uniforms[ 'mieCoefficient' ].value = effectController.mieCoefficient;
			uniforms[ 'mieDirectionalG' ].value = effectController.mieDirectionalG;
			uniforms[ 'cloudCoverage' ].value = effectController.cloudCoverage;
			uniforms[ 'cloudDensity' ].value = effectController.cloudDensity;
			uniforms[ 'cloudElevation' ].value = effectController.cloudElevation;
			uniforms[ 'showSunDisc' ].value = effectController.showSunDisc;

			const phi = THREE.MathUtils.degToRad( 90 - effectController.elevation );
			const theta = THREE.MathUtils.degToRad( effectController.azimuth );

			sun.setFromSphericalCoords( 1, phi, theta );

			uniforms[ 'sunPosition' ].value.copy( sun );

			renderer.toneMappingExposure = effectController.exposure;

		}

		const gui = new GUI();

		gui.add( effectController, 'turbidity', 0.0, 20.0, 0.1 ).onChange( guiChanged );
		gui.add( effectController, 'rayleigh', 0.0, 4, 0.001 ).onChange( guiChanged );
		gui.add( effectController, 'mieCoefficient', 0.0, 0.1, 0.001 ).onChange( guiChanged );
		gui.add( effectController, 'mieDirectionalG', 0.0, 1, 0.001 ).onChange( guiChanged );
		gui.add( effectController, 'elevation', 0, 90, 0.1 ).onChange( guiChanged );
		gui.add( effectController, 'azimuth', - 180, 180, 0.1 ).onChange( guiChanged );
		gui.add( effectController, 'exposure', 0, 1, 0.0001 ).onChange( guiChanged );
		gui.add( effectController, 'showSunDisc' ).onChange( guiChanged );

		const folderClouds = gui.addFolder( 'Clouds' );
		folderClouds.add( effectController, 'cloudCoverage', 0, 1, 0.01 ).name( 'coverage' ).onChange( guiChanged );
		folderClouds.add( effectController, 'cloudDensity', 0, 1, 0.01 ).name( 'density' ).onChange( guiChanged );
		folderClouds.add( effectController, 'cloudElevation', 0, 1, 0.01 ).name( 'elevation' ).onChange( guiChanged );

		globalThis.__skyGuiCreated = true;

		guiChanged();

	}

	function init() {

		camera = new THREE.PerspectiveCamera( 60, SCREEN_WIDTH / SCREEN_HEIGHT, 100, 2000000 );
		camera.position.set( 0, 100, 2000 );

		scene = new THREE.Scene();

		const helper = new THREE.GridHelper( 10000, 2, 0xffffff, 0xffffff );
		scene.add( helper );

		bypassWebGL1Check( () => {
			renderer = new THREE.WebGLRenderer( {
				canvas, context,
				alpha: false, depth: true, stencil: false,
				preserveDrawingBuffer: false,
			} );
		} );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );
		renderer.setAnimationLoop( animate );
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 0.5;

		initSky();

		globalThis.__skySceneReady = true;

	}

	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	function animate() {

		try {

			sky.material.uniforms[ 'time' ].value = performance.now() * 0.001;
			renderer.resetState();
			renderer.render( scene, camera );

			globalThis.__skyGlErrorAfter = gl.getError();
			globalThis.__skyFrameCount = ( globalThis.__skyFrameCount | 0 ) + 1;
			fpsAccumFrames ++;
			const now = Date.now();
			if ( now - fpsAccumStart >= 3000 ) {
				globalThis.__skyFps = Math.round( ( fpsAccumFrames * 1000 ) / ( now - fpsAccumStart ) );
				fpsAccumStart = now;
				fpsAccumFrames = 0;
			}

		} catch ( e ) {
			if ( ! globalThis.__skyError ) {
				globalThis.__skyError = 'render: ' + ( e && e.message ? e.message : String( e ) );
			}
		}

	}

} catch ( e ) {
	if ( ! globalThis.__skyError ) {
		globalThis.__skyError = String( e && e.message ? e.message : e );
	}
}
} )();
