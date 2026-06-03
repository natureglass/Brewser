// Three.js r162 webgl_interactive_cubes example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_interactive_cubes.html
//
// Adapted as 1:1 to upstream as possible. Pre-authorized deviations:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Fixed 640x360 canvas; window/resize/setPixelRatio dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. `Stats` dropped.
//   7. **Cube count reduced from 2000 to 200** (user-pre-authorized for
//      this milestone — bridge per-mesh dispatch can't sustain playable
//      FPS at 2000; targeting ~30 FPS at 200).
//   8. **Mouse pointer replaced with right analog stick polling**
//      (per [[swb-threejs-misc-controls-orbit]] pattern). Stick deflection
//      maps linearly to pointer NDC coords (-1..1).
//
// Bridge requirement: this milestone forced adding `emissive` uniform
// support to both bridge programs (recognized name + per-program
// `u_emissive` uniform + additive fragment-shader compose). Without it,
// the hover-highlight effect would render invisible. See
// [[bridge-lighting-support]] (extended) and milestone log.

globalThis.__cubesMainStarted = true;
globalThis.__cubesAnimateCalled = false;
globalThis.__cubesError = null;
globalThis.__cubesMeshCount = 0;
globalThis.__cubesFrameCount = 0;
globalThis.__cubesFps = 0;
globalThis.__cubesPointerX = 0;
globalThis.__cubesPointerY = 0;
globalThis.__cubesHoverId = null;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__cubesError = 'THREE not loaded - is libs/three.iife.js missing?';
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
	const cubesCanvasEl = document.getElementById('cubes-canvas');
	const SCREEN_WIDTH = (cubesCanvasEl && cubesCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (cubesCanvasEl && cubesCanvasEl.height) || 360;
	const CUBE_COUNT = 200;  // upstream 2000 — see deviation #7

	let stats;
	let camera, scene, raycaster, renderer;
	let INTERSECTED;
	let theta = 0;

	const pointer = new THREE.Vector2();
	const radius = 5;

	const canvas = document.getElementById('cubes-canvas');
	if (!canvas) {
		globalThis.__cubesError = '#cubes-canvas missing in HTML';
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
		globalThis.__cubesError = 'WebGL acquire failed';
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

		camera = new THREE.PerspectiveCamera( 70, SCREEN_WIDTH / SCREEN_HEIGHT, 0.1, 100 );

		scene = new THREE.Scene();
		scene.background = new THREE.Color( 0xf0f0f0 );

		const light = new THREE.DirectionalLight( 0xffffff, 3 );
		light.position.set( 1, 1, 1 ).normalize();
		scene.add( light );

		const geometry = new THREE.BoxGeometry();

		for ( let i = 0; i < CUBE_COUNT; i ++ ) {

			const object = new THREE.Mesh( geometry, new THREE.MeshLambertMaterial( { color: Math.random() * 0xffffff } ) );

			object.position.x = Math.random() * 40 - 20;
			object.position.y = Math.random() * 40 - 20;
			object.position.z = Math.random() * 40 - 20;

			object.rotation.x = Math.random() * 2 * Math.PI;
			object.rotation.y = Math.random() * 2 * Math.PI;
			object.rotation.z = Math.random() * 2 * Math.PI;

			object.scale.x = Math.random() + 0.5;
			object.scale.y = Math.random() + 0.5;
			object.scale.z = Math.random() + 0.5;

			scene.add( object );

		}

		raycaster = new THREE.Raycaster();

		renderer = new THREE.WebGLRenderer({
			canvas: canvas, context: context, antialias: false,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		});
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		let meshCount = 0;
		scene.traverse((o) => { if (o.isMesh) meshCount++; });
		globalThis.__cubesMeshCount = meshCount;

	}

	// Replaces upstream's `document.addEventListener('mousemove', ...)` per
	// deviation #8. Polls gamepad right stick each frame; deflection maps
	// linearly to NDC pointer coords [-1, 1]. Dead-zone of 0.05.
	function pollPointerFromGamepad() {
		const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
		const pad = pads[0];
		if (!pad) return;
		const ax = pad.axes;
		if (!ax || ax.length < 4) return;
		let rx = ax[2] || 0;
		let ry = ax[3] || 0;
		const dz = 0.05;
		if (Math.abs(rx) < dz) rx = 0;
		if (Math.abs(ry) < dz) ry = 0;
		// Stick X+ → pointer X+, stick Y+ (typically down) → pointer Y- (up).
		pointer.x = Math.max(-1, Math.min(1, rx));
		pointer.y = Math.max(-1, Math.min(1, -ry));
		globalThis.__cubesPointerX = pointer.x;
		globalThis.__cubesPointerY = pointer.y;
	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__cubesAnimateCalled = true;
		globalThis.__cubesFrameCount = ( globalThis.__cubesFrameCount | 0 ) + 1;

		pollPointerFromGamepad();
		render();

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__cubesFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		theta += 0.1;

		camera.position.x = radius * Math.sin( THREE.MathUtils.degToRad( theta ) );
		camera.position.y = radius * Math.sin( THREE.MathUtils.degToRad( theta ) );
		camera.position.z = radius * Math.cos( THREE.MathUtils.degToRad( theta ) );
		camera.lookAt( scene.position );

		camera.updateMatrixWorld();

		// find intersections

		raycaster.setFromCamera( pointer, camera );

		const intersects = raycaster.intersectObjects( scene.children, false );

		if ( intersects.length > 0 ) {

			if ( INTERSECTED != intersects[ 0 ].object ) {

				if ( INTERSECTED ) INTERSECTED.material.emissive.setHex( INTERSECTED.currentHex );

				INTERSECTED = intersects[ 0 ].object;
				INTERSECTED.currentHex = INTERSECTED.material.emissive.getHex();
				INTERSECTED.material.emissive.setHex( 0xff0000 );
				globalThis.__cubesHoverId = INTERSECTED.id;

			}

		} else {

			if ( INTERSECTED ) INTERSECTED.material.emissive.setHex( INTERSECTED.currentHex );

			INTERSECTED = null;
			globalThis.__cubesHoverId = null;

		}

		renderer.resetState();
		renderer.render( scene, camera );

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__cubesError ) {

		globalThis.__cubesError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
