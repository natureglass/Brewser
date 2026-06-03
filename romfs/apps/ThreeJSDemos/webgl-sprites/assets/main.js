// Three.js r162 webgl_sprites example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_sprites.html
//
// Adapted as 1:1 to upstream as possible. Deviations enumerated:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__` from a
//      separate <script> tag.
//   2. Fixed-size 640x360 canvas; setPixelRatio / window.innerWidth /
//      resize listener / document.body.appendChild dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render (TWICE per
//      frame since two render passes — perspective + ortho HUD).
//   6. `TextureLoader` -> Image + OffscreenCanvas + DataTexture pipeline,
//      since nx.js's `texImage2D` only accepts buffer sources. Image src
//      points at the SDMC path (brewser:// scheme rejected). Done for all
//      3 sprite PNGs.
//   7. `texture.generateMipmaps = false` + min/magFilter = LinearFilter
//      to avoid mipmap-filter enums nx.js rejects.
//   8. Sprite count reduced from upstream's 200 to 80. The bridge's
//      per-draw overhead (uniform uploads, state changes, framebuffer
//      bind) caps us at ~10 FPS for 200 textured draws/frame. 80 lands
//      around 30 FPS. Same pattern as milestone #5 (500 cones -> 120).

globalThis.__spritesMainStarted = true;
globalThis.__spritesAnimateCalled = false;
globalThis.__spritesError = null;
globalThis.__spritesTexturesLoaded = 0;
globalThis.__spritesOrbitCount = 0;
globalThis.__spritesHudCount = 0;
globalThis.__spritesFrameCount = 0;
globalThis.__spritesFps = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__spritesError = 'THREE not loaded - is libs/three.iife.js missing?';
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
	const spritesCanvasEl = document.getElementById('sprites-canvas');
	const SCREEN_WIDTH = (spritesCanvasEl && spritesCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (spritesCanvasEl && spritesCanvasEl.height) || 360;

	let camera, scene, renderer;
	let cameraOrtho, sceneOrtho;
	let spriteTL, spriteTR, spriteBL, spriteBR, spriteC;
	let mapC;
	let group;

	const canvas = document.getElementById('sprites-canvas');
	if (!canvas) {
		globalThis.__spritesError = '#sprites-canvas missing in HTML';
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
		globalThis.__spritesError = 'WebGL acquire failed';
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

	// SWB-specific: load a sprite PNG and wrap as a DataTexture.
	async function loadSpriteTexture(filename) {
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = (e) => reject(new Error('image load failed: ' + ((e && e.error && e.error.message) || 'unknown')));
			img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-sprites/assets/' + filename;
		});
		const tw = img.width;
		const th = img.height;
		const off = new OffscreenCanvas(tw, th);
		const oc = off.getContext('2d');
		oc.drawImage(img, 0, 0);
		const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
		const tex = new THREE.DataTexture(pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType);
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;
		globalThis.__spritesTexturesLoaded = (globalThis.__spritesTexturesLoaded | 0) + 1;
		return tex;
	}

	await initAsync();
	animate();

	async function initAsync() {

		// Load all 3 sprite textures up front (in parallel).
		const [mapA, mapB, mapCloaded] = await Promise.all([
			loadSpriteTexture('sprite0.png'),
			loadSpriteTexture('sprite1.png'),
			loadSpriteTexture('sprite2.png'),
		]);

		const width = SCREEN_WIDTH;
		const height = SCREEN_HEIGHT;

		camera = new THREE.PerspectiveCamera( 60, width / height, 1, 2100 );
		camera.position.z = 1500;

		cameraOrtho = new THREE.OrthographicCamera( - width / 2, width / 2, height / 2, - height / 2, 1, 10 );
		cameraOrtho.position.z = 10;

		scene = new THREE.Scene();
		scene.fog = new THREE.Fog( 0x000000, 1500, 2100 );

		sceneOrtho = new THREE.Scene();

		// create sprites

		// SWB deviation: upstream uses 200; reduced to 80 to maintain
		// ~30 FPS within the bridge's per-draw overhead budget.
		const amount = 80;
		const radius = 500;

		mapC = mapCloaded;
		mapB.colorSpace = THREE.SRGBColorSpace;
		mapC.colorSpace = THREE.SRGBColorSpace;

		group = new THREE.Group();

		const materialC = new THREE.SpriteMaterial( { map: mapC, color: 0xffffff, fog: true } );
		const materialB = new THREE.SpriteMaterial( { map: mapB, color: 0xffffff, fog: true } );

		for ( let a = 0; a < amount; a ++ ) {

			const x = Math.random() - 0.5;
			const y = Math.random() - 0.5;
			const z = Math.random() - 0.5;

			let material;

			if ( z < 0 ) {

				material = materialB.clone();

			} else {

				material = materialC.clone();
				material.color.setHSL( 0.5 * Math.random(), 0.75, 0.5 );
				material.map.offset.set( - 0.5, - 0.5 );
				material.map.repeat.set( 2, 2 );

			}

			const sprite = new THREE.Sprite( material );

			sprite.position.set( x, y, z );
			sprite.position.normalize();
			sprite.position.multiplyScalar( radius );

			group.add( sprite );

		}

		scene.add( group );
		globalThis.__spritesOrbitCount = amount;

		// renderer

		renderer = new THREE.WebGLRenderer({
			canvas: canvas, context: context, antialias: false,
			alpha: false, depth: true, stencil: false,
			preserveDrawingBuffer: false, powerPreference: 'default',
			failIfMajorPerformanceCaveat: false,
		});
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );
		renderer.autoClear = false; // To allow render overlay on top of sprited sphere

		// HUD sprites (mapA = sprite0.png — the loader callback in upstream).
		createHUDSprites( mapA );

	}

	function createHUDSprites( texture ) {

		texture.colorSpace = THREE.SRGBColorSpace;

		const material = new THREE.SpriteMaterial( { map: texture } );

		const width = material.map.image ? material.map.image.width : texture.image.width;
		const height = material.map.image ? material.map.image.height : texture.image.height;

		spriteTL = new THREE.Sprite( material );
		spriteTL.center.set( 0.0, 1.0 );
		spriteTL.scale.set( width, height, 1 );
		sceneOrtho.add( spriteTL );

		spriteTR = new THREE.Sprite( material );
		spriteTR.center.set( 1.0, 1.0 );
		spriteTR.scale.set( width, height, 1 );
		sceneOrtho.add( spriteTR );

		spriteBL = new THREE.Sprite( material );
		spriteBL.center.set( 0.0, 0.0 );
		spriteBL.scale.set( width, height, 1 );
		sceneOrtho.add( spriteBL );

		spriteBR = new THREE.Sprite( material );
		spriteBR.center.set( 1.0, 0.0 );
		spriteBR.scale.set( width, height, 1 );
		sceneOrtho.add( spriteBR );

		spriteC = new THREE.Sprite( material );
		spriteC.center.set( 0.5, 0.5 );
		spriteC.scale.set( width, height, 1 );
		sceneOrtho.add( spriteC );

		updateHUDSprites();
		globalThis.__spritesHudCount = 5;

	}

	function updateHUDSprites() {

		const width = SCREEN_WIDTH / 2;
		const height = SCREEN_HEIGHT / 2;

		spriteTL.position.set( - width, height, 1 );
		spriteTR.position.set( width, height, 1 );
		spriteBL.position.set( - width, - height, 1 );
		spriteBR.position.set( width, - height, 1 );
		spriteC.position.set( 0, 0, 1 );

	}

	function animate() {

		requestAnimationFrame( animate );
		globalThis.__spritesAnimateCalled = true;
		globalThis.__spritesFrameCount = ( globalThis.__spritesFrameCount | 0 ) + 1;

		render();

		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__spritesFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		const time = Date.now() / 1000;

		for ( let i = 0, l = group.children.length; i < l; i ++ ) {

			const sprite = group.children[ i ];
			const material = sprite.material;
			const scale = Math.sin( time + sprite.position.x * 0.01 ) * 0.3 + 1.0;

			let imageWidth = 1;
			let imageHeight = 1;

			if ( material.map && material.map.image && material.map.image.width ) {

				imageWidth = material.map.image.width;
				imageHeight = material.map.image.height;

			}

			sprite.material.rotation += 0.1 * ( i / l );
			sprite.scale.set( scale * imageWidth, scale * imageHeight, 1.0 );

			if ( material.map !== mapC ) {

				material.opacity = Math.sin( time + sprite.position.x * 0.01 ) * 0.4 + 0.6;

			}

		}

		group.rotation.x = time * 0.5;
		group.rotation.y = time * 0.75;
		group.rotation.z = time * 1.0;

		renderer.resetState();
		renderer.clear();
		renderer.render( scene, camera );
		renderer.resetState();
		renderer.clearDepth();
		renderer.render( sceneOrtho, cameraOrtho );

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__spritesError ) {

		globalThis.__spritesError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
