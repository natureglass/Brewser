// Three.js webgl_multiple_rendertargets example — 1:1 port for switch-web-browser.
//
// Source: three-latest/examples/webgl_multiple_rendertargets.html
// (Three.js r184).
//
// Pre-authorized deviations (nx.js + r184 platform requirements):
//
//   1. Library load: `THREE = globalThis.__THREE_R184_STAGED__`.
//   2. r184 nx.js shims from libs/r184-nxjs-bridge.js:
//      `loadImageBypass` (Image events suppressed), `bypassWebGL1Check`
//      (instanceof WebGLRenderingContext guard), rAF heartbeat (event
//      loop starvation).
//   3. Canvas reused from <canvas id="mrt-canvas">; no
//      `document.body.appendChild`, no setPixelRatio,
//      no window.innerWidth/Height, no resize listener.
//   4. WebGL 2 context: explicit `canvas.getContext('webgl2')` with a
//      Proxy whose `constructor.name === 'WebGL2RenderingContext'`.
//   5. TextureLoader -> loadImageBypass + DataTexture.
//   6. OrbitControls -> SwitchOrbitControls (gamepad).
//   7. lil-gui dropped; A button cycles samples (0/1/2/4), X toggles
//      wireframe. Upstream `gui.onChange(render)` mapped to render-on-
//      demand: re-render when controls move OR gamepad input toggles
//      parameters.
//   8. MSAA default samples = 0 (upstream default = 4) — Mesa Nouveau
//      blit-resolve quirk on Citron leaves color textures at zero
//      with samples > 0. A button still cycles up to 4 for real-hw
//      verification.
//   9. console.warn/log/error/info silenced.
//  10. `renderer.resetState()` before every render
//      ([[threejs-resetstate]]).

globalThis.__mrtError = null;
globalThis.__mrtRenderCount = 0;
globalThis.__mrtFps = 0;
globalThis.__mrtIsWebGL2 = false;
globalThis.__mrtCapWebGL2 = '(unknown)';
globalThis.__mrtTextureLoaded = false;
globalThis.__mrtSamples = 0;
globalThis.__mrtWireframe = false;

