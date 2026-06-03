// Three.js r162 webgl_camera example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_camera.html
//
// Adapted as 1:1 to upstream as possible. Deviations enumerated:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__` from a
//      separate <script> tag, replaces upstream's importmap+module.
//   2. Stats addon dropped; status canvas in index.html shows FPS +
//      diagnostics via globalThis.__camera* writes.
//   3. Fixed-size 640x360 canvas; setPixelRatio / window.innerWidth /
//      resize listener / document.createElement('div') / appendChild
//      dropped.
//   4. Stable Proxy on the WebGLRenderingContext so Three.js sees a
//      consistent constructor identity (same scaffold as siblings).
//   5. console.warn/log/error/info silenced ([[console-error-switches-
//      render-mode]]).
//   6. `renderer.resetState()` BEFORE setScissor/setViewport/
//      setClearColor/setScissorTest in render() (not after). resetState()
//      restores GL defaults (scissor disabled, viewport=full canvas), so
//      the upstream order would clobber the state Three.js just
//      configured. setScissorTest(true) is also re-asserted each pass
//      for the same reason. See [[threejs-resetstate-per-frame]].
//   7. onKeyDown (O/P keys) replaced with pollGamepad (B=perspective,
//      A=orthographic), rising-edge detection. Polled once per frame
//      from animate(), analogous to the lil-gui replacements in #4 / #5.
//   8. Bridge GL_POINTS support added in nxjs-source/source/webgl.c
//      (`draw_arrays_points`) so the upstream 10,000-particle
//      `THREE.Points` starfield renders through the bridge unchanged.

