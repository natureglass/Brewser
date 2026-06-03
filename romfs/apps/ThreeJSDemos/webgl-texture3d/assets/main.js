// Three.js webgl_texture3d example — 1:1 port for switch-web-browser.
//
// Source: three-latest/examples/webgl_texture3d.html (Three.js r184).
//
// Pre-authorized deviations (nx.js + r184 platform requirements):
//
//   1. Library load: `THREE = globalThis.__THREE_R184_STAGED__`.
//   2. r184 nx.js shims from libs/r184-nxjs-bridge.js:
//      `loadImageBypass` (Image events suppressed), `bypassWebGL1Check`
//      (instanceof WebGLRenderingContext guard), rAF heartbeat (event
//      loop starvation).
//   3. Canvas reused from <canvas id="t3d-canvas">; no
//      `document.body.appendChild(...)`, no setPixelRatio,
//      no window.innerWidth/Height, no resize listener.
//   4. WebGL 2 context: explicit `canvas.getContext('webgl2')` with the
//      Proxy `constructor.name = 'WebGL2RenderingContext'` trick.
//   5. NRRDLoader + VolumeRenderShader1 bundled as
//      libs/nrrd-loader.iife.js (~653 KB; includes its own copies of
//      the THREE classes it needs internally so it works under r184).
//   6. `.nrrd` volume loaded via Switch.readFile from sdmc:/ (NOT
//      globalThis.fetch — r184 IIFE breaks brewser:// fetches per
//      [[r184-fetch-hang]]).
//   7. Colormap PNGs (cm_gray.png, cm_viridis.png) loaded via
//      loadImageBypass + DataTexture.
//   8. OrbitControls -> SwitchOrbitControls (gamepad). controls 'change'
//      event mapped to render-on-demand via the animate loop's stick
//      deflection check.
//   9. lil-gui dropped — A button cycles renderstyle (MIP ↔ ISO),
//      X button cycles colormap (viridis ↔ gray). clim1/clim2/
//      isothreshold pinned to defaults.
//  10. console.warn/log/error/info silenced
//      ([[console-error-switches-render-mode]]).

globalThis.__t3dError = null;
globalThis.__t3dRenderCount = 0;
globalThis.__t3dFps = 0;
globalThis.__t3dIsWebGL2 = false;
globalThis.__t3dCapWebGL2 = '(unknown)';
globalThis.__t3dNrrdLoaded = false;
globalThis.__t3dColormapLoaded = false;
globalThis.__t3dRenderstyle = 'iso';
globalThis.__t3dColormap = 'viridis';

