// Three.js r162 webgl_shadowmap example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_shadowmap.html
//
// Pre-authorized deviations (per the milestone-#20 scope cut):
//   1. Library load: `THREE = globalThis.__THREE_R162_STAGED__`.
//   2. Fullscreen-responsive: canvas dimensions read at script-load time
//      so the demo auto-scales when the shell reruns it at 1280×720.
//      `window.innerWidth/Height`, `setPixelRatio`, resize listener dropped.
//   3. Stable Proxy on the WebGL context.
//   4. console.warn/log/error/info silenced.
//   5. `renderer.resetState()` before each renderer.render.
//   6. `renderer.setSize(W, H, false)` — skip Three.js's
//      `canvas.style.width =` write.
//   7. FirstPersonControls → SwitchOrbitControls (gamepad left-stick orbit).
//   8. Stats addon stubbed.
//   9. **Asset stack DROPPED**: GLTFLoader + 9 GLB models (Horse×6 +
//      Flamingo + Stork + Parrot) + AnimationMixer + morph-target
//      animation + FontLoader + TextGeometry + ShadowMapViewer HUD.
//      Replaced with 6 simple primitives (2 boxes, 2 spheres, 2 torus)
//      at varying heights/positions to make shadow casting visually
//      obvious. The scene still hits every shadow path the bridge
//      auto-promote needs to exercise.
//  10. Shadow map size reduced 2048×1024 → 512×512 for Citron perf.
//  11. Camera FOV/near/far brought in closer (50° / 1 / 200) to match
//      the reduced-scale scene; upstream's 23°/10/3000 is sized for
//      its 100×-scaled ground plane + 200-unit text geometry.
//
// Bridge requirements this milestone forced (see [[swb-threejs-webgl-shadowmap]]):
//   - Auto-promote of Three.js's shadow shaders to raw_passthrough via
//     two new compileShader source-scan markers:
//       - `#define USE_SHADOWMAP` (forward shadow-receive shaders)
//       - `#define DEPTH_PACKING` (MeshDepthMaterial shadow-cast shader)
//     See [[bridge-raw-shader-passthrough]].
//   - **Critical** `nx_webgl_uniform1i` fix: was rejecting bool/int
//     uniforms + sampler bindings to non-zero texture units. Without
//     this, Three.js's `uniform bool receiveShadow` gate in
//     `getShadowMask()` stayed false → shadows invisible despite a
//     correctly-populated shadow map. See [[nxjs-uniform1i-fix]].

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) throw new Error('THREE not loaded - is libs/three.iife.js missing?');
	if (!globalThis.SwitchOrbitControls) throw new Error('SwitchOrbitControls not loaded - is libs/orbit-controls.js missing?');

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	const SHADOW_MAP_WIDTH = 512;
	const SHADOW_MAP_HEIGHT = 512;

	const smCanvasEl = document.getElementById('sm-canvas');
	const SCREEN_WIDTH = (smCanvasEl && smCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (smCanvasEl && smCanvasEl.height) || 360;
	const FLOOR = -10;
	const NEAR = 1, FAR = 200;

	let camera, scene, renderer, controls, light;

	const canvas = smCanvasEl;
	if (!canvas) throw new Error('#sm-canvas missing in HTML');
	const gl = canvas.getContext('webgl', {
		alpha: false,
		antialias: false,
		depth: true,
		stencil: false,
		preserveDrawingBuffer: false,
	});
	if (!gl) throw new Error('WebGL acquire failed');
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
	globalThis.__smFrameCount = 0;
	globalThis.__smFps = 0;

	init();
	animate();

	function init() {
		// CAMERA
		camera = new THREE.PerspectiveCamera(50, SCREEN_WIDTH / SCREEN_HEIGHT, NEAR, FAR);
		camera.position.set(20, 15, 30);
		camera.lookAt(0, 0, 0);

		// SCENE
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0x59472b);
		scene.fog = new THREE.Fog(0x59472b, 60, FAR);

		// LIGHTS
		const ambient = new THREE.AmbientLight(0xffffff, 0.4);
		scene.add(ambient);

		light = new THREE.DirectionalLight(0xffffff, 1.5);
		light.position.set(15, 30, 20);
		light.castShadow = true;
		light.shadow.camera.top = 30;
		light.shadow.camera.bottom = -30;
		light.shadow.camera.left = -30;
		light.shadow.camera.right = 30;
		light.shadow.camera.near = 1;
		light.shadow.camera.far = 80;
		light.shadow.bias = 0.0001;
		light.shadow.mapSize.width = SHADOW_MAP_WIDTH;
		light.shadow.mapSize.height = SHADOW_MAP_HEIGHT;
		scene.add(light);

		createScene();

		// RENDERER
		renderer = new THREE.WebGLRenderer({
			canvas,
			context,
			antialias: false,
			alpha: false,
			depth: true,
			stencil: false,
			preserveDrawingBuffer: false,
		});
		renderer.setSize(SCREEN_WIDTH, SCREEN_HEIGHT, false);
		renderer.autoClear = false;

		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFShadowMap;

		// CONTROLS — FirstPersonControls → SwitchOrbitControls.
		controls = new globalThis.SwitchOrbitControls(THREE, camera);
		controls.enableDamping = true;
	}

	function createScene() {
		// GROUND
		const groundGeometry = new THREE.PlaneGeometry(60, 60, 4, 4);
		const groundMaterial = new THREE.MeshPhongMaterial({ color: 0xffdd99 });
		const ground = new THREE.Mesh(groundGeometry, groundMaterial);
		ground.position.set(0, FLOOR, 0);
		ground.rotation.x = -Math.PI / 2;
		ground.castShadow = false;
		ground.receiveShadow = true;
		scene.add(ground);

		// 6 caster primitives: 2 boxes, 2 spheres, 2 torus, at varying
		// heights/positions to make the shadow casting visually obvious.

		// Box 1 — large, near origin.
		const box1Geo = new THREE.BoxGeometry(5, 5, 5, 2, 2, 2);
		const box1Mat = new THREE.MeshPhongMaterial({ color: 0x88aaff });
		const box1 = new THREE.Mesh(box1Geo, box1Mat);
		box1.position.set(-6, FLOOR + 2.5, 0);
		box1.castShadow = true;
		box1.receiveShadow = true;
		scene.add(box1);

		// Box 2 — small, off to the side.
		const box2Geo = new THREE.BoxGeometry(3, 3, 3, 2, 2, 2);
		const box2Mat = new THREE.MeshPhongMaterial({ color: 0xffaa88 });
		const box2 = new THREE.Mesh(box2Geo, box2Mat);
		box2.position.set(8, FLOOR + 1.5, -6);
		box2.castShadow = true;
		box2.receiveShadow = true;
		scene.add(box2);

		// Sphere 1 — mid-height.
		const sph1Geo = new THREE.SphereGeometry(2, 24, 16);
		const sph1Mat = new THREE.MeshPhongMaterial({ color: 0xaaffaa });
		const sph1 = new THREE.Mesh(sph1Geo, sph1Mat);
		sph1.position.set(0, FLOOR + 5, 5);
		sph1.castShadow = true;
		sph1.receiveShadow = true;
		scene.add(sph1);

		// Sphere 2 — small, low.
		const sph2Geo = new THREE.SphereGeometry(1.5, 24, 16);
		const sph2Mat = new THREE.MeshPhongMaterial({ color: 0xffff88 });
		const sph2 = new THREE.Mesh(sph2Geo, sph2Mat);
		sph2.position.set(5, FLOOR + 1.5, 6);
		sph2.castShadow = true;
		sph2.receiveShadow = true;
		scene.add(sph2);

		// Torus 1 — flat ring, mid-height.
		const tor1Geo = new THREE.TorusGeometry(2, 0.6, 12, 24);
		const tor1Mat = new THREE.MeshPhongMaterial({ color: 0xff88aa });
		const tor1 = new THREE.Mesh(tor1Geo, tor1Mat);
		tor1.position.set(-7, FLOOR + 4, -6);
		tor1.rotation.x = Math.PI / 2;
		tor1.castShadow = true;
		tor1.receiveShadow = true;
		scene.add(tor1);

		// Torus 2 — upright, off-axis.
		const tor2Geo = new THREE.TorusGeometry(1.8, 0.5, 12, 24);
		const tor2Mat = new THREE.MeshPhongMaterial({ color: 0xaaaaff });
		const tor2 = new THREE.Mesh(tor2Geo, tor2Mat);
		tor2.position.set(4, FLOOR + 3.5, -2);
		tor2.rotation.y = Math.PI / 4;
		tor2.castShadow = true;
		tor2.receiveShadow = true;
		scene.add(tor2);
	}

	function animate() {
		requestAnimationFrame(animate);

		controls.update();

		renderer.resetState();
		renderer.clear();
		renderer.render(scene, camera);

		globalThis.__smFrameCount = (globalThis.__smFrameCount | 0) + 1;
		fpsAccumFrames++;
		const now = Date.now();
		if (now - fpsAccumStart >= 3000) {
			globalThis.__smFps = Math.round((fpsAccumFrames * 1000) / (now - fpsAccumStart));
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}
	}

} catch (e) {
	globalThis.__smError = String(e && e.message ? e.message : e);
}
