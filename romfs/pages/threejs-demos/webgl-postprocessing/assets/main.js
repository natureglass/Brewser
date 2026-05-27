// Three.js r162 webgl_postprocessing example - ported to switch-web-browser.
//
// Source: three-r162/examples/webgl_postprocessing.html
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
//   6. EffectComposer + Pass + RenderPass + ShaderPass + OutputPass +
//      4 stock shaders bundled as IIFE at libs/effect-composer.js
//      (no importmap on our pages). Exposed as
//      `globalThis.SwitchEffectComposer`.
//   7. **(D1, milestone #19)** The four post-process shaders (DotScreen,
//      RGBShift, Copy, Output) ship with `#pragma raw_passthrough`
//      injected into both their vertex and fragment shader sources.
//      Without the pragma the bridge would swap in its hardcoded color
//      program at draw time — the custom shader effects would never run
//      visually. See [[bridge-raw-shader-passthrough]] and
//      [[nxjs-no-custom-fragment-shader]] for the architectural
//      background. The injection is done at script-import time inside
//      effect-composer.js (passthroughify helper); the user `main.js`
//      sees the shader objects unchanged.
//   8. **(D3, milestone #19)** Upstream's `EffectComposer` constructor
//      auto-creates RenderTargets with `{ type: HalfFloatType }`. nx.js's
//      bridge doesn't expose half-float color-buffer renderability yet;
//      the bundle defaults to UByte FBOs instead. Tone mapping + sRGB
//      transfer still happen in OutputPass (just operating on UByte
//      intermediate textures rather than HF16).
//
// Bridge requirement: this milestone introduces the **FBO management
// surface** (createFramebuffer / framebufferTexture2D / etc.) and bridge
// dispatch retargeting via `nx_webgl_egl_set_user_framebuffer`. Three.js's
// `setRenderTarget(rt)` flow binds the RT's FBO and subsequent bridge
// draws render into IT (skipping the bridge's own FBO + readback). The
// final `OutputPass` then `setRenderTarget(null)` rebinds the bridge FBO
// and renders the composited result to screen via the usual readback
// path. See [[bridge-fbo-support]].

globalThis.__ppMainStarted = true;
globalThis.__ppAnimateCalled = false;
globalThis.__ppError = null;
globalThis.__ppFrameCount = 0;
globalThis.__ppRenderCount = 0;
globalThis.__ppFps = 0;
globalThis.__ppFboStatus = '(pending)';
globalThis.__ppPassCount = 0;

try {
	const THREE = globalThis.__THREE_R162_STAGED__;
	if (!THREE) {
		globalThis.__ppError = 'THREE not loaded - is libs/three.iife.js missing?';
		throw new Error('no THREE');
	}
	if (!globalThis.SwitchEffectComposer) {
		globalThis.__ppError = 'SwitchEffectComposer not loaded - is libs/effect-composer.js missing?';
		throw new Error('no EffectComposer');
	}
	const {
		EffectComposer,
		RenderPass,
		ShaderPass,
		OutputPass,
		DotScreenShader,
		RGBShiftShader,
	} = globalThis.SwitchEffectComposer;

	console.warn = () => {};
	console.log = () => {};
	console.error = () => {};
	console.info = () => {};

	// Fullscreen-responsive: read dimensions from the canvas. When the
	// browser-shell reruns this script at 1280×720, the renderer +
	// composer auto-scale.
	const ppCanvasEl = document.getElementById('pp-canvas');
	const SCREEN_WIDTH = (ppCanvasEl && ppCanvasEl.width) || 640;
	const SCREEN_HEIGHT = (ppCanvasEl && ppCanvasEl.height) || 360;

	let camera, scene, renderer, composer, object;

	const canvas = ppCanvasEl;
	if (!canvas) {
		globalThis.__ppError = '#pp-canvas missing in HTML';
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
		globalThis.__ppError = 'WebGL acquire failed';
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
		// setPixelRatio dropped — fixed canvas per unified template.
		// updateStyle=false: nx.js canvas elements have no `.style`
		// property, so Three.js's default `canvas.style.width = ...`
		// write throws "cannot set property 'width' of undefined".
		renderer.setSize(SCREEN_WIDTH, SCREEN_HEIGHT, false);

		//

		camera = new THREE.PerspectiveCamera(70, SCREEN_WIDTH / SCREEN_HEIGHT, 1, 1000);
		camera.position.z = 400;

		scene = new THREE.Scene();
		scene.fog = new THREE.Fog(0x000000, 1, 1000);

		object = new THREE.Object3D();
		scene.add(object);

		const geometry = new THREE.SphereGeometry(1, 4, 4);
		const material = new THREE.MeshPhongMaterial({ color: 0xffffff, flatShading: true });

		for (let i = 0; i < 100; i++) {
			const mesh = new THREE.Mesh(geometry, material);
			mesh.position.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
			mesh.position.multiplyScalar(Math.random() * 400);
			mesh.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
			mesh.scale.x = mesh.scale.y = mesh.scale.z = Math.random() * 50;
			object.add(mesh);
		}

		scene.add(new THREE.AmbientLight(0xcccccc));

		const light = new THREE.DirectionalLight(0xffffff, 3);
		light.position.set(1, 1, 1);
		scene.add(light);

		// postprocessing

		composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));

		const effect1 = new ShaderPass(DotScreenShader);
		effect1.uniforms['scale'].value = 4;
		composer.addPass(effect1);

		const effect2 = new ShaderPass(RGBShiftShader);
		effect2.uniforms['amount'].value = 0.0015;
		composer.addPass(effect2);

		const effect3 = new OutputPass();
		composer.addPass(effect3);

		globalThis.__ppPassCount = composer.passes.length;

		// Smoke-check that FBO setup actually succeeded by querying the
		// bridge for the renderTarget1's framebuffer status. Three.js's
		// WebGLRenderer lazily creates the native FBO on first
		// setRenderTarget — we trigger that here via a no-op bind to
		// generate the status string for the diagnostic canvas.
		try {
			renderer.setRenderTarget(composer.renderTarget1);
			const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
			globalThis.__ppFboStatus = (status === gl.FRAMEBUFFER_COMPLETE)
				? 'COMPLETE (0x' + status.toString(16) + ')'
				: 'INCOMPLETE (0x' + status.toString(16) + ')';
			renderer.setRenderTarget(null);
		} catch (e) {
			globalThis.__ppFboStatus = 'check threw: ' + String(e).slice(0, 40);
		}

		// window.addEventListener('resize', onWindowResize) dropped.
	}

	function animate() {
		globalThis.__ppAnimateCalled = true;
		requestAnimationFrame(animate);

		object.rotation.x += 0.005;
		object.rotation.y += 0.01;

		renderer.resetState();
		composer.render();

		globalThis.__ppRenderCount = (globalThis.__ppRenderCount | 0) + 1;
		globalThis.__ppFrameCount = (globalThis.__ppFrameCount | 0) + 1;
		fpsAccumFrames++;
		const now = Date.now();
		if (now - fpsAccumStart >= 3000) {
			globalThis.__ppFps = Math.round((fpsAccumFrames * 1000) / (now - fpsAccumStart));
			fpsAccumStart = now;
			fpsAccumFrames = 0;
		}
	}

} catch (e) {
	if (!globalThis.__ppError) globalThis.__ppError = String(e && e.message ? e.message : e);
}
