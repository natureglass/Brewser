// Three.js r162 webgl_geometry_shapes example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_geometry_shapes.html
//
// Adapted as 1:1 to upstream as possible. Deviations enumerated:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__` from a
//      separate <script> tag, replaces upstream's importmap+module.
//   2. Stats addon dropped; status canvas in index.html shows FPS +
//      diagnostics via globalThis.__shapes* writes.
//   3. Fixed-size 640x360 canvas; setPixelRatio / window.innerWidth /
//      resize listener / document.createElement('div') / appendChild
//      dropped.
//   4. Stable Proxy on the WebGL context (same scaffold as siblings).
//   5. console.warn/log/error/info silenced ([[console-error-switches-render-mode]]).
//   6. `renderer.resetState()` called before every renderer.render
//      ([[threejs-resetstate-per-frame]]).
//   7. `TextureLoader` -> `Image` + `OffscreenCanvas` + `DataTexture`
//      pipeline because nx.js's `texImage2D` only accepts buffer sources.
//      Image src points at the SDMC path (brewser:// scheme is rejected
//      by nx.js's module-local fetch — see [[nxjs-image-bypasses-global-fetch]]).
//   8. `texture.generateMipmaps = false` + min/magFilter = LinearFilter
//      so Three.js doesn't try LINEAR_MIPMAP_LINEAR which nx.js's
//      texParameteri rejects (it only accepts NEAREST / LINEAR).
//   9. Pointer events (pointerdown/move/up) replaced with right-stick X
//      gamepad axis -> targetRotation. Continuous; the group rotates
//      while the stick is held off-center.