globalThis.__cameraMainStarted = true;
globalThis.__cameraAnimateCalled = false;
globalThis.__cameraError = null;
globalThis.__cameraParticleCount = 0;
globalThis.__cameraFrameCount = 0;
globalThis.__cameraFps = 0;
globalThis.__cameraActiveKind = 'perspective';

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__cameraError = 'THREE not loaded - is libs/three.iife.js missing?';
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
	const cameraCanvasEl = document.getElementById('camera-canvas');
	const SCREEN_WIDTH = (cameraCanvasEl && cameraCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (cameraCanvasEl && cameraCanvasEl.height) || 360;
	const aspect = SCREEN_WIDTH / SCREEN_HEIGHT;

	let camera, scene, renderer, mesh;
	let cameraRig, activeCamera, activeHelper;
	let cameraPerspective, cameraOrtho;
	let cameraPerspectiveHelper, cameraOrthoHelper;
	const frustumSize = 600;

	// SWB scaffolding: canvas + gl Proxy. Sourced once at module top
	// because init() consumes them.
	const canvas = document.getElementById('camera-canvas');
	if (!canvas) {
		globalThis.__cameraError = '#camera-canvas missing in HTML';
		throw new Error('no canvas');
	}
	const gl = canvas.getContext('webgl', {
		alpha: false,
		antialias: false,
		depth: true,
		stencil: false,
		preserveDrawingBuffer: false,
	});
	if (!gl) {
		globalThis.__cameraError = 'WebGL acquire failed';
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

	// SWB-specific: gamepad polling state for the keydown replacement.
	const prevButtons = [false, false];
	// SWB-specific: FPS sampling for the status panel (replaces Stats).
	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	init();
	animate();

	function init() {

		scene = new THREE.Scene();

		//

		camera = new THREE.PerspectiveCamera( 50, 0.5 * aspect, 1, 10000 );
		camera.position.z = 2500;

		cameraPerspective = new THREE.PerspectiveCamera( 50, 0.5 * aspect, 150, 1000 );

		cameraPerspectiveHelper = new THREE.CameraHelper( cameraPerspective );
		scene.add( cameraPerspectiveHelper );

		//
		cameraOrtho = new THREE.OrthographicCamera( 0.5 * frustumSize * aspect / - 2, 0.5 * frustumSize * aspect / 2, frustumSize / 2, frustumSize / - 2, 150, 1000 );

		cameraOrthoHelper = new THREE.CameraHelper( cameraOrtho );
		scene.add( cameraOrthoHelper );

		//

		activeCamera = cameraPerspective;
		activeHelper = cameraPerspectiveHelper;


		// counteract different front orientation of cameras vs rig

		cameraOrtho.rotation.y = Math.PI;
		cameraPerspective.rotation.y = Math.PI;

		cameraRig = new THREE.Group();

		cameraRig.add( cameraPerspective );
		cameraRig.add( cameraOrtho );

		scene.add( cameraRig );

		//

		mesh = new THREE.Mesh(
			new THREE.SphereGeometry( 100, 16, 8 ),
			new THREE.MeshBasicMaterial( { color: 0xffffff, wireframe: true } )
		);
		scene.add( mesh );

		const mesh2 = new THREE.Mesh(
			new THREE.SphereGeometry( 50, 16, 8 ),
			new THREE.MeshBasicMaterial( { color: 0x00ff00, wireframe: true } )
		);
		mesh2.position.y = 150;
		mesh.add( mesh2 );

		const mesh3 = new THREE.Mesh(
			new THREE.SphereGeometry( 5, 16, 8 ),
			new THREE.MeshBasicMaterial( { color: 0x0000ff, wireframe: true } )
		);
		mesh3.position.z = 150;
		cameraRig.add( mesh3 );

		//

		const geometry = new THREE.BufferGeometry();
		const vertices = [];

		for ( let i = 0; i < 10000; i ++ ) {

			vertices.push( THREE.MathUtils.randFloatSpread( 2000 ) ); // x
			vertices.push( THREE.MathUtils.randFloatSpread( 2000 ) ); // y
			vertices.push( THREE.MathUtils.randFloatSpread( 2000 ) ); // z

		}

		geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );

		const particles = new THREE.Points( geometry, new THREE.PointsMaterial( { color: 0x888888 } ) );
		scene.add( particles );

		globalThis.__cameraParticleCount = 10000;

		//

		renderer = new THREE.WebGLRenderer( { canvas: canvas, context: context, antialias: true } );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		// setScissorTest( true ) is re-asserted inside render() before each
		// renderer.render(): resetState() restores GL defaults (scissor test
		// disabled), so a one-shot init-time call wouldn't survive the
		// first per-frame reset.

	}

	//

	// Replaces upstream's `document.addEventListener('keydown', onKeyDown)`.
	// Polled once per animate() iteration.
	function pollGamepad() {

		const pads = navigator.getGamepads();
		const pad = pads ? pads.find( ( g ) => g && g.connected ) : null;
		if ( ! pad ) return;

		const bPressed = !! ( pad.buttons[ 0 ] && pad.buttons[ 0 ].pressed );
		const aPressed = !! ( pad.buttons[ 1 ] && pad.buttons[ 1 ].pressed );

		if ( bPressed && ! prevButtons[ 0 ] ) {

			activeCamera = cameraPerspective; // B = perspective (upstream P key)
			activeHelper = cameraPerspectiveHelper;
			globalThis.__cameraActiveKind = 'perspective';

		}

		if ( aPressed && ! prevButtons[ 1 ] ) {

			activeCamera = cameraOrtho; // A = orthographic (upstream O key)
			activeHelper = cameraOrthoHelper;
			globalThis.__cameraActiveKind = 'orthographic';

		}

		prevButtons[ 0 ] = bPressed;
		prevButtons[ 1 ] = aPressed;

	}

	//

	function animate() {

		requestAnimationFrame( animate );

		globalThis.__cameraAnimateCalled = true;
		globalThis.__cameraFrameCount = ( globalThis.__cameraFrameCount | 0 ) + 1;

		pollGamepad(); // SWB: replaces upstream's keydown listener

		render();

		// Replaces upstream `stats.update()` — accumulate frames over a
		// 3-second window for the status panel.
		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {

			globalThis.__cameraFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;

		}

	}


	function render() {

		const r = Date.now() * 0.0005;

		mesh.position.x = 700 * Math.cos( r );
		mesh.position.z = 700 * Math.sin( r );
		mesh.position.y = 700 * Math.sin( r );

		mesh.children[ 0 ].position.x = 70 * Math.cos( 2 * r );
		mesh.children[ 0 ].position.z = 70 * Math.sin( r );

		if ( activeCamera === cameraPerspective ) {

			cameraPerspective.fov = 35 + 30 * Math.sin( 0.5 * r );
			cameraPerspective.far = mesh.position.length();
			cameraPerspective.updateProjectionMatrix();

			cameraPerspectiveHelper.update();
			cameraPerspectiveHelper.visible = true;

			cameraOrthoHelper.visible = false;

		} else {

			cameraOrtho.far = mesh.position.length();
			cameraOrtho.updateProjectionMatrix();

			cameraOrthoHelper.update();
			cameraOrthoHelper.visible = true;

			cameraPerspectiveHelper.visible = false;

		}

		cameraRig.lookAt( mesh.position );

		//

		activeHelper.visible = false;

		// SWB ordering note: resetState() comes BEFORE setScissor /
		// setViewport / setClearColor / setScissorTest, not after. The
		// reset clobbers all four state slots back to GL defaults, so
		// the upstream order would erase the configuration Three.js
		// just set up.
		renderer.resetState();
		renderer.setScissorTest( true );
		renderer.setClearColor( 0x000000, 1 );
		renderer.setScissor( 0, 0, SCREEN_WIDTH / 2, SCREEN_HEIGHT );
		renderer.setViewport( 0, 0, SCREEN_WIDTH / 2, SCREEN_HEIGHT );
		renderer.render( scene, activeCamera );

		//

		activeHelper.visible = true;

		renderer.resetState();
		renderer.setScissorTest( true );
		renderer.setClearColor( 0x111111, 1 );
		renderer.setScissor( SCREEN_WIDTH / 2, 0, SCREEN_WIDTH / 2, SCREEN_HEIGHT );
		renderer.setViewport( SCREEN_WIDTH / 2, 0, SCREEN_WIDTH / 2, SCREEN_HEIGHT );
		renderer.render( scene, camera );

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__cameraError ) {

		globalThis.__cameraError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
