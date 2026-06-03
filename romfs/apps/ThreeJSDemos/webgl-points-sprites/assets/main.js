// Three.js r162 webgl_points_sprites example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_points_sprites.html
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
//   8. Mouse-follow camera -> right-stick gamepad (left stick also works);
//      pointer events not exposed on nx.js.
//   9. `Stats` and `lil-gui` toggle dropped (texture always-on).

globalThis.__pointsMainStarted = true;
globalThis.__pointsAnimateCalled = false;
globalThis.__pointsError = null;
globalThis.__pointsSpritesLoaded = 0;
globalThis.__pointsInstanceCount = 0;
globalThis.__pointsPerInstance = 0;
globalThis.__pointsFrameCount = 0;
globalThis.__pointsFps = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__pointsError = 'THREE not loaded - is libs/three.iife.js missing?';
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
	const pointsCanvasEl = document.getElementById('points-canvas');
	const SCREEN_WIDTH = (pointsCanvasEl && pointsCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (pointsCanvasEl && pointsCanvasEl.height) || 360;

	let camera, scene, renderer;
	const materials = [];
	let parameters;

	// Upstream tracks mouseX/mouseY for camera follow. We substitute
	// gamepad stick deflection × half-window-extent, so the camera moves
	// over the same range as the original would.
	let mouseX = 0, mouseY = 0;

	const canvas = document.getElementById('points-canvas');
	if (!canvas) {
		globalThis.__pointsError = '#points-canvas missing in HTML';
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
		globalThis.__pointsError = 'WebGL acquire failed';
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

	// SWB-specific: load a snowflake PNG and wrap as a DataTexture.
	async function loadSpriteTexture(filename) {
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = (e) => reject(new Error('image load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
			img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-points-sprites/assets/' + filename;
		});
		const tw = img.width;
		const th = img.height;
		const off = new OffscreenCanvas(tw, th);
		const oc = off.getContext('2d');
		oc.drawImage(img, 0, 0);
		const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
		const tex = new THREE.DataTexture(pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;
		globalThis.__pointsSpritesLoaded = (globalThis.__pointsSpritesLoaded | 0) + 1;
		return tex;
	}

	await initAsync();
	animate();

	async function initAsync() {

		camera = new THREE.PerspectiveCamera( 75, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 2000 );
		camera.position.z = 1000;

		scene = new THREE.Scene();
		scene.fog = new THREE.FogExp2( 0x000000, 0.0008 );

		const geometry = new THREE.BufferGeometry();
		const vertices = [];

		const [ sprite1, sprite2, sprite3, sprite4, sprite5 ] = await Promise.all([
			loadSpriteTexture( 'snowflake1.png' ),
			loadSpriteTexture( 'snowflake2.png' ),
			loadSpriteTexture( 'snowflake3.png' ),
			loadSpriteTexture( 'snowflake4.png' ),
			loadSpriteTexture( 'snowflake5.png' ),
		]);

		for ( let i = 0; i < 10000; i ++ ) {

			const x = Math.random() * 2000 - 1000;
			const y = Math.random() * 2000 - 1000;
			const z = Math.random() * 2000 - 1000;

			vertices.push( x, y, z );

		}

		geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
		globalThis.__pointsPerInstance = 10000;

		parameters = [
			[[ 1.0, 0.2, 0.5 ], sprite2, 20 ],
			[[ 0.95, 0.1, 0.5 ], sprite3, 15 ],
			[[ 0.90, 0.05, 0.5 ], sprite1, 10 ],
			[[ 0.85, 0, 0.5 ], sprite5, 8 ],
			[[ 0.80, 0, 0.5 ], sprite4, 5 ]
		];

		for ( let i = 0; i < parameters.length; i ++ ) {

			const color = parameters[ i ][ 0 ];
			const sprite = parameters[ i ][ 1 ];
			const size = parameters[ i ][ 2 ];

			materials[ i ] = new THREE.PointsMaterial( { size: size, map: sprite, blending: THREE.AdditiveBlending, depthTest: false, transparent: true } );
			materials[ i ].color.setHSL( color[ 0 ], color[ 1 ], color[ 2 ], THREE.SRGBColorSpace );

			const particles = new THREE.Points( geometry, materials[ i ] );

			particles.rotation.x = Math.random() * 6;
			particles.rotation.y = Math.random() * 6;
			particles.rotation.z = Math.random() * 6;

			scene.add( particles );

		}

		globalThis.__pointsInstanceCount = parameters.length;

		renderer = new THREE.WebGLRenderer({
			canvas: canvas, context: context, antialias: false,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		});
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

	}

	function pollGamepad() {
		const pads = navigator.getGamepads ? navigator.getGamepads() : null;
		if (!pads) return;
		for (let i = 0; i < pads.length; i++) {
			const p = pads[i];
			if (!p || !p.connected) continue;
			// Read both sticks — whichever is deflected drives the camera.
			// Deadzone 0.15, scale by half-window-extent so the camera
			// covers the same range upstream's mouse would.
			const ax = (p.axes[0] || 0);
			const ay = (p.axes[1] || 0);
			const rx = (p.axes[2] || 0);
			const ry = (p.axes[3] || 0);
			const dz = 0.15;
			const dx = Math.abs(rx) > dz ? rx : (Math.abs(ax) > dz ? ax : 0);
			const dy = Math.abs(ry) > dz ? ry : (Math.abs(ay) > dz ? ay : 0);
			mouseX = dx * (SCREEN_WIDTH / 2);
			mouseY = dy * (SCREEN_HEIGHT / 2);
			return;
		}
	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__pointsAnimateCalled = true;
		globalThis.__pointsFrameCount = ( globalThis.__pointsFrameCount | 0 ) + 1;

		render();

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__pointsFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		const time = Date.now() * 0.00005;

		pollGamepad();

		camera.position.x += ( mouseX - camera.position.x ) * 0.05;
		camera.position.y += ( - mouseY - camera.position.y ) * 0.05;

		camera.lookAt( scene.position );

		for ( let i = 0; i < scene.children.length; i ++ ) {

			const object = scene.children[ i ];

			if ( object instanceof THREE.Points ) {

				object.rotation.y = time * ( i < 4 ? i + 1 : - ( i + 1 ) );

			}

		}

		for ( let i = 0; i < materials.length; i ++ ) {

			const color = parameters[ i ][ 0 ];

			const h = ( 360 * ( color[ 0 ] + time ) % 360 ) / 360;
			materials[ i ].color.setHSL( h, color[ 1 ], color[ 2 ], THREE.SRGBColorSpace );

		}

		renderer.resetState();
		renderer.render( scene, camera );

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__pointsError ) {

		globalThis.__pointsError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
