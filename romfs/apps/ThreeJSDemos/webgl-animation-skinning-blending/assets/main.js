// Three.js webgl_animation_skinning_blending — 1:1 port for switch-web-browser.
//
// Source: three-latest/examples/webgl_animation_skinning_blending.html
// (Three.js r184).
//
// Pre-authorized deviations (nx.js + r184 platform requirements):
//
//   1. Library load: `THREE = globalThis.__THREE_R184_STAGED__`.
//   2. r184 nx.js shims from libs/r184-nxjs-bridge.js
//      (`bypassWebGL1Check` + rAF heartbeat).
//   3. Canvas reused from <canvas id="skin-canvas">; no
//      `container.appendChild(renderer.domElement)`, no setPixelRatio,
//      no window.innerWidth/Height, no resize listener.
//   4. WebGL 2 context: explicit `canvas.getContext('webgl2')` with the
//      Proxy `constructor.name = 'WebGL2RenderingContext'` trick.
//   5. Stats addon dropped (no DOM; status canvas surfaces FPS).
//   6. Soldier.glb pre-extracted offline into soldier.gltf + soldier.bin
//      + 2 JPGs (nx.js's Image bypasses fetch and can't decode embedded
//      base64 — pre-extract is the standard pattern). GLTFLoader is our
//      in-house libs/gltf-loader.js with `setSdmcModelPath` set so the
//      .gltf + .bin reads go through Switch.readFile (NOT fetch — the
//      r184 IIFE breaks brewser:// fetches per [[r184-fetch-hang]]).
//   7. lil-gui dropped — UI controls mapped to gamepad:
//      A = idle, B = walk, X = run, Y = pause/continue.
//      Up to 1 active action at a time (no blend slider on the pad).
//   8. console.warn/log/error/info silenced
//      ([[console-error-switches-render-mode]]).

globalThis.__skinError = null;
globalThis.__skinIsWebGL2 = false;
globalThis.__skinCapWebGL2 = '(unknown)';
globalThis.__skinFps = 0;
globalThis.__skinFrameCount = 0;
globalThis.__skinModelLoaded = false;
globalThis.__skinSkinnedCount = 0;
globalThis.__skinBoneCount = 0;
globalThis.__skinClipCount = 0;
globalThis.__skinAction = '(none)';

