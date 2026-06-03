// Three.js r162 webgl_geometry_dynamic example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_geometry_dynamic.html
//
// Adapted as 1:1 to upstream as possible. Deviations enumerated:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__` from a
//      separate <script> tag.
//   2. Fixed-size 640x360 canvas; setPixelRatio / window.innerWidth /
//      resize listener / document.body.appendChild dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. `TextureLoader` -> Image + OffscreenCanvas + DataTexture pipeline,
//      since nx.js's `texImage2D` only accepts buffer sources. Image src
//      points at the SDMC path (brewser:// scheme rejected by Image).
//   7. `texture.generateMipmaps = false` + min/magFilter = LinearFilter
//      to avoid mipmap-filter enums nx.js rejects.
//   8. `FirstPersonControls` (DOM pointer/key based) -> gamepad-driven
//      `SwitchFirstPersonControls` from libs/first-person-controls.js.
//      Mapping: right stick = look, B = forward, A = backward, left
//      stick = analog strafe + forward/back override.
//   9. `Stats` dropped (no DOM).

globalThis.__dynamicMainStarted = true;
globalThis.__dynamicAnimateCalled = false;
globalThis.__dynamicError = null;
globalThis.__dynamicTextureLoaded = false;
globalThis.__dynamicVertexCount = 0;
globalThis.__dynamicFrameCount = 0;
globalThis.__dynamicFps = 0;
globalThis.__dynamicCameraPos = '';

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__dynamicError = 'THREE not loaded - is libs/three.iife.js missing?';
		throw new Error('no THREE');
	}
	const SwitchFirstPersonControls = globalThis.SwitchFirstPersonControls;
	if (!SwitchFirstPersonControls) {
		globalThis.__dynamicError = 'FPC not loaded - is libs/first-person-controls.js missing?';
		throw new Error('no FPC');
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
	const dynamicCanvasEl = document.getElementById('dynamic-canvas');
	const SCREEN_WIDTH = (dynamicCanvasEl && dynamicCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (dynamicCanvasEl && dynamicCanvasEl.height) || 360;

	let camera, controls, scene, renderer;
	let mesh, geometry, material, clock;

	const worldWidth = 128, worldDepth = 128;

	const canvas = document.getElementById('dynamic-canvas');
	if (!canvas) {
		globalThis.__dynamicError = '#dynamic-canvas missing in HTML';
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
		globalThis.__dynamicError = 'WebGL acquire failed';
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

	// SWB-specific: load water.jpg and wrap as a DataTexture.
	async function loadWaterTexture() {
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = (e) => reject(new Error('image load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
			img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-geometry-dynamic/assets/water.jpg';
		});
		const tw = img.width;
		const th = img.height;
		const off = new OffscreenCanvas(tw, th);
		const oc = off.getContext('2d');
		oc.drawImage(img, 0, 0);
		const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
		const tex = new THREE.DataTexture(pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
		tex.wrapS = THREE.RepeatWrapping;
		tex.wrapT = THREE.RepeatWrapping;
		tex.repeat.set(5, 5);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;
		globalThis.__dynamicTextureLoaded = true;
		return tex;
	}

	await initAsync();
	animate();

	async function initAsync() {

		camera = new THREE.PerspectiveCamera( 60, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 20000 );
		camera.position.y = 200;

		clock = new THREE.Clock();

		scene = new THREE.Scene();
		scene.background = new THREE.Color( 0xaaccff );
		scene.fog = new THREE.FogExp2( 0xaaccff, 0.0007 );

		geometry = new THREE.PlaneGeometry( 20000, 20000, worldWidth - 1, worldDepth - 1 );
		geometry.rotateX( - Math.PI / 2 );

		const position = geometry.attributes.position;
		position.usage = THREE.DynamicDrawUsage;

		for ( let i = 0; i < position.count; i ++ ) {

			const y = 35 * Math.sin( i / 2 );
			position.setY( i, y );

		}

		globalThis.__dynamicVertexCount = position.count;

		const texture = await loadWaterTexture();

		material = new THREE.MeshBasicMaterial( { color: 0x0044ff, map: texture } );

		mesh = new THREE.Mesh( geometry, material );
		scene.add( mesh );

		renderer = new THREE.WebGLRenderer({
			canvas: canvas, context: context, antialias: false,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		});
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		controls = new SwitchFirstPersonControls( THREE, camera );

		controls.movementSpeed = 500;
		controls.lookSpeed = 0.1;

	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__dynamicAnimateCalled = true;
		globalThis.__dynamicFrameCount = ( globalThis.__dynamicFrameCount | 0 ) + 1;

		render();

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__dynamicFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
			const p = camera.position;
			globalThis.__dynamicCameraPos =
				p.x.toFixed(0) + ', ' + p.y.toFixed(0) + ', ' + p.z.toFixed(0);
		}

	}

	function render() {

		const delta = clock.getDelta();
		const time = clock.getElapsedTime() * 10;

		const position = geometry.attributes.position;

		for ( let i = 0; i < position.count; i ++ ) {

			const y = 35 * Math.sin( i / 5 + ( time + i ) / 7 );
			position.setY( i, y );

		}

		position.needsUpdate = true;

		controls.update( delta );
		renderer.resetState();
		renderer.render( scene, camera );

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__dynamicError ) {

		globalThis.__dynamicError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
