// Three.js webgl_ubo example — 1:1 port for switch-web-browser.
//
// Source: three-latest/examples/webgl_ubo.html (Three.js r184).
//
// Pre-authorized deviations (kept to the minimum required by nx.js):
//
//   1. Library load: `THREE = globalThis.__THREE_R184_STAGED__` instead
//      of an import map.
//   2. Three nx.js+r184 shims sourced from libs/r184-nxjs-bridge.js:
//      - `loadImageBypass(url)` polls img.complete because r184
//        suppresses Image events
//      - `bypassWebGL1Check(fn)` wraps new WebGLRenderer to dodge
//        r184's instanceof WebGLRenderingContext throw
//      - rAF heartbeat keeps the event loop ticking so timers fire
//        before init() queues its own animation loop
//   3. Canvas: reuse the pre-declared <canvas id="ubo-canvas"> from
//      index.html instead of `container.appendChild(...)`.
//      `setPixelRatio`, `window.innerWidth/Height` and resize listener
//      dropped — canvas dims come from the element attrs.
//   4. WebGL 2 context: explicit `canvas.getContext('webgl2')` with a
//      Proxy whose `constructor.name === 'WebGL2RenderingContext'` so
//      Three.js's downstream `gl.constructor.name` checks pass.
//   5. TextureLoader -> loadImageBypass + DataTexture. Source PNG
//      (`crate.png`) instead of the upstream GIF because nx.js's image
//      decoder doesn't handle GIF.
//   6. console.warn/log/error/info silenced
//      ([[console-error-switches-render-mode]]).
//   7. `renderer.resetState()` before every render
//      ([[threejs-resetstate]]).

globalThis.__uboError = null;
globalThis.__uboAnimateCalled = false;
globalThis.__uboFrameCount = 0;
globalThis.__uboRenderCount = 0;
globalThis.__uboFps = 0;
globalThis.__uboIsWebGL2 = false;
globalThis.__uboCapWebGL2 = '(unknown)';
globalThis.__uboTextureLoaded = false;
globalThis.__uboMaxBindings = '?';

