// Three.js r162 webgl_materials_blending example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_materials_blending.html
//
// Adapted as 1:1 to upstream as possible. Pre-authorized deviations:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Fixed 640x360 canvas; window/resize/setPixelRatio dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. `TextureLoader` -> Image + OffscreenCanvas + DataTexture pipeline.
//   7. `Image.src` -> sdmc: path.
//   8. `CanvasTexture(canvas)` -> OffscreenCanvas + getImageData + DataTexture
//      (Three.js's CanvasTexture path uploads via texImage2D(canvas) which
//      nx.js doesn't support).
//   9. `ctx.font='bold 12pt arial'` -> bold synthesized via double-draw at
//      +1px x-offset (nx.js font registers strict-style FontFace; bold/italic
//      silently fall back to plain — see nxjs-font-no-bold-italic memory).
//      User-pre-authorized for this milestone.
//
// Upstream-faithful where untested: `scene.background = mapBg` is set
// directly (Three.js's WebGLBackground path). If the bridge can't render
// it (custom shader / `t2D` sampler name / etc.), the demo falls back to a
// solid color and the bg is documented as a follow-up. Either way the
// 5x5 mesh grid is the milestone's primary surface.

globalThis.__blendingMainStarted = true;
globalThis.__blendingAnimateCalled = false;
globalThis.__blendingError = null;
globalThis.__blendingTexturesLoaded = 0;
globalThis.__blendingMeshCount = 0;
globalThis.__blendingFrameCount = 0;
globalThis.__blendingFps = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__blendingError = 'THREE not loaded - is libs/three.iife.js missing?';
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
	const blendingCanvasEl = document.getElementById('blending-canvas');
	const SCREEN_WIDTH = (blendingCanvasEl && blendingCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (blendingCanvasEl && blendingCanvasEl.height) || 360;

	let camera, scene, renderer;
	let mapBg;

	const canvas = document.getElementById('blending-canvas');
	if (!canvas) {
		globalThis.__blendingError = '#blending-canvas missing in HTML';
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
		globalThis.__blendingError = 'WebGL acquire failed';
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

	const ASSET_BASE = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-materials-blending/assets/';

	// Replaces upstream's `textureLoader.load(url, assignSRGB)` per
	// deviation #6/#7. Image bypasses globalThis.fetch in nx.js so the URL
	// must be sdmc:, not brewser://.
	async function loadImageTexture(filename) {
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = (e) => reject(new Error('image load failed: ' + filename + ' ' + ((e && e.error && e.error.message) || 'unknown')));
			img.src = ASSET_BASE + filename;
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
		tex.flipY = true;
		tex.needsUpdate = true;
		globalThis.__blendingTexturesLoaded = (globalThis.__blendingTexturesLoaded | 0) + 1;
		return tex;
	}

	// Replaces upstream's CanvasTexture(canvas) per deviation #8.
	// Draws into an OffscreenCanvas with the given paint callback, then
	// snapshots via getImageData -> DataTexture.
	// flipY=true matches upstream's CanvasTexture default — DataTexture's
	// default is flipY=false which would render labels upside-down.
	function makeCanvasTexture(width, height, paint) {
		const off = new OffscreenCanvas(width, height);
		const oc = off.getContext('2d');
		paint(oc, width, height);
		const pixels = new Uint8Array(oc.getImageData(0, 0, width, height).data.buffer);
		const tex = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;
		tex.flipY = true;
		tex.needsUpdate = true;
		return tex;
	}

	await initAsync();
	animate();

	async function initAsync() {

		// CAMERA

		camera = new THREE.PerspectiveCamera( 70, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 1000 );
		camera.position.z = 600;

		// SCENE

		scene = new THREE.Scene();

		// BACKGROUND

		mapBg = makeCanvasTexture( 128, 128, ( ctx, w, h ) => {
			ctx.fillStyle = '#ddd';
			ctx.fillRect( 0, 0, 128, 128 );
			ctx.fillStyle = '#555';
			ctx.fillRect( 0, 0, 64, 64 );
			ctx.fillStyle = '#999';
			ctx.fillRect( 32, 32, 32, 32 );
			ctx.fillStyle = '#555';
			ctx.fillRect( 64, 64, 64, 64 );
			ctx.fillStyle = '#777';
			ctx.fillRect( 96, 96, 32, 32 );
		} );
		mapBg.wrapS = mapBg.wrapT = THREE.RepeatWrapping;
		mapBg.repeat.set( 64, 32 );

		scene.background = mapBg;

		// OBJECTS

		const blendings = [
			{ name: 'No', constant: THREE.NoBlending },
			{ name: 'Normal', constant: THREE.NormalBlending },
			{ name: 'Additive', constant: THREE.AdditiveBlending },
			{ name: 'Subtractive', constant: THREE.SubtractiveBlending },
			{ name: 'Multiply', constant: THREE.MultiplyBlending }
		];

		const map0 = await loadImageTexture( 'uv_grid_opengl.jpg' );
		const map1 = await loadImageTexture( 'sprite0.jpg' );
		const map2 = await loadImageTexture( 'sprite0.png' );
		const map3 = await loadImageTexture( 'lensflare0.png' );
		const map4 = await loadImageTexture( 'lensflare0_alpha.png' );

		const geo1 = new THREE.PlaneGeometry( 100, 100 );
		const geo2 = new THREE.PlaneGeometry( 100, 25 );

		addImageRow( map0, 300 );
		addImageRow( map1, 150 );
		addImageRow( map2, 0 );
		addImageRow( map3, - 150 );
		addImageRow( map4, - 300 );

		function addImageRow( map, y ) {

			for ( let i = 0; i < blendings.length; i ++ ) {

				const blending = blendings[ i ];

				const material = new THREE.MeshBasicMaterial( { map: map } );
				material.transparent = true;
				material.blending = blending.constant;

				const x = ( i - blendings.length / 2 ) * 110;
				const z = 0;

				let mesh = new THREE.Mesh( geo1, material );
				mesh.position.set( x, y, z );
				scene.add( mesh );

				mesh = new THREE.Mesh( geo2, generateLabelMaterial( blending.name ) );
				mesh.position.set( x, y - 75, z );
				scene.add( mesh );

			}

		}

		let meshCount = 0;
		scene.traverse( ( o ) => { if ( o.isMesh ) meshCount++; } );
		globalThis.__blendingMeshCount = meshCount;

		// RENDERER

		renderer = new THREE.WebGLRenderer({
			canvas: canvas, context: context, antialias: false,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		});
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

	}

	function generateLabelMaterial( text ) {

		// Upstream: 128x32 canvas with black bg + 'bold 12pt arial' white
		// text. nx.js's font system silently drops bold/italic (see
		// nxjs-font-no-bold-italic memory), so we synthesize bold via
		// double-draw at +1px x-offset per user direction for this milestone.
		const map = makeCanvasTexture( 128, 32, ( ctx, w, h ) => {

			ctx.fillStyle = 'rgba( 0, 0, 0, 0.95 )';
			ctx.fillRect( 0, 0, 128, 32 );

			ctx.fillStyle = 'white';
			ctx.font = '16px sans-serif';
			// Synthesize bold: double-draw at slight x-offset.
			ctx.fillText( text, 10, 22 );
			ctx.fillText( text, 11, 22 );

		} );

		const material = new THREE.MeshBasicMaterial( { map: map, transparent: true } );

		return material;

	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__blendingAnimateCalled = true;
		globalThis.__blendingFrameCount = ( globalThis.__blendingFrameCount | 0 ) + 1;

		const time = Date.now() * 0.00025;
		const ox = ( time * - 0.01 * mapBg.repeat.x ) % 1;
		const oy = ( time * - 0.01 * mapBg.repeat.y ) % 1;

		mapBg.offset.set( ox, oy );

		renderer.resetState();
		renderer.render( scene, camera );

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__blendingFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__blendingError ) {

		globalThis.__blendingError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
