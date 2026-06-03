// Three.js r162 webgl_geometries example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_geometries.html
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
//      since nx.js's `texImage2D` only accepts buffer sources.
//   7. `texture.generateMipmaps = false` + min/magFilter = LinearFilter
//      to avoid mipmap-filter enums nx.js rejects.
//   8. `Stats` dropped.
//
// All geometry segment counts match upstream EXACTLY — user picked
// "match upstream, accept white-face risk" so TetrahedronGeometry(75, 0)
// and CircleGeometry(50, 20, ...) stay at their upstream values. If the
// Tegra TBR per-tile interpolator bug ([[threejs-cube-white-face]])
// shows up on flat faces, that's a known and accepted caveat for this
// milestone.

globalThis.__geometriesMainStarted = true;
globalThis.__geometriesAnimateCalled = false;
globalThis.__geometriesError = null;
globalThis.__geometriesTextureLoaded = false;
globalThis.__geometriesMeshCount = 0;
globalThis.__geometriesFrameCount = 0;
globalThis.__geometriesFps = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__geometriesError = 'THREE not loaded - is libs/three.iife.js missing?';
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
	const geometriesCanvasEl = document.getElementById('geometries-canvas');
	const SCREEN_WIDTH = (geometriesCanvasEl && geometriesCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (geometriesCanvasEl && geometriesCanvasEl.height) || 360;

	let camera, scene, renderer;

	const canvas = document.getElementById('geometries-canvas');
	if (!canvas) {
		globalThis.__geometriesError = '#geometries-canvas missing in HTML';
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
		globalThis.__geometriesError = 'WebGL acquire failed';
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

	// SWB-specific: load the UV grid texture and wrap as DataTexture.
	async function loadUVGridTexture() {
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = (e) => reject(new Error('image load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
			img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-geometries/assets/uv_grid_opengl.jpg';
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
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;
		globalThis.__geometriesTextureLoaded = true;
		return tex;
	}

	await initAsync();
	animate();

	async function initAsync() {

		camera = new THREE.PerspectiveCamera( 45, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 2000 );
		camera.position.y = 400;

		scene = new THREE.Scene();

		let object;

		const ambientLight = new THREE.AmbientLight( 0xcccccc, 1.5 );
		scene.add( ambientLight );

		const pointLight = new THREE.PointLight( 0xffffff, 2.5, 0, 0 );
		camera.add( pointLight );
		scene.add( camera );

		const map = await loadUVGridTexture();

		const material = new THREE.MeshPhongMaterial( { map: map, side: THREE.DoubleSide } );

		//

		object = new THREE.Mesh( new THREE.SphereGeometry( 75, 20, 10 ), material );
		object.position.set( - 300, 0, 200 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.IcosahedronGeometry( 75, 1 ), material );
		object.position.set( - 100, 0, 200 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.OctahedronGeometry( 75, 2 ), material );
		object.position.set( 100, 0, 200 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.TetrahedronGeometry( 75, 0 ), material );
		object.position.set( 300, 0, 200 );
		scene.add( object );

		//

		object = new THREE.Mesh( new THREE.PlaneGeometry( 100, 100, 4, 4 ), material );
		object.position.set( - 300, 0, 0 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.BoxGeometry( 100, 100, 100, 4, 4, 4 ), material );
		object.position.set( - 100, 0, 0 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.CircleGeometry( 50, 20, 0, Math.PI * 2 ), material );
		object.position.set( 100, 0, 0 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.RingGeometry( 10, 50, 20, 5, 0, Math.PI * 2 ), material );
		object.position.set( 300, 0, 0 );
		scene.add( object );

		//

		object = new THREE.Mesh( new THREE.CylinderGeometry( 25, 75, 100, 40, 5 ), material );
		object.position.set( - 300, 0, - 200 );
		scene.add( object );

		const points = [];

		for ( let i = 0; i < 50; i ++ ) {

			points.push( new THREE.Vector2( Math.sin( i * 0.2 ) * Math.sin( i * 0.1 ) * 15 + 50, ( i - 5 ) * 2 ) );

		}

		object = new THREE.Mesh( new THREE.LatheGeometry( points, 20 ), material );
		object.position.set( - 100, 0, - 200 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.TorusGeometry( 50, 20, 20, 20 ), material );
		object.position.set( 100, 0, - 200 );
		scene.add( object );

		object = new THREE.Mesh( new THREE.TorusKnotGeometry( 50, 10, 50, 20 ), material );
		object.position.set( 300, 0, - 200 );
		scene.add( object );

		// Count is 12 spinning meshes + 1 camera = 13 children; report 12.
		let meshCount = 0;
		scene.traverse((o) => { if (o.isMesh) meshCount++; });
		globalThis.__geometriesMeshCount = meshCount;

		renderer = new THREE.WebGLRenderer({
			canvas: canvas, context: context, antialias: false,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		});
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__geometriesAnimateCalled = true;
		globalThis.__geometriesFrameCount = ( globalThis.__geometriesFrameCount | 0 ) + 1;

		render();

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__geometriesFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		const timer = Date.now() * 0.0001;

		camera.position.x = Math.cos( timer ) * 800;
		camera.position.z = Math.sin( timer ) * 800;

		camera.lookAt( scene.position );

		scene.traverse( function ( object ) {

			if ( object.isMesh === true ) {

				object.rotation.x = timer * 5;
				object.rotation.y = timer * 2.5;

			}

		} );

		renderer.resetState();
		renderer.render( scene, camera );

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__geometriesError ) {

		globalThis.__geometriesError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
