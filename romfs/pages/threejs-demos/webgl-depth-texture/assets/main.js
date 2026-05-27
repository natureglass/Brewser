// Three.js r162 webgl_depth_texture example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_depth_texture.html
//
// Adapted as 1:1 to upstream as possible. Pre-authorized deviations:
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Fullscreen-responsive: canvas dimensions read at script load time
//      so the demo auto-scales when the shell reruns it at 1280×720.
//      `window.innerWidth/Height`, `setPixelRatio`, and the resize
//      listener dropped per the unified template.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. `renderer.setSize(W, H, false)` — skip Three.js's
//      `canvas.style.width =` write (nx.js canvas elements have no
//      `.style`). Standard #19 D4 deviation.
//   7. OrbitControls replaced with gamepad-driven SwitchOrbitControls.
//   8. **(D1, milestone #19.5)** `#pragma raw_passthrough` injected into
//      the post-pass ShaderMaterial's vertex AND fragment GLSL. Without
//      it the bridge's hardcoded texture program runs in place of the
//      depth-visualizing post shader, sampling the color attachment as
//      a regular texture and not running the
//      perspectiveDepthToViewZ/viewZToOrthographicDepth helpers. See
//      [[bridge-raw-shader-passthrough]] and
//      [[nxjs-no-custom-fragment-shader]].
//   9. lil-gui replaced with gamepad cycle: A cycles format (Depth ↔
//      DepthStencil), B cycles type (UnsignedShort ↔ UnsignedInt ↔
//      UnsignedInt248). Preserves the upstream demo's "swap RT depth
//      format at runtime" interactivity without a DOM dependency.
//  10. Stats addon stubbed to no-op.
//  11. Knot count reduced from upstream's 50 to 10. Each
//      TorusKnotGeometry(1, 0.3, 128, 64) has ~24,576 vertices; bridge
//      CPU-side perspective divide makes 50 × that = 1.2M verts/frame
//      Citron-unplayable (~3 FPS). At 10 knots the demo lands closer to
//      a reasonable interactive FPS. Pre-authorized deviation for hw
//      performance.
//
// Bridge requirement: this milestone introduces nx.js's
// **WEBGL_depth_texture extension exposure** + depth-format
// `texImage2D` acceptance. The FBO depth attachment is now a
// sampleable sampler2D (returns normalized depth in `.x`) instead of
// the depth-only renderbuffer that backed every FBO before. See
// [[bridge-depth-texture-support]] for the architectural extension.