( async function run() {
try {

	const THREE = globalThis.__THREE_R184_STAGED__;
	if ( ! THREE ) throw new Error( 'THREE r184 not loaded' );
	const NRRDLoader = globalThis.SwitchNRRDLoader;
	const VolumeRenderShader1 = globalThis.SwitchVolumeShader;
	if ( ! NRRDLoader || ! VolumeRenderShader1 ) {
		throw new Error( 'NRRDLoader / VolumeRenderShader1 not loaded' );
	}
	if ( ! globalThis.SwitchOrbitControls ) {
		throw new Error( 'SwitchOrbitControls not loaded' );
	}

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const canvas = document.getElementById( 't3d-canvas' );
	if ( ! canvas ) throw new Error( '#t3d-canvas missing' );

	const gl = canvas.getContext( 'webgl2', {
		alpha: false, antialias: false, depth: true,
		stencil: false, preserveDrawingBuffer: false,
	} );
	if ( ! gl ) throw new Error( 'WebGL 2 not supported' );
	globalThis.__t3dIsWebGL2 = true;
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
	const SDMC_ASSETS =
		'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-texture3d/assets/';

	let renderer, scene, camera, controls, material, cmtextures;
	const volconfig = { clim1: 0, clim2: 1, renderstyle: 'iso', isothreshold: 0.15, colormap: 'viridis' };
	let firstRenderPending = true;
	let prevA = false, prevX = false;
	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	// Load colormap PNGs first via loadImageBypass.
	async function loadColormap( filename ) {
		const img = await loadImageBypass( SDMC_ASSETS + filename );
		const tex = new THREE.DataTexture(
			img.pixels, img.width, img.height,
			THREE.RGBAFormat, THREE.UnsignedByteType );
		tex.needsUpdate = true;
		return tex;
	}

	cmtextures = {
		viridis: await loadColormap( 'cm_viridis.png' ),
		gray: await loadColormap( 'cm_gray.png' ),
	};
	globalThis.__t3dColormapLoaded = true;

	// Load .nrrd via Switch.readFile — no fetch under r184.
	let nrrdBuf = await Switch.readFile( SDMC_ASSETS + 'stent.nrrd' );
	if ( ! ( nrrdBuf instanceof ArrayBuffer ) ) {
		nrrdBuf = nrrdBuf.buffer.slice( nrrdBuf.byteOffset, nrrdBuf.byteOffset + nrrdBuf.byteLength );
	}
	const volume = ( new NRRDLoader() ).parse( nrrdBuf );
	globalThis.__t3dNrrdLoaded = true;

	init( volume );
	animate();

	function init( volume ) {

		scene = new THREE.Scene();

		// Create renderer
		bypassWebGL1Check( () => {
			renderer = new THREE.WebGLRenderer( { canvas, context } );
		} );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		// Create camera
		const h = 512; // frustum height
		const aspect = SCREEN_WIDTH / SCREEN_HEIGHT;
		camera = new THREE.OrthographicCamera( - h * aspect / 2, h * aspect / 2, h / 2, - h / 2, 1, 1000 );
		camera.position.set( - 64, - 64, 128 );
		camera.up.set( 0, 0, 1 ); // In our data, z is up

		// Create controls
		controls = new SwitchOrbitControls( THREE, camera );
		controls.target.set( 64, 64, 128 );
		controls.minZoom = 0.5;
		controls.maxZoom = 4;
		controls.update();

		// Texture to hold the volume. We have scalars, so we put our data in the red channel.
		// THREEJS will select R32F (33326) based on the THREE.RedFormat and THREE.FloatType.
		const texture = new THREE.Data3DTexture( volume.data, volume.xLength, volume.yLength, volume.zLength );
		texture.format = THREE.RedFormat;
		texture.type = THREE.FloatType;
		texture.minFilter = texture.magFilter = THREE.LinearFilter;
		texture.unpackAlignment = 1;
		texture.needsUpdate = true;

		// Material
		const shader = VolumeRenderShader1;
		const uniforms = THREE.UniformsUtils.clone( shader.uniforms );

		uniforms[ 'u_data' ].value = texture;
		uniforms[ 'u_size' ].value.set( volume.xLength, volume.yLength, volume.zLength );
		uniforms[ 'u_clim' ].value.set( volconfig.clim1, volconfig.clim2 );
		uniforms[ 'u_renderstyle' ].value = volconfig.renderstyle == 'mip' ? 0 : 1; // 0: MIP, 1: ISO
		uniforms[ 'u_renderthreshold' ].value = volconfig.isothreshold; // For ISO renderstyle
		uniforms[ 'u_cmdata' ].value = cmtextures[ volconfig.colormap ];

		material = new THREE.ShaderMaterial( {
			uniforms: uniforms,
			vertexShader: shader.vertexShader,
			fragmentShader: shader.fragmentShader,
			side: THREE.BackSide,
		} );

		const geometry = new THREE.BoxGeometry( volume.xLength, volume.yLength, volume.zLength );
		geometry.translate( volume.xLength / 2 - 0.5, volume.yLength / 2 - 0.5, volume.zLength / 2 - 0.5 );

		const mesh = new THREE.Mesh( geometry, material );
		scene.add( mesh );

		globalThis.__t3dCapWebGL2 = renderer.capabilities && renderer.capabilities.isWebGL2;

	}

	function updateUniforms() {

		material.uniforms[ 'u_clim' ].value.set( volconfig.clim1, volconfig.clim2 );
		material.uniforms[ 'u_renderstyle' ].value = volconfig.renderstyle == 'mip' ? 0 : 1;
		material.uniforms[ 'u_renderthreshold' ].value = volconfig.isothreshold;
		material.uniforms[ 'u_cmdata' ].value = cmtextures[ volconfig.colormap ];
		globalThis.__t3dRenderstyle = volconfig.renderstyle;
		globalThis.__t3dColormap = volconfig.colormap;

	}

	function animate() {

		requestAnimationFrame( animate );

		try {

			// Stick / button input → render-on-demand triggers.
			const beforeTheta = controls && controls._spherical ? controls._spherical.theta : 0;
			const beforePhi = controls && controls._spherical ? controls._spherical.phi : 0;
			if ( controls ) controls.update();
			const afterTheta = controls && controls._spherical ? controls._spherical.theta : 0;
			const afterPhi = controls && controls._spherical ? controls._spherical.phi : 0;
			const stickActive = Math.abs( afterTheta - beforeTheta ) > 1e-5 ||
			                    Math.abs( afterPhi - beforePhi ) > 1e-5;

			const pads = navigator.getGamepads ? navigator.getGamepads() : null;
			const pad = ( pads && pads.length ) ? pads[ 0 ] : null;
			let uniformsChanged = false;
			if ( pad ) {
				const a = pad.buttons[ 0 ] && pad.buttons[ 0 ].pressed;
				const x = pad.buttons[ 2 ] && pad.buttons[ 2 ].pressed;
				if ( a && ! prevA ) {
					volconfig.renderstyle = volconfig.renderstyle === 'mip' ? 'iso' : 'mip';
					uniformsChanged = true;
				}
				if ( x && ! prevX ) {
					volconfig.colormap = volconfig.colormap === 'viridis' ? 'gray' : 'viridis';
					uniformsChanged = true;
				}
				prevA = a;
				prevX = x;
			}

			if ( uniformsChanged ) updateUniforms();

			if ( stickActive || uniformsChanged || firstRenderPending ) {
				renderer.resetState();
				renderer.render( scene, camera );
				globalThis.__t3dRenderCount = ( globalThis.__t3dRenderCount | 0 ) + 1;
				firstRenderPending = false;
			}

			fpsAccumFrames ++;
			const now = Date.now();
			if ( now - fpsAccumStart >= 3000 ) {
				globalThis.__t3dFps = Math.round( ( fpsAccumFrames * 1000 ) / ( now - fpsAccumStart ) );
				fpsAccumStart = now;
				fpsAccumFrames = 0;
			}

		} catch ( e ) {
			if ( ! globalThis.__t3dError ) {
				globalThis.__t3dError = String( e && e.message ? e.message : e );
			}
		}

	}

} catch ( e ) {
	if ( ! globalThis.__t3dError ) {
		globalThis.__t3dError = String( e && e.message ? e.message : e );
	}
}
} )();