( async function run() {
try {

	const THREE = globalThis.__THREE_R184_STAGED__;
	if ( ! THREE ) throw new Error( 'THREE r184 not loaded' );
	if ( typeof THREE.GLTFLoader !== 'function' ) throw new Error( 'GLTFLoader not loaded' );

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const canvas = document.getElementById( 'skin-canvas' );
	if ( ! canvas ) throw new Error( '#skin-canvas missing' );

	const gl = canvas.getContext( 'webgl2', {
		alpha: false, antialias: true, depth: true,
		stencil: false, preserveDrawingBuffer: false,
	} );
	if ( ! gl ) throw new Error( 'WebGL 2 not supported' );
	globalThis.__skinIsWebGL2 = true;
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

	let scene, renderer, camera, timer;
	let model, skeleton, mixer;
	let idleAction, walkAction, runAction;
	let actions;
	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;
	let prevA = false, prevB = false, prevX = false, prevY = false;

	init();

	function init() {

		camera = new THREE.PerspectiveCamera( 45, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 100 );
		camera.position.set( 1, 2, - 3 );
		camera.lookAt( 0, 1, 0 );

		timer = new THREE.Timer();
		timer.connect( document );

		scene = new THREE.Scene();
		scene.background = new THREE.Color( 0xa0a0a0 );
		scene.fog = new THREE.Fog( 0xa0a0a0, 10, 50 );

		const hemiLight = new THREE.HemisphereLight( 0xffffff, 0x8d8d8d, 3 );
		hemiLight.position.set( 0, 20, 0 );
		scene.add( hemiLight );

		const dirLight = new THREE.DirectionalLight( 0xffffff, 3 );
		dirLight.position.set( - 3, 10, - 10 );
		dirLight.castShadow = true;
		dirLight.shadow.camera.top = 2;
		dirLight.shadow.camera.bottom = - 2;
		dirLight.shadow.camera.left = - 2;
		dirLight.shadow.camera.right = 2;
		dirLight.shadow.camera.near = 0.1;
		dirLight.shadow.camera.far = 40;
		scene.add( dirLight );

		// ground

		const mesh = new THREE.Mesh(
			new THREE.PlaneGeometry( 100, 100 ),
			new THREE.MeshPhongMaterial( { color: 0xcbcbcb, depthWrite: false } )
		);
		mesh.rotation.x = - Math.PI / 2;
		mesh.receiveShadow = true;
		scene.add( mesh );

		const loader = new THREE.GLTFLoader();
		const SDMC_ASSETS =
			'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-animation-skinning-blending/assets/';
		// Switch.readFile path — required under r184 (no globalThis.fetch).
		loader.setSdmcModelPath( SDMC_ASSETS );
		loader.setSdmcImagePath( SDMC_ASSETS );
		loader.load( 'soldier.gltf', function ( gltf ) {

			model = gltf.scene;
			scene.add( model );

			model.traverse( function ( object ) {

				if ( object.isMesh ) object.castShadow = true;
				if ( object.isSkinnedMesh ) {
					globalThis.__skinSkinnedCount =
						( globalThis.__skinSkinnedCount | 0 ) + 1;
					if ( object.skeleton && ! globalThis.__skinBoneCount ) {
						globalThis.__skinBoneCount = object.skeleton.bones.length;
					}
				}

			} );

			//

			skeleton = new THREE.SkeletonHelper( model );
			skeleton.visible = false;
			scene.add( skeleton );

			//

			const animations = gltf.animations;
			globalThis.__skinClipCount = animations.length;

			mixer = new THREE.AnimationMixer( model );

			idleAction = mixer.clipAction( animations[ 0 ] );
			walkAction = mixer.clipAction( animations[ 3 ] );
			runAction = mixer.clipAction( animations[ 1 ] );

			actions = [ idleAction, walkAction, runAction ];

			activateAllActions();
			globalThis.__skinModelLoaded = true;
			globalThis.__skinAction = 'walk';

			renderer.setAnimationLoop( animate );

		} );

		bypassWebGL1Check( () => {
			renderer = new THREE.WebGLRenderer( { canvas, context, antialias: true } );
		} );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );
		renderer.shadowMap.enabled = true;

		globalThis.__skinCapWebGL2 = renderer.capabilities && renderer.capabilities.isWebGL2;

	}

	function setWeight( action, weight ) {

		action.enabled = true;
		action.setEffectiveTimeScale( 1 );
		action.setEffectiveWeight( weight );

	}

	function activateAllActions() {

		// Default weights: idle=0, walk=1, run=0 (matches upstream's
		// `settings['modify * weight']` initialisation).
		setWeight( idleAction, 0 );
		setWeight( walkAction, 1 );
		setWeight( runAction, 0 );

		actions.forEach( function ( action ) {
			action.play();
		} );

	}

	function switchToAction( target, name ) {

		// Pad-driven single-target crossfade. The non-target actions
		// fade out, target fades in — same effect as upstream's
		// `prepareCrossFade` flow but always with a fixed 0.5 s
		// duration (matches the idle→walk default).
		const duration = 0.5;
		actions.forEach( ( other ) => {
			if ( other === target ) return;
			other.crossFadeTo( target, duration, true );
		} );
		setWeight( target, 1 );
		target.time = 0;
		globalThis.__skinAction = name;

	}

	function togglePause() {

		const paused = idleAction.paused;
		actions.forEach( ( action ) => { action.paused = ! paused; } );
		globalThis.__skinAction = ( ! paused ) ? 'paused' : ( globalThis.__skinAction || 'walk' );

	}

	function animate() {

		globalThis.__skinFrameCount = ( globalThis.__skinFrameCount | 0 ) + 1;

		try {

			timer.update();

			// Gamepad input → action switching.
			const pads = navigator.getGamepads ? navigator.getGamepads() : null;
			const pad = ( pads && pads.length ) ? pads[ 0 ] : null;
			if ( pad && mixer ) {
				const a = pad.buttons[ 0 ] && pad.buttons[ 0 ].pressed;
				const b = pad.buttons[ 1 ] && pad.buttons[ 1 ].pressed;
				const x = pad.buttons[ 2 ] && pad.buttons[ 2 ].pressed;
				const y = pad.buttons[ 3 ] && pad.buttons[ 3 ].pressed;
				if ( a && ! prevA ) switchToAction( idleAction, 'idle' );
				if ( b && ! prevB ) switchToAction( walkAction, 'walk' );
				if ( x && ! prevX ) switchToAction( runAction, 'run' );
				if ( y && ! prevY ) togglePause();
				prevA = a; prevB = b; prevX = x; prevY = y;
			}

			// Update the animation mixer and render this frame.
			if ( mixer ) {
				mixer.update( timer.getDelta() );
			}

			renderer.resetState();
			renderer.render( scene, camera );

			fpsAccumFrames ++;
			const now = Date.now();
			if ( now - fpsAccumStart >= 3000 ) {
				globalThis.__skinFps = Math.round( ( fpsAccumFrames * 1000 ) / ( now - fpsAccumStart ) );
				fpsAccumStart = now;
				fpsAccumFrames = 0;
			}

		} catch ( e ) {
			if ( ! globalThis.__skinError ) {
				globalThis.__skinError = String( e && e.message ? e.message : e );
			}
		}

	}

} catch ( e ) {
	if ( ! globalThis.__skinError ) {
		globalThis.__skinError = String( e && e.message ? e.message : e );
	}
}
} )();
