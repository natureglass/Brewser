// Three.js webgl_texture2darray example — 1:1 port for switch-web-browser.
//
// Source: three-latest/examples/webgl_texture2darray.html (Three.js r184).
//
// Pre-authorized deviations:
//
//   1. Library load: `THREE = globalThis.__THREE_R184_STAGED__` instead
//      of an import map; r184 nx.js shims from libs/r184-nxjs-bridge.js
//      (bypassWebGL1Check + rAF heartbeat).
//   2. Canvas: reuse <canvas id="t2da-canvas">; no
//      `container.appendChild(...)`. setPixelRatio + resize listener
//      dropped.
//   3. WebGL 2 context: explicit `canvas.getContext('webgl2')` with a
//      Proxy whose `constructor.name === 'WebGL2RenderingContext'`.
//   4. `fflate.unzipSync` + `FileLoader` replaced with `Switch.readFile`
//      of a pre-decompressed raw `.bin` (256*256*109 = 7,143,424
//      bytes). Avoids bundling fflate as a new dep + dodges
//      [[r184-fetch-hang]].
//   5. Stats addon dropped.
//   6. console.warn/log/error/info silenced
//      ([[console-error-switches-render-mode]]).
//   7. `renderer.resetState()` before every render
//      ([[threejs-resetstate]]).

globalThis.__t2daError = null;
globalThis.__t2daFps = 0;
globalThis.__t2daFrameCount = 0;
globalThis.__t2daIsWebGL2 = false;
globalThis.__t2daVolumeLoaded = false;
globalThis.__t2daVolumeBytes = 0;
globalThis.__t2daTextureCreated = false;
globalThis.__t2daDepth = undefined;
globalThis.__t2daGlErrorAfter = -1;