globalThis.__dtMainStarted = true;
globalThis.__dtAnimateCalled = false;
globalThis.__dtError = null;
globalThis.__dtFrameCount = 0;
globalThis.__dtRenderCount = 0;
globalThis.__dtFps = 0;
globalThis.__dtFboStatus = '(pending)';
globalThis.__dtCurrentFormat = 'DepthFormat';
globalThis.__dtCurrentType = 'UnsignedShortType';
globalThis.__dtSupportsExtension = false;
globalThis.__dtSetupErr = '(none)';

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__dtError = 'THREE not loaded - is libs/three.iife.js missing?';
		throw new Error('no THREE');
	}
	if (!globalThis.SwitchOrbitControls) {
		globalThis.__dtError = 'SwitchOrbitControls not loaded - is libs/orbit-controls.js missing?';
		throw new Error('no OrbitControls');
	}

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	// Fullscreen-responsive: read dimensions from the canvas.
	const dtCanvasEl = document.getElementById('dt-canvas');
	const SCREEN_WIDTH = (dtCanvasEl && dtCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (dtCanvasEl && dtCanvasEl.height) || 360;

	let camera, scene, renderer, controls;
	let target;
	let postScene, postCamera, postMaterial;
	let supportsExtension = true;

	const params = {
		format: THREE.DepthFormat,
		type: THREE.UnsignedShortType,
	};

	const formats = {
		DepthFormat: THREE.DepthFormat,
		DepthStencilFormat: THREE.DepthStencilFormat,
	};
	const types = {
		UnsignedShortType: THREE.UnsignedShortType,
		UnsignedIntType: THREE.UnsignedIntType,
		UnsignedInt248Type: THREE.UnsignedInt248Type,
	};

	const canvas = dtCanvasEl;
	if (!canvas) {
		globalThis.__dtError = '#dt-canvas missing in HTML';
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
		globalThis.__dtError = 'WebGL acquire failed';
		throw new Error('no gl');
	}
	if (typeof gl.enableGpuBridgePrototype === 'function') {
		gl.enableGpuBridgePrototype(true);
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

	// Gamepad button-edge tracking for the format/type cycle. Polled
	// in animate() each frame.
	let prevA = false;
	let prevB = false;

	init();
	animate();

	function init() {
		renderer = new THREE.WebGLRenderer({
			canvas,
			context,
			antialias: false,
			alpha: false,
			depth: true,
			stencil: false,
			preserveDrawingBuffer: false,
		});

		// Upstream feature-checks the extension here. Three.js's
		// `renderer.extensions.has('WEBGL_depth_texture')` reaches the
		// underlying getExtension; we expose it from nx.js now.
		if (renderer.capabilities.isWebGL2 === false &&
		    renderer.extensions.has('WEBGL_depth_texture') === false) {
			supportsExtension = false;
			globalThis.__dtError = 'WEBGL_depth_texture extension not supported';
			return;
		}
		supportsExtension = true;
		globalThis.__dtSupportsExtension = true;

		// setPixelRatio dropped (fixed canvas per unified template).
		renderer.setSize(SCREEN_WIDTH, SCREEN_HEIGHT, false);

		camera = new THREE.PerspectiveCamera(70, SCREEN_WIDTH / SCREEN_HEIGHT, 0.01, 50);
		camera.position.z = 4;

		controls = new globalThis.SwitchOrbitControls(THREE, camera);
		controls.enableDamping = true;

		// Create a render target with depth texture
		setupRenderTarget();

		// Our scene
		setupScene();

		// Setup post-processing step
		setupPost();

		onWindowResize();
		// window.addEventListener('resize', onWindowResize) dropped.
	}

	function setupRenderTarget() {
		if (target) target.dispose();

		const format = +params.format;
		const type = +params.type;

		target = new THREE.WebGLRenderTarget(SCREEN_WIDTH, SCREEN_HEIGHT);
		target.texture.minFilter = THREE.NearestFilter;
		target.texture.magFilter = THREE.NearestFilter;
		target.stencilBuffer = (format === THREE.DepthStencilFormat) ? true : false;
		target.depthTexture = new THREE.DepthTexture();
		target.depthTexture.format = format;
		target.depthTexture.type = type;

		// Probe FBO completeness after construction. Three.js sets up the
		// FBO lazily on first setRenderTarget; trigger that here so the
		// status canvas can show the result. Also drain + report any GL
		// errors accumulated during the FBO setup — silent texImage2D
		// failures (e.g. depth-format rejected by Tegra) would leave the
		// depth attachment unallocated, which sampling later reads as 0.
		while (gl.getError() !== gl.NO_ERROR) {}  // drain prior frame
		try {
			renderer.setRenderTarget(target);
			const setupErr = gl.getError();
			globalThis.__dtSetupErr = setupErr === gl.NO_ERROR
				? '(none)' : '0x' + setupErr.toString(16);
			const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
			globalThis.__dtFboStatus = (status === gl.FRAMEBUFFER_COMPLETE)
				? 'COMPLETE (0x' + status.toString(16) + ')'
				: 'INCOMPLETE (0x' + status.toString(16) + ')';
			renderer.setRenderTarget(null);
		} catch (e) {
			globalThis.__dtFboStatus = 'check threw: ' + String(e).slice(0, 40);
		}
	}

	function setupPost() {
		// Setup post processing stage
		postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		postMaterial = new THREE.ShaderMaterial({
			vertexShader: passthroughify(`
				varying vec2 vUv;

				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
				}
			`),
			fragmentShader: passthroughify(`
				#include <packing>

				varying vec2 vUv;
				uniform sampler2D tDiffuse;
				uniform sampler2D tDepth;
				uniform float cameraNear;
				uniform float cameraFar;

				float readDepth( sampler2D depthSampler, vec2 coord ) {
					float fragCoordZ = texture2D( depthSampler, coord ).x;
					float viewZ = perspectiveDepthToViewZ( fragCoordZ, cameraNear, cameraFar );
					return viewZToOrthographicDepth( viewZ, cameraNear, cameraFar );
				}

				void main() {
					//vec3 diffuse = texture2D( tDiffuse, vUv ).rgb;
					float depth = readDepth( tDepth, vUv );

					gl_FragColor.rgb = 1.0 - vec3( depth );
					gl_FragColor.a = 1.0;
				}
			`),
			uniforms: {
				cameraNear: { value: camera.near },
				cameraFar: { value: camera.far },
				tDiffuse: { value: null },
				tDepth: { value: null },
			},
		});
		const postPlane = new THREE.PlaneGeometry(2, 2);
		const postQuad = new THREE.Mesh(postPlane, postMaterial);
		postScene = new THREE.Scene();
		postScene.add(postQuad);
	}

	// Inject `#pragma raw_passthrough` at the top of a GLSL source so the
	// bridge's compile-shader scanner ([[bridge-raw-shader-passthrough]])
	// marks the program for native-GLES dispatch instead of swapping in
	// the bridge's hardcoded shader at draw time.
	function passthroughify(src) {
		return '#pragma raw_passthrough\n' + src;
	}

	function setupScene() {
		scene = new THREE.Scene();

		const geometry = new THREE.TorusKnotGeometry(1, 0.3, 128, 64);
		const material = new THREE.MeshBasicMaterial({ color: 'blue' });

		// Upstream uses count=50, but each TorusKnotGeometry(1,0.3,128,64)
		// has ~24,576 verts, and the bridge does CPU-side perspective
		// divide per vertex → 1.2M verts/frame at 50 knots tanks Citron to
		// 3 FPS. 10 knots ≈ 245K verts/frame, much closer to playable.
		// Pre-authorized deviation for hw FPS.
		const count = 10;
		const scale = 5;

		for (let i = 0; i < count; i++) {
			const r = Math.random() * 2.0 * Math.PI;
			const z = (Math.random() * 2.0) - 1.0;
			const zScale = Math.sqrt(1.0 - z * z) * scale;

			const mesh = new THREE.Mesh(geometry, material);
			mesh.position.set(
				Math.cos(r) * zScale,
				Math.sin(r) * zScale,
				z * scale,
			);
			mesh.rotation.set(Math.random(), Math.random(), Math.random());
			scene.add(mesh);
		}
	}

	function onWindowResize() {
		camera.aspect = SCREEN_WIDTH / SCREEN_HEIGHT;
		camera.updateProjectionMatrix();
		target.setSize(SCREEN_WIDTH, SCREEN_HEIGHT);
		renderer.setSize(SCREEN_WIDTH, SCREEN_HEIGHT, false);
	}

	function cycleFormat() {
		const keys = Object.keys(formats);
		const idx = keys.indexOf(globalThis.__dtCurrentFormat);
		const next = keys[(idx + 1) % keys.length];
		globalThis.__dtCurrentFormat = next;
		params.format = formats[next];
		// DepthStencilFormat only pairs with UnsignedInt248Type; auto-switch
		// type if the current pairing becomes invalid.
		if (params.format === THREE.DepthStencilFormat &&
		    params.type !== THREE.UnsignedInt248Type) {
			params.type = THREE.UnsignedInt248Type;
			globalThis.__dtCurrentType = 'UnsignedInt248Type';
		} else if (params.format === THREE.DepthFormat &&
		           params.type === THREE.UnsignedInt248Type) {
			params.type = THREE.UnsignedShortType;
			globalThis.__dtCurrentType = 'UnsignedShortType';
		}
		setupRenderTarget();
	}

	function cycleType() {
		// Only meaningful for DepthFormat; DepthStencilFormat is locked to
		// UnsignedInt248Type.
		if (params.format === THREE.DepthStencilFormat) return;
		const cur = globalThis.__dtCurrentType;
		const next = (cur === 'UnsignedShortType')
			? 'UnsignedIntType' : 'UnsignedShortType';
		globalThis.__dtCurrentType = next;
		params.type = types[next];
		setupRenderTarget();
	}

	function pollGamepad() {
		const pads = (typeof navigator !== 'undefined' && navigator.getGamepads)
			? navigator.getGamepads() : null;
		if (!pads) return;
		const gp = pads[0];
		if (!gp) return;
		// Standard Switch gamepad mapping: button 0 = B, button 1 = A,
		// button 2 = Y, button 3 = X (matches other demos in this suite).
		const aDown = !!(gp.buttons[1] && gp.buttons[1].pressed);
		const bDown = !!(gp.buttons[0] && gp.buttons[0].pressed);
		if (aDown && !prevA) cycleFormat();
		if (bDown && !prevB) cycleType();
		prevA = aDown;
		prevB = bDown;
	}

	function animate() {
		if (!supportsExtension) return;
		globalThis.__dtAnimateCalled = true;
		requestAnimationFrame(animate);

		pollGamepad();

		// render scene into target
		renderer.resetState();
		renderer.setRenderTarget(target);
		renderer.render(scene, camera);

		// render post FX
		postMaterial.uniforms.tDiffuse.value = target.texture;
		postMaterial.uniforms.tDepth.value = target.depthTexture;

		renderer.resetState();
		renderer.setRenderTarget(null);
		renderer.render(postScene, postCamera);

		controls.update(); // required because damping is enabled

		globalThis.__dtRenderCount = (globalThis.__dtRenderCount | 0) + 1;
		globalThis.__dtFrameCount = (globalThis.__dtFrameCount | 0) + 1;
		fpsAccumFrames++;
		const now = Date.now();
		if (now - fpsAccumStart >= 3000) {
			globalThis.__dtFps = Math.round((fpsAccumFrames * 1000) / (now - fpsAccumStart));
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}
	}

} catch (e) {
	if (!globalThis.__dtError) globalThis.__dtError = String(e && e.message ? e.message : e);
}