( async function run() {
try {

	const THREE = globalThis.__THREE_R184_STAGED__;
	if ( ! THREE ) throw new Error( 'THREE r184 not loaded' );

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const canvas = document.getElementById( 'ubo-canvas' );
	if ( ! canvas ) throw new Error( '#ubo-canvas missing' );

	const gl = canvas.getContext( 'webgl2', {
		alpha: false, antialias: false, depth: true,
		stencil: false, preserveDrawingBuffer: false,
	} );
	if ( ! gl ) throw new Error( 'WebGL 2 not supported' );
	globalThis.__uboIsWebGL2 = true;
	if ( typeof gl.enableGpuBridgePrototype === 'function' ) {
		gl.enableGpuBridgePrototype( true );
	}
	try {
		globalThis.__uboMaxBindings = gl.getParameter( gl.MAX_UNIFORM_BUFFER_BINDINGS );
	} catch ( e ) {}

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

	let camera, scene, renderer, timer;

	// Replacement for upstream's `new TextureLoader().load('textures/crate.gif')`.
	const img = await loadImageBypass(
		'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl2-ubo/assets/crate.png' );
	const texture = new THREE.DataTexture(
		img.pixels, img.width, img.height,
		THREE.RGBAFormat, THREE.UnsignedByteType );
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	globalThis.__uboTextureLoaded = true;

	init( texture );

	function init( texture ) {

		camera = new THREE.PerspectiveCamera( 45, SCREEN_WIDTH / SCREEN_HEIGHT, 0.1, 100 );
		camera.position.set( 0, 0, 25 );

		scene = new THREE.Scene();
		camera.lookAt( scene.position );

		timer = new THREE.Timer();
		timer.connect( document );

		// geometry

		const geometry1 = new THREE.TetrahedronGeometry();
		const geometry2 = new THREE.BoxGeometry();

		// uniforms groups

		// Camera and lighting related data are perfect examples of using UBOs since you have to store these
		// data just once. They can be shared across all shader programs.

		const cameraUniformsGroup = new THREE.UniformsGroup();
		cameraUniformsGroup.setName( 'ViewData' );
		cameraUniformsGroup.add( new THREE.Uniform( camera.projectionMatrix ) ); // projection matrix
		cameraUniformsGroup.add( new THREE.Uniform( camera.matrixWorldInverse ) ); // view matrix

		const lightingUniformsGroup = new THREE.UniformsGroup();
		lightingUniformsGroup.setName( 'LightingData' );
		lightingUniformsGroup.add( new THREE.Uniform( new THREE.Vector3( 0, 0, 10 ) ) ); // light position
		lightingUniformsGroup.add( new THREE.Uniform( new THREE.Color( 0x7c7c7c ) ) ); // ambient color
		lightingUniformsGroup.add( new THREE.Uniform( new THREE.Color( 0xd5d5d5 ) ) ); // diffuse color
		lightingUniformsGroup.add( new THREE.Uniform( new THREE.Color( 0xe7e7e7 ) ) ); // specular color
		lightingUniformsGroup.add( new THREE.Uniform( 64 ) ); // shininess

		// materials

		const material1 = new THREE.RawShaderMaterial( {
			uniforms: {
				modelMatrix: { value: null },
				normalMatrix: { value: null },
				color: { value: null }
			},
			vertexShader: document.getElementById( 'vertexShader1' ).textContent,
			fragmentShader: document.getElementById( 'fragmentShader1' ).textContent,
			glslVersion: THREE.GLSL3
		} );

		const material2 = new THREE.RawShaderMaterial( {
			uniforms: {
				modelMatrix: { value: null },
				diffuseMap: { value: null },
			},
			vertexShader: document.getElementById( 'vertexShader2' ).textContent,
			fragmentShader: document.getElementById( 'fragmentShader2' ).textContent,
			glslVersion: THREE.GLSL3
		} );

		// meshes

		for ( let i = 0; i < 200; i ++ ) {

			let mesh;

			if ( i % 2 === 0 ) {

				mesh = new THREE.Mesh( geometry1, material1.clone() );

				mesh.material.uniformsGroups = [ cameraUniformsGroup, lightingUniformsGroup ];
				mesh.material.uniforms.modelMatrix.value = mesh.matrixWorld;
				mesh.material.uniforms.normalMatrix.value = mesh.normalMatrix;
				mesh.material.uniforms.color.value = new THREE.Color( 0xffffff * Math.random() );

			} else {

				mesh = new THREE.Mesh( geometry2, material2.clone() );

				mesh.material.uniformsGroups = [ cameraUniformsGroup, lightingUniformsGroup ];
				mesh.material.uniforms.modelMatrix.value = mesh.matrixWorld;
				mesh.material.uniforms.diffuseMap.value = texture;

			}

			scene.add( mesh );

			const s = 1 + Math.random() * 0.5;

			mesh.scale.x = s;
			mesh.scale.y = s;
			mesh.scale.z = s;

			mesh.rotation.x = Math.random() * Math.PI;
			mesh.rotation.y = Math.random() * Math.PI;
			mesh.rotation.z = Math.random() * Math.PI;

			mesh.position.x = Math.random() * 40 - 20;
			mesh.position.y = Math.random() * 40 - 20;
			mesh.position.z = Math.random() * 20 - 10;

		}

		//

		bypassWebGL1Check( () => {
			renderer = new THREE.WebGLRenderer( {
				canvas, context, antialias: true,
				alpha: false, depth: true, stencil: false,
				preserveDrawingBuffer: false,
			} );
		} );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );
		renderer.setAnimationLoop( animate );

		globalThis.__uboCapWebGL2 = renderer.capabilities && renderer.capabilities.isWebGL2;

	}

	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	function animate() {

		globalThis.__uboAnimateCalled = true;

		try {

			timer.update();

			const delta = timer.getDelta();

			scene.traverse( function ( child ) {

				if ( child.isMesh ) {

					child.rotation.x += delta * 0.5;
					child.rotation.y += delta * 0.3;

				}

			} );

			renderer.resetState();
			renderer.render( scene, camera );

			globalThis.__uboRenderCount = ( globalThis.__uboRenderCount | 0 ) + 1;
			globalThis.__uboFrameCount = ( globalThis.__uboFrameCount | 0 ) + 1;
			fpsAccumFrames ++;
			const now = Date.now();
			if ( now - fpsAccumStart >= 3000 ) {
				globalThis.__uboFps = Math.round( ( fpsAccumFrames * 1000 ) / ( now - fpsAccumStart ) );
				fpsAccumStart = now;
				fpsAccumFrames = 0;
			}

		} catch ( e ) {
			if ( ! globalThis.__uboError ) {
				globalThis.__uboError = String( e && e.message ? e.message : e );
			}
		}

	}

} catch ( e ) {
	if ( ! globalThis.__uboError ) {
		globalThis.__uboError = String( e && e.message ? e.message : e );
	}
}
} )();