( async function run() {
try {

	const THREE = globalThis.__THREE_R184_STAGED__;
	if ( ! THREE ) throw new Error( 'THREE r184 not loaded' );

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const canvas = document.getElementById( 't2da-canvas' );
	if ( ! canvas ) throw new Error( '#t2da-canvas missing' );

	const gl = canvas.getContext( 'webgl2', {
		alpha: false, antialias: false, depth: true,
		stencil: false, preserveDrawingBuffer: false,
	} );
	if ( ! gl ) throw new Error( 'WebGL 2 not supported' );
	globalThis.__t2daIsWebGL2 = true;
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

	// DOM phase-1 smoke test: instantiate Three.js's Stats addon and
	// attach its dom node to document.body. Stats failures must not
	// break the demo — wrap each step and surface the exact failure.
	let stats = null;
	globalThis.__t2daStatsStage = 'not-attempted';
	try {
		globalThis.__t2daStatsStage = 'check-global';
		if ( typeof globalThis.Stats === 'function' ) {
			globalThis.__t2daStatsStage = 'new-Stats';
			stats = new globalThis.Stats();
			globalThis.__t2daStatsStage = 'check-body';
			if ( ! document.body ) throw new Error( 'document.body missing' );
			globalThis.__t2daStatsStage = 'check-appendChild';
			if ( typeof document.body.appendChild !== 'function' ) {
				throw new Error( 'body.appendChild not a function' );
			}
			globalThis.__t2daStatsStage = 'appendChild';
			document.body.appendChild( stats.dom );
			// Diagnostic: capture DPR + panel dims so we can see what's
			// happening on the actual hardware. Font appears oversized
			// vs upstream — likely a PR mismatch between Stats's
			// internal scaling and our overlay's drawImage downscale.
			globalThis.__t2daDpr = ( typeof window !== 'undefined' && window.devicePixelRatio !== undefined )
				? String( window.devicePixelRatio )
				: 'window-undef';
			if ( stats.dom.children && stats.dom.children[ 0 ] ) {
				const p0 = stats.dom.children[ 0 ];
				globalThis.__t2daStatsPanel0 =
					'native ' + p0.width + 'x' + p0.height +
					' display ' + ( p0.style.width || '?' ) + 'x' + ( p0.style.height || '?' );
			}
			globalThis.__t2daStatsStage = 'done';
			globalThis.__t2daStatsAttached = true;
		} else {
			globalThis.__t2daStatsStage = 'Stats-not-global';
		}
	} catch ( e ) {
		globalThis.__t2daStatsError = 'stage=' + globalThis.__t2daStatsStage +
			' err=' + ( e && e.message ? e.message : String( e ) );
		stats = null;
	}

	const planeWidth = 50;
	const planeHeight = 50;

	let depthStep = 0.4;

	let camera, scene, renderer, mesh;

	// Load the pre-decompressed raw volume (no fflate dependency).
	const VOLUME_PATH = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-texture2darray/assets/head256x256x109.bin';
	const buf = await Switch.readFile( VOLUME_PATH );
	const ab = buf instanceof ArrayBuffer
		? buf
		: buf.buffer.slice( buf.byteOffset, buf.byteOffset + buf.byteLength );
	const array = new Uint8Array( ab );
	globalThis.__t2daVolumeLoaded = true;
	globalThis.__t2daVolumeBytes = array.length;
	if ( array.length !== 256 * 256 * 109 ) {
		throw new Error( 'volume size mismatch: ' + array.length +
			' (expected ' + ( 256 * 256 * 109 ) + ')' );
	}

	const texture = new THREE.DataArrayTexture( array, 256, 256, 109 );
	texture.format = THREE.RedFormat;
	texture.needsUpdate = true;
	globalThis.__t2daTextureCreated = true;

	init( texture );

	function init( texture ) {

		camera = new THREE.PerspectiveCamera(
			45, SCREEN_WIDTH / SCREEN_HEIGHT, 0.1, 2000 );
		camera.position.z = 70;

		scene = new THREE.Scene();

		const material = new THREE.ShaderMaterial( {
			uniforms: {
				diffuse: { value: texture },
				depth: { value: 55 },
				size: { value: new THREE.Vector2( planeWidth, planeHeight ) },
			},
			vertexShader: document.getElementById( 'vs' ).textContent.trim(),
			fragmentShader: document.getElementById( 'fs' ).textContent.trim(),
			glslVersion: THREE.GLSL3,
		} );

		const geometry = new THREE.PlaneGeometry( planeWidth, planeHeight );

		mesh = new THREE.Mesh( geometry, material );

		scene.add( mesh );

		bypassWebGL1Check( () => {
			renderer = new THREE.WebGLRenderer( {
				canvas, context,
				alpha: false, depth: true, stencil: false,
				preserveDrawingBuffer: false,
			} );
		} );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );
		renderer.setAnimationLoop( animate );

	}

	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	function animate() {

		try {

			if ( mesh ) {

				let value = mesh.material.uniforms[ 'depth' ].value;

				value += depthStep;

				if ( value > 109.0 || value < 0.0 ) {

					if ( value > 1.0 ) value = 109.0 * 2.0 - value;
					if ( value < 0.0 ) value = - value;

					depthStep = - depthStep;

				}

				mesh.material.uniforms[ 'depth' ].value = value;
				globalThis.__t2daDepth = value;

			}

			if ( stats ) stats.begin();
			renderer.resetState();
			renderer.render( scene, camera );
			if ( stats ) stats.end();

			globalThis.__t2daGlErrorAfter = gl.getError();
			globalThis.__t2daFrameCount = ( globalThis.__t2daFrameCount | 0 ) + 1;
			fpsAccumFrames ++;
			const now = Date.now();
			if ( now - fpsAccumStart >= 3000 ) {
				globalThis.__t2daFps = Math.round( ( fpsAccumFrames * 1000 ) / ( now - fpsAccumStart ) );
				fpsAccumStart = now;
				fpsAccumFrames = 0;
			}

		} catch ( e ) {
			if ( ! globalThis.__t2daError ) {
				globalThis.__t2daError = 'render: ' + ( e && e.message ? e.message : String( e ) );
			}
		}

	}

} catch ( e ) {
	if ( ! globalThis.__t2daError ) {
		globalThis.__t2daError = String( e && e.message ? e.message : e );
	}
}
} )();