globalThis.__shapesMainStarted = true;
globalThis.__shapesAnimateCalled = false;
globalThis.__shapesError = null;
globalThis.__shapesTextureLoaded = false;
globalThis.__shapesTextureW = 0;
globalThis.__shapesTextureH = 0;
globalThis.__shapesMeshCount = 0;
globalThis.__shapesFrameCount = 0;
globalThis.__shapesFps = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__shapesError = 'THREE not loaded - is libs/three.iife.js missing?';
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
	const shapesCanvasEl = document.getElementById('shapes-canvas');
	const SCREEN_WIDTH = (shapesCanvasEl && shapesCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (shapesCanvasEl && shapesCanvasEl.height) || 360;

	let camera, scene, renderer;
	let group;
	let targetRotation = 0;

	const canvas = document.getElementById('shapes-canvas');
	if (!canvas) {
		globalThis.__shapesError = '#shapes-canvas missing in HTML';
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
		globalThis.__shapesError = 'WebGL acquire failed';
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

	// SWB-specific: FPS sampling (replaces Stats).
	let fpsAccumStart = Date.now();
	let fpsAccumFrames = 0;

	// SWB-specific: TextureLoader workaround. Load via Image, decode through
	// an OffscreenCanvas, wrap as a DataTexture.
	const img = new Image();
	await new Promise((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = (e) => reject(new Error(
			'image load failed: ' + ((e && e.error && e.error.message) || 'unknown'),
		));
		img.src = 'sdmc:/switch/brewser/apps/ThreeJSDemos/webgl-geometry-shapes/assets/uv_grid_opengl.jpg';
	});
	const tw = img.width;
	const th = img.height;
	const off = new OffscreenCanvas(tw, th);
	const oc = off.getContext('2d');
	oc.drawImage(img, 0, 0);
	const pixels = new Uint8Array(oc.getImageData(0, 0, tw, th).data.buffer);
	globalThis.__shapesTextureLoaded = true;
	globalThis.__shapesTextureW = tw;
	globalThis.__shapesTextureH = th;

	const texture = new THREE.DataTexture(
		pixels, tw, th, THREE.RGBAFormat, THREE.UnsignedByteType,
	);
	texture.colorSpace = THREE.SRGBColorSpace;

	// it's necessary to apply these settings in order to correctly display the texture on a shape geometry
	// (upstream comment kept verbatim)

	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	texture.repeat.set(0.008, 0.008);

	// SWB additions: keep nx.js's texParameteri inside its NEAREST/LINEAR
	// + CLAMP_TO_EDGE/REPEAT accept lists. mipmap-filter is rejected;
	// generateMipmaps must be false. Wrap=REPEAT and repeat.set work via
	// the bridge's texParameteri plumbing + mapTransform mat3 uniform
	// (added 2026-05-18 for this milestone).
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;

	init();
	animate();

	function init() {

		scene = new THREE.Scene();
		scene.background = new THREE.Color( 0xf0f0f0 );

		camera = new THREE.PerspectiveCamera( 50, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 1000 );
		camera.position.set( 0, 150, 500 );
		scene.add( camera );

		const light = new THREE.PointLight( 0xffffff, 2.5, 0, 0 );
		camera.add( light );

		group = new THREE.Group();
		group.position.y = 50;
		scene.add( group );

		// (texture is already loaded above; upstream's TextureLoader call
		// is the deviation point — see file header.)

		function addShape( shape, extrudeSettings, color, x, y, z, rx, ry, rz, s ) {

			// flat shape with texture
			// note: default UVs generated by THREE.ShapeGeometry are simply the x- and y-coordinates of the vertices

			let geometry = new THREE.ShapeGeometry( shape );

			let mesh = new THREE.Mesh( geometry, new THREE.MeshPhongMaterial( { side: THREE.DoubleSide, map: texture } ) );
			mesh.position.set( x, y, z - 175 );
			mesh.rotation.set( rx, ry, rz );
			mesh.scale.set( s, s, s );
			group.add( mesh );

			// flat shape

			geometry = new THREE.ShapeGeometry( shape );

			mesh = new THREE.Mesh( geometry, new THREE.MeshPhongMaterial( { color: color, side: THREE.DoubleSide } ) );
			mesh.position.set( x, y, z - 125 );
			mesh.rotation.set( rx, ry, rz );
			mesh.scale.set( s, s, s );
			group.add( mesh );

			// extruded shape

			geometry = new THREE.ExtrudeGeometry( shape, extrudeSettings );

			mesh = new THREE.Mesh( geometry, new THREE.MeshPhongMaterial( { color: color } ) );
			mesh.position.set( x, y, z - 75 );
			mesh.rotation.set( rx, ry, rz );
			mesh.scale.set( s, s, s );
			group.add( mesh );

			addLineShape( shape, color, x, y, z, rx, ry, rz, s );

		}

		function addLineShape( shape, color, x, y, z, rx, ry, rz, s ) {

			// lines

			shape.autoClose = true;

			const points = shape.getPoints();
			const spacedPoints = shape.getSpacedPoints( 50 );

			const geometryPoints = new THREE.BufferGeometry().setFromPoints( points );
			const geometrySpacedPoints = new THREE.BufferGeometry().setFromPoints( spacedPoints );

			// solid line

			let line = new THREE.Line( geometryPoints, new THREE.LineBasicMaterial( { color: color } ) );
			line.position.set( x, y, z - 25 );
			line.rotation.set( rx, ry, rz );
			line.scale.set( s, s, s );
			group.add( line );

			// line from equidistance sampled points

			line = new THREE.Line( geometrySpacedPoints, new THREE.LineBasicMaterial( { color: color } ) );
			line.position.set( x, y, z + 25 );
			line.rotation.set( rx, ry, rz );
			line.scale.set( s, s, s );
			group.add( line );

			// vertices from real points

			let particles = new THREE.Points( geometryPoints, new THREE.PointsMaterial( { color: color, size: 4 } ) );
			particles.position.set( x, y, z + 75 );
			particles.rotation.set( rx, ry, rz );
			particles.scale.set( s, s, s );
			group.add( particles );

			// equidistance sampled points

			particles = new THREE.Points( geometrySpacedPoints, new THREE.PointsMaterial( { color: color, size: 4 } ) );
			particles.position.set( x, y, z + 125 );
			particles.rotation.set( rx, ry, rz );
			particles.scale.set( s, s, s );
			group.add( particles );

		}


		// California

		const californiaPts = [];

		californiaPts.push( new THREE.Vector2( 610, 320 ) );
		californiaPts.push( new THREE.Vector2( 450, 300 ) );
		californiaPts.push( new THREE.Vector2( 392, 392 ) );
		californiaPts.push( new THREE.Vector2( 266, 438 ) );
		californiaPts.push( new THREE.Vector2( 190, 570 ) );
		californiaPts.push( new THREE.Vector2( 190, 600 ) );
		californiaPts.push( new THREE.Vector2( 160, 620 ) );
		californiaPts.push( new THREE.Vector2( 160, 650 ) );
		californiaPts.push( new THREE.Vector2( 180, 640 ) );
		californiaPts.push( new THREE.Vector2( 165, 680 ) );
		californiaPts.push( new THREE.Vector2( 150, 670 ) );
		californiaPts.push( new THREE.Vector2( 90, 737 ) );
		californiaPts.push( new THREE.Vector2( 80, 795 ) );
		californiaPts.push( new THREE.Vector2( 50, 835 ) );
		californiaPts.push( new THREE.Vector2( 64, 870 ) );
		californiaPts.push( new THREE.Vector2( 60, 945 ) );
		californiaPts.push( new THREE.Vector2( 300, 945 ) );
		californiaPts.push( new THREE.Vector2( 300, 743 ) );
		californiaPts.push( new THREE.Vector2( 600, 473 ) );
		californiaPts.push( new THREE.Vector2( 626, 425 ) );
		californiaPts.push( new THREE.Vector2( 600, 370 ) );
		californiaPts.push( new THREE.Vector2( 610, 320 ) );

		for ( let i = 0; i < californiaPts.length; i ++ ) californiaPts[ i ].multiplyScalar( 0.25 );

		const californiaShape = new THREE.Shape( californiaPts );


		// Triangle

		const triangleShape = new THREE.Shape()
			.moveTo( 80, 20 )
			.lineTo( 40, 80 )
			.lineTo( 120, 80 )
			.lineTo( 80, 20 ); // close path


		// Heart

		const x = 0, y = 0;

		const heartShape = new THREE.Shape()
			.moveTo( x + 25, y + 25 )
			.bezierCurveTo( x + 25, y + 25, x + 20, y, x, y )
			.bezierCurveTo( x - 30, y, x - 30, y + 35, x - 30, y + 35 )
			.bezierCurveTo( x - 30, y + 55, x - 10, y + 77, x + 25, y + 95 )
			.bezierCurveTo( x + 60, y + 77, x + 80, y + 55, x + 80, y + 35 )
			.bezierCurveTo( x + 80, y + 35, x + 80, y, x + 50, y )
			.bezierCurveTo( x + 35, y, x + 25, y + 25, x + 25, y + 25 );


		// Square

		const sqLength = 80;

		const squareShape = new THREE.Shape()
			.moveTo( 0, 0 )
			.lineTo( 0, sqLength )
			.lineTo( sqLength, sqLength )
			.lineTo( sqLength, 0 )
			.lineTo( 0, 0 );

		// Rounded rectangle

		const roundedRectShape = new THREE.Shape();

		( function roundedRect( ctx, x, y, width, height, radius ) {

			ctx.moveTo( x, y + radius );
			ctx.lineTo( x, y + height - radius );
			ctx.quadraticCurveTo( x, y + height, x + radius, y + height );
			ctx.lineTo( x + width - radius, y + height );
			ctx.quadraticCurveTo( x + width, y + height, x + width, y + height - radius );
			ctx.lineTo( x + width, y + radius );
			ctx.quadraticCurveTo( x + width, y, x + width - radius, y );
			ctx.lineTo( x + radius, y );
			ctx.quadraticCurveTo( x, y, x, y + radius );

		} )( roundedRectShape, 0, 0, 50, 50, 20 );


		// Track

		const trackShape = new THREE.Shape()
			.moveTo( 40, 40 )
			.lineTo( 40, 160 )
			.absarc( 60, 160, 20, Math.PI, 0, true )
			.lineTo( 80, 40 )
			.absarc( 60, 40, 20, 2 * Math.PI, Math.PI, true );


		// Circle

		const circleRadius = 40;
		const circleShape = new THREE.Shape()
			.moveTo( 0, circleRadius )
			.quadraticCurveTo( circleRadius, circleRadius, circleRadius, 0 )
			.quadraticCurveTo( circleRadius, - circleRadius, 0, - circleRadius )
			.quadraticCurveTo( - circleRadius, - circleRadius, - circleRadius, 0 )
			.quadraticCurveTo( - circleRadius, circleRadius, 0, circleRadius );


		// Fish

		const fishShape = new THREE.Shape()
			.moveTo( x, y )
			.quadraticCurveTo( x + 50, y - 80, x + 90, y - 10 )
			.quadraticCurveTo( x + 100, y - 10, x + 115, y - 40 )
			.quadraticCurveTo( x + 115, y, x + 115, y + 40 )
			.quadraticCurveTo( x + 100, y + 10, x + 90, y + 10 )
			.quadraticCurveTo( x + 50, y + 80, x, y );


		// Arc circle

		const arcShape = new THREE.Shape()
			.moveTo( 50, 10 )
			.absarc( 10, 10, 40, 0, Math.PI * 2, false );

		const holePath = new THREE.Path()
			.moveTo( 20, 10 )
			.absarc( 10, 10, 10, 0, Math.PI * 2, true );

		arcShape.holes.push( holePath );


		// Smiley

		const smileyShape = new THREE.Shape()
			.moveTo( 80, 40 )
			.absarc( 40, 40, 40, 0, Math.PI * 2, false );

		const smileyEye1Path = new THREE.Path()
			.moveTo( 35, 20 )
			.absellipse( 25, 20, 10, 10, 0, Math.PI * 2, true );

		const smileyEye2Path = new THREE.Path()
			.moveTo( 65, 20 )
			.absarc( 55, 20, 10, 0, Math.PI * 2, true );

		const smileyMouthPath = new THREE.Path()
			.moveTo( 20, 40 )
			.quadraticCurveTo( 40, 60, 60, 40 )
			.bezierCurveTo( 70, 45, 70, 50, 60, 60 )
			.quadraticCurveTo( 40, 80, 20, 60 )
			.quadraticCurveTo( 5, 50, 20, 40 );

		smileyShape.holes.push( smileyEye1Path );
		smileyShape.holes.push( smileyEye2Path );
		smileyShape.holes.push( smileyMouthPath );


		// Spline shape

		const splinepts = [];
		splinepts.push( new THREE.Vector2( 70, 20 ) );
		splinepts.push( new THREE.Vector2( 80, 90 ) );
		splinepts.push( new THREE.Vector2( - 30, 70 ) );
		splinepts.push( new THREE.Vector2( 0, 0 ) );

		const splineShape = new THREE.Shape()
			.moveTo( 0, 0 )
			.splineThru( splinepts );

		const extrudeSettings = { depth: 8, bevelEnabled: true, bevelSegments: 2, steps: 2, bevelSize: 1, bevelThickness: 1 };

		// addShape( shape, color, x, y, z, rx, ry,rz, s );

		addShape( californiaShape, extrudeSettings, 0xf08000, - 300, - 100, 0, 0, 0, 0, 1 );
		addShape( triangleShape, extrudeSettings, 0x8080f0, - 180, 0, 0, 0, 0, 0, 1 );
		addShape( roundedRectShape, extrudeSettings, 0x008000, - 150, 150, 0, 0, 0, 0, 1 );
		addShape( trackShape, extrudeSettings, 0x008080, 200, - 100, 0, 0, 0, 0, 1 );
		addShape( squareShape, extrudeSettings, 0x0040f0, 150, 100, 0, 0, 0, 0, 1 );
		addShape( heartShape, extrudeSettings, 0xf00000, 60, 100, 0, 0, 0, Math.PI, 1 );
		addShape( circleShape, extrudeSettings, 0x00f000, 120, 250, 0, 0, 0, 0, 1 );
		addShape( fishShape, extrudeSettings, 0x404040, - 60, 200, 0, 0, 0, 0, 1 );
		addShape( smileyShape, extrudeSettings, 0xf000f0, - 200, 250, 0, 0, 0, Math.PI, 1 );
		addShape( arcShape, extrudeSettings, 0x804000, 150, 0, 0, 0, 0, 0, 1 );
		addShape( splineShape, extrudeSettings, 0x808080, - 50, - 100, 0, 0, 0, 0, 1 );

		addLineShape( arcShape.holes[ 0 ], 0x804000, 150, 0, 0, 0, 0, 0, 1 );

		for ( let i = 0; i < smileyShape.holes.length; i += 1 ) {

			addLineShape( smileyShape.holes[ i ], 0xf000f0, - 200, 250, 0, 0, 0, Math.PI, 1 );

		}

		globalThis.__shapesMeshCount = group.children.length;

		//

		renderer = new THREE.WebGLRenderer( {
			canvas: canvas, context: context, antialias: true,
		} );
		renderer.setSize( SCREEN_WIDTH, SCREEN_HEIGHT, false );

	}

	// Replaces upstream's pointerdown/move/up handlers. Reads the right
	// analog stick's X axis each frame; deadzone-corrected, scaled to
	// drive `targetRotation` cumulatively (held off-center -> continuous
	// rotation). Matches the drag-and-release feel without modal state.
	function pollGamepad() {

		const pads = navigator.getGamepads();
		const pad = pads ? pads.find( ( g ) => g && g.connected ) : null;
		if ( ! pad || ! pad.axes ) return;
		// Right-stick X is axis index 2 in the standard Web Gamepad mapping.
		let x = pad.axes[ 2 ] || 0;
		if ( Math.abs( x ) < 0.15 ) x = 0;  // deadzone
		targetRotation += x * 0.05;

	}

	//

	function animate() {

		requestAnimationFrame( animate );

		globalThis.__shapesAnimateCalled = true;
		globalThis.__shapesFrameCount = ( globalThis.__shapesFrameCount | 0 ) + 1;

		pollGamepad();
		render();

		// Replaces upstream `stats.update()`.
		fpsAccumFrames ++;
		const now = Date.now();
		const dt = now - fpsAccumStart;
		if ( dt >= 3000 ) {
			globalThis.__shapesFps = Math.round( fpsAccumFrames * 1000 / dt );
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}

	}

	function render() {

		group.rotation.y += ( targetRotation - group.rotation.y ) * 0.05;
		renderer.resetState();
		renderer.render( scene, camera );

	}

} catch ( err ) {

	const msg = ( err && err.message ) ? err.message : String( err );
	if ( ! globalThis.__shapesError ) {

		globalThis.__shapesError = 'threw: ' + msg
			+ ( err && err.stack ? ' | stack: ' + String( err.stack ).slice( 0, 200 ) : '' );

	}

}