( async function run() {
try {

	const THREE = globalThis.__THREE_R184_STAGED__;
	if ( ! THREE ) throw new Error( 'THREE r184 not loaded' );
	if ( ! globalThis.SwitchOrbitControls ) throw new Error( 'SwitchOrbitControls not loaded' );

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const canvas = document.getElementById( 'mrt-canvas' );
	if ( ! canvas ) throw new Error( '#mrt-canvas missing' );

	const gl = canvas.getContext( 'webgl2', {
		alpha: false, antialias: false, depth: true,
		stencil: false, preserveDrawingBuffer: false,
	} );
	if ( ! gl ) throw new Error( 'WebGL 2 not supported' );
	globalThis.__mrtIsWebGL2 = true;
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

	let camera, scene, renderer, controls;
	let renderTarget;
	let postScene, postCamera;

	const parameters = {
		samples: 0,        // deviation #8: upstream default 4
		wireframe: false,
	};
	globalThis.__mrtSamples = parameters.samples;
	globalThis.__mrtWireframe = parameters.wireframe;

	// Replacement for upstream's `new TextureLoader().load('textures/hardwood2_diffuse.jpg', render)`.
	const img = await loadImageBypass(
		'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl2-multiple-rendertargets/assets/hardwood2_diffuse.jpg' );
	const diffuse = new THREE.DataTexture(
		img.pixels, img.width, img.height,
		THREE.RGBAFormat, THREE.UnsignedByteType );
	diffuse.wrapS = THREE.RepeatWrapping;
	diffuse.wrapT = THREE.RepeatWrapping;
	diffuse.colorSpace = THREE.SRGBColorSpace;
	diffuse.needsUpdate = true;
	globalThis.__mrtTextureLoaded = true;

	init();
	renderLoop();

	function init() {

		bypassWebGL1Check( () => {
			renderer = new THREE.WebGLRenderer( { canvas, context } );
		} );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

		// Create a multi render target with Float buffers

		renderTarget = new THREE.WebGLRenderTarget(
			SCREEN_WIDTH,
			SCREEN_HEIGHT,
			{
				count: 2,
				minFilter: THREE.NearestFilter,
				magFilter: THREE.NearestFilter
			}
		);

		// Name our G-Buffer attachments for debugging

		renderTarget.textures[ 0 ].name = 'diffuse';
		renderTarget.textures[ 1 ].name = 'normal';

		// Scene setup

		scene = new THREE.Scene();
		scene.background = new THREE.Color( 0x222222 );

		camera = new THREE.PerspectiveCamera( 70, SCREEN_WIDTH / SCREEN_HEIGHT, 0.1, 50 );
		camera.position.z = 4;

		scene.add( new THREE.Mesh(
			new THREE.TorusKnotGeometry( 1, 0.3, 128, 32 ),
			new THREE.RawShaderMaterial( {
				name: 'G-Buffer Shader',
				vertexShader: document.querySelector( '#gbuffer-vert' ).textContent.trim(),
				fragmentShader: document.querySelector( '#gbuffer-frag' ).textContent.trim(),
				uniforms: {
					tDiffuse: { value: diffuse },
					repeat: { value: new THREE.Vector2( 5, 0.5 ) }
				},
				glslVersion: THREE.GLSL3
			} )
		) );

		// PostProcessing setup

		postScene = new THREE.Scene();
		postCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		postScene.add( new THREE.Mesh(
			new THREE.PlaneGeometry( 2, 2 ),
			new THREE.RawShaderMaterial( {
				name: 'Post-FX Shader',
				vertexShader: document.querySelector( '#render-vert' ).textContent.trim(),
				fragmentShader: document.querySelector( '#render-frag' ).textContent.trim(),
				uniforms: {
					tDiffuse: { value: renderTarget.textures[ 0 ] },
					tNormal: { value: renderTarget.textures[ 1 ] },
				},
				glslVersion: THREE.GLSL3
			} )
		) );

		// Controls — upstream sets none, only registers a 'change'
		// listener that triggers render-on-demand. SwitchOrbitControls
		// defaults `enablePan = false` per project convention; we also
		// disable zoom since upstream never wires it for this demo and
		// fixed camera distance keeps the torus framed.
		controls = new SwitchOrbitControls( THREE, camera );
		controls.enableZoom = false;

		globalThis.__mrtCapWebGL2 = renderer.capabilities && renderer.capabilities.isWebGL2;

	}

	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;
	let firstRenderPending = true;
	let prevA = false;
	let prevX = false;

	function renderLoop() {

		requestAnimationFrame( renderLoop );

		try {

			// Stick / button input → render-on-demand triggers
			const beforeTheta = controls && controls._spherical ? controls._spherical.theta : 0;
			const beforePhi = controls && controls._spherical ? controls._spherical.phi : 0;
			if ( controls ) controls.update();
			const afterTheta = controls && controls._spherical ? controls._spherical.theta : 0;
			const afterPhi = controls && controls._spherical ? controls._spherical.phi : 0;
			const stickActive = Math.abs( afterTheta - beforeTheta ) > 1e-5 ||
			                    Math.abs( afterPhi - beforePhi ) > 1e-5;

			// Gamepad A cycles samples 0/1/2/4; X toggles wireframe.
			const pads = navigator.getGamepads ? navigator.getGamepads() : null;
			const pad = ( pads && pads.length ) ? pads[ 0 ] : null;
			let paramsChanged = false;
			if ( pad ) {
				const a = pad.buttons[ 0 ] && pad.buttons[ 0 ].pressed;
				const x = pad.buttons[ 2 ] && pad.buttons[ 2 ].pressed;
				if ( a && ! prevA ) {
					const seq = [ 0, 1, 2, 4 ];
					const idx = seq.indexOf( parameters.samples );
					parameters.samples = seq[ ( idx + 1 ) % seq.length ];
					globalThis.__mrtSamples = parameters.samples;
					paramsChanged = true;
				}
				if ( x && ! prevX ) {
					parameters.wireframe = ! parameters.wireframe;
					globalThis.__mrtWireframe = parameters.wireframe;
					paramsChanged = true;
				}
				prevA = a;
				prevX = x;
			}

			if ( stickActive || paramsChanged || firstRenderPending ) {
				render();
				firstRenderPending = false;
			}

			fpsAccumFrames ++;
			const now = Date.now();
			if ( now - fpsAccumStart >= 3000 ) {
				globalThis.__mrtFps = Math.round( ( fpsAccumFrames * 1000 ) / ( now - fpsAccumStart ) );
				fpsAccumStart = now;
				fpsAccumFrames = 0;
			}

		} catch ( e ) {
			if ( ! globalThis.__mrtError ) {
				globalThis.__mrtError = String( e && e.message ? e.message : e );
			}
		}

	}

	function reattachMRTColorAttachments() {

		// Mesa Nouveau (Citron) workaround per [[mesa-nouveau-mrt-quirks]]:
		// after texture-feedback (G-Buffer pass writes, post pass reads
		// the same textures, next G-Buffer pass would write again), the
		// driver corrupts the FBO's per-attachment binding — typically
		// attachment 1 drops, so subsequent frames only update
		// COLOR_ATTACHMENT0 ("only the left half rotates" symptom).
		// Re-attaching the color textures each frame before the
		// G-Buffer pass keeps both attachments live.
		//
		// Reaches into Three.js's private property bag
		// (`renderer.properties.get(...).__webglFramebuffer` +
		// `.__webglTexture`) — fragile across future Three.js versions
		// but matches r184's WebGLProperties layout as of 2026-05-24.
		if ( ! renderTarget || ! renderer || ! renderTarget.textures ||
		     renderTarget.textures.length < 2 ) return;
		const rtProps = renderer.properties.get( renderTarget );
		if ( ! rtProps || ! rtProps.__webglFramebuffer ) return;
		const _gl = renderer.getContext();
		_gl.bindFramebuffer( _gl.FRAMEBUFFER, rtProps.__webglFramebuffer );
		const drawBuffers = [];
		for ( let i = 0; i < renderTarget.textures.length; i ++ ) {
			const texProps = renderer.properties.get( renderTarget.textures[ i ] );
			if ( ! texProps || ! texProps.__webglTexture ) return;
			_gl.framebufferTexture2D(
				_gl.FRAMEBUFFER,
				_gl.COLOR_ATTACHMENT0 + i,
				_gl.TEXTURE_2D,
				texProps.__webglTexture, 0 );
			drawBuffers.push( _gl.COLOR_ATTACHMENT0 + i );
		}
		// Also re-issue drawBuffers — some drivers drop the draw-buffer
		// array when attachments are re-bound.
		if ( typeof _gl.drawBuffers === 'function' ) {
			_gl.drawBuffers( drawBuffers );
		}

	}

	function render() {

		renderTarget.samples = parameters.samples;

		scene.traverse( function ( child ) {

			if ( child.material !== undefined ) {

				child.material.wireframe = parameters.wireframe;

			}

		} );

		// resetState must come BEFORE each render call — Three.js's
		// WebGLState cache drifts between consecutive renders against
		// the nx.js bridge ([[threejs-resetstate]]). Without the second
		// reset, the post pass's sampler2D uniforms can sample wrong /
		// unbound textures after the G-Buffer pass leaves the renderer
		// in a bridge state the post material's program wasn't compiled
		// against, manifesting as a black canvas after the first orbit
		// triggers a re-render.

		// render scene into target
		renderer.resetState();
		renderer.setRenderTarget( renderTarget );
		reattachMRTColorAttachments();
		renderer.render( scene, camera );

		// render post FX
		renderer.resetState();
		renderer.setRenderTarget( null );
		renderer.render( postScene, postCamera );

		globalThis.__mrtRenderCount = ( globalThis.__mrtRenderCount | 0 ) + 1;

	}

} catch ( e ) {
	if ( ! globalThis.__mrtError ) {
		globalThis.__mrtError = String( e && e.message ? e.message : e );
	}
}
} )();
