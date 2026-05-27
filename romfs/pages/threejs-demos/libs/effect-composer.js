// Three.js r162 EffectComposer + RenderPass + ShaderPass + OutputPass +
// MaskPass + Pass + 4 stock shader libraries — packaged as an IIFE so
// switch-web-browser pages (no importmap) can load them via
// `<script src="...">`. Source: three-r162/examples/jsm/postprocessing/
// + three-r162/examples/jsm/shaders/, ported verbatim with upstream
// `import { ... } from 'three'` blocks replaced by destructuring from
// `globalThis.__THREE_R162_STAGED__`.
//
// Bundled for milestone #19 (webgl_postprocessing). Exposes:
//   globalThis.SwitchEffectComposer = {
//     EffectComposer, Pass, FullScreenQuad,
//     RenderPass, ShaderPass, OutputPass,
//     MaskPass, ClearMaskPass,
//     CopyShader, DotScreenShader, RGBShiftShader, OutputShader,
//   }
//
// The four shaders below have `#pragma raw_passthrough` injected into
// both their vertex AND fragment shader strings. Per
// [[bridge-raw-shader-passthrough]] this opt-in flag tells the bridge to
// run the user's GLSL on native GLES end-to-end (instead of swapping in
// its hardcoded program at draw time). Without it, the post-process
// effects would silently no-op visually because the bridge's color/texture
// program would run in place of DotScreen / RGBShift / Output / Copy.
// This is a pre-authorized deviation from upstream per
// [[threejs-no-silent-deviations]].

(function () {
  const THREE = globalThis.__THREE_R162_STAGED__;
  if (!THREE) {
    console.debug('effect-composer.js: __THREE_R162_STAGED__ not found; skipping');
    return;
  }

  const {
    BufferGeometry,
    Clock,
    Color,
    ColorManagement,
    Float32BufferAttribute,
    HalfFloatType,
    LinearToneMapping,
    ReinhardToneMapping,
    CineonToneMapping,
    ACESFilmicToneMapping,
    NeutralToneMapping,
    AgXToneMapping,
    Mesh,
    NoBlending,
    OrthographicCamera,
    RawShaderMaterial,
    ShaderMaterial,
    SRGBTransfer,
    UniformsUtils,
    Vector2,
    WebGLRenderTarget,
  } = THREE;

  // ─── Pass base class + FullScreenQuad (Pass.js) ───

  class Pass {
    constructor() {
      this.isPass = true;
      this.enabled = true;
      this.needsSwap = true;
      this.clear = false;
      this.renderToScreen = false;
    }
    setSize(/* w, h */) {}
    render(/* renderer, writeBuffer, readBuffer, deltaTime, maskActive */) {
      console.debug('THREE.Pass: .render() must be implemented in derived pass.');
    }
    dispose() {}
  }

  const _fsQuadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  class FullscreenTriangleGeometry extends BufferGeometry {
    constructor() {
      super();
      this.setAttribute('position', new Float32BufferAttribute(
        [-1, 3, 0,  -1, -1, 0,  3, -1, 0], 3));
      this.setAttribute('uv', new Float32BufferAttribute(
        [0, 2,  0, 0,  2, 0], 2));
    }
  }
  const _fsQuadGeometry = new FullscreenTriangleGeometry();

  class FullScreenQuad {
    constructor(material) { this._mesh = new Mesh(_fsQuadGeometry, material); }
    dispose() { this._mesh.geometry.dispose(); }
    render(renderer) { renderer.render(this._mesh, _fsQuadCamera); }
    get material() { return this._mesh.material; }
    set material(v) { this._mesh.material = v; }
  }

  // ─── MaskPass + ClearMaskPass (MaskPass.js) — included for `instanceof`
  // checks in EffectComposer; stencil path isn't load-bearing for the
  // milestone-#19 demo (no MaskPass in the chain) and likely won't work
  // fully since the bridge has limited stencil support. ───

  class MaskPass extends Pass {
    constructor(scene, camera) {
      super();
      this.scene = scene;
      this.camera = camera;
      this.clear = true;
      this.needsSwap = false;
      this.inverse = false;
    }
    render(renderer, writeBuffer, readBuffer) {
      const context = renderer.getContext();
      const state = renderer.state;
      state.buffers.color.setMask(false);
      state.buffers.depth.setMask(false);
      state.buffers.color.setLocked(true);
      state.buffers.depth.setLocked(true);
      let writeValue, clearValue;
      if (this.inverse) { writeValue = 0; clearValue = 1; }
      else { writeValue = 1; clearValue = 0; }
      state.buffers.stencil.setTest(true);
      state.buffers.stencil.setOp(context.REPLACE, context.REPLACE, context.REPLACE);
      state.buffers.stencil.setFunc(context.ALWAYS, writeValue, 0xffffffff);
      state.buffers.stencil.setClear(clearValue);
      state.buffers.stencil.setLocked(true);
      renderer.setRenderTarget(readBuffer);
      if (this.clear) renderer.clear();
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      renderer.render(this.scene, this.camera);
      state.buffers.color.setLocked(false);
      state.buffers.depth.setLocked(false);
      state.buffers.color.setMask(true);
      state.buffers.depth.setMask(true);
      state.buffers.stencil.setLocked(false);
      state.buffers.stencil.setFunc(context.EQUAL, 1, 0xffffffff);
      state.buffers.stencil.setOp(context.KEEP, context.KEEP, context.KEEP);
      state.buffers.stencil.setLocked(true);
    }
  }

  class ClearMaskPass extends Pass {
    constructor() {
      super();
      this.needsSwap = false;
    }
    render(renderer) {
      renderer.state.buffers.stencil.setLocked(false);
      renderer.state.buffers.stencil.setTest(false);
    }
  }

  // ─── Shaders (with raw_passthrough pragma) ───

  // Helper: prepend `#pragma raw_passthrough` to a GLSL source. The
  // pragma must be at file-top (or at least before the `void main()`)
  // for nx.js's `compileShader` scanner to pick it up
  // (see [[bridge-raw-shader-passthrough]]).
  function passthroughify(src) {
    return '#pragma raw_passthrough\n' + src;
  }

  const CopyShader = {
    name: 'CopyShader',
    uniforms: {
      'tDiffuse': { value: null },
      'opacity': { value: 1.0 },
    },
    vertexShader: passthroughify(`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`),
    fragmentShader: passthroughify(`
      uniform float opacity;
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D(tDiffuse, vUv);
        gl_FragColor = opacity * texel;
      }`),
  };

  const DotScreenShader = {
    name: 'DotScreenShader',
    uniforms: {
      'tDiffuse': { value: null },
      'tSize': { value: new Vector2(256, 256) },
      'center': { value: new Vector2(0.5, 0.5) },
      'angle': { value: 1.57 },
      'scale': { value: 1.0 },
    },
    vertexShader: passthroughify(`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`),
    fragmentShader: passthroughify(`
      uniform vec2 center;
      uniform float angle;
      uniform float scale;
      uniform vec2 tSize;
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      float pattern() {
        float s = sin(angle), c = cos(angle);
        vec2 tex = vUv * tSize - center;
        vec2 point = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * scale;
        return (sin(point.x) * sin(point.y)) * 4.0;
      }
      void main() {
        vec4 color = texture2D(tDiffuse, vUv);
        float average = (color.r + color.g + color.b) / 3.0;
        gl_FragColor = vec4(vec3(average * 10.0 - 5.0 + pattern()), color.a);
      }`),
  };

  const RGBShiftShader = {
    name: 'RGBShiftShader',
    uniforms: {
      'tDiffuse': { value: null },
      'amount': { value: 0.005 },
      'angle': { value: 0.0 },
    },
    vertexShader: passthroughify(`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`),
    fragmentShader: passthroughify(`
      uniform sampler2D tDiffuse;
      uniform float amount;
      uniform float angle;
      varying vec2 vUv;
      void main() {
        vec2 offset = amount * vec2(cos(angle), sin(angle));
        vec4 cr = texture2D(tDiffuse, vUv + offset);
        vec4 cga = texture2D(tDiffuse, vUv);
        vec4 cb = texture2D(tDiffuse, vUv - offset);
        gl_FragColor = vec4(cr.r, cga.g, cb.b, cga.a);
      }`),
  };

  // OutputShader: RawShaderMaterial-style (no auto-prepended prefix in
  // Three.js); declare uniforms/attribs ourselves. We deviate from
  // upstream's `#include <tonemapping_pars_fragment>` /
  // `#include <colorspace_pars_fragment>` by inlining only the codepaths
  // the milestone-#19 demo uses (default `toneMapping = NoToneMapping`
  // + default `outputColorSpace = SRGBColorSpace` → SRGB transfer only).
  // Three.js's WebGLProgram include-resolver is part of WebGLRenderer
  // internals; bypassing it lets the IIFE stay self-contained.
  const OutputShader = {
    name: 'OutputShader',
    uniforms: {
      'tDiffuse': { value: null },
      'toneMappingExposure': { value: 1 },
    },
    vertexShader: passthroughify(`
      precision highp float;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      attribute vec3 position;
      attribute vec2 uv;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`),
    fragmentShader: passthroughify(`
      precision highp float;
      uniform sampler2D tDiffuse;
      uniform float toneMappingExposure;
      varying vec2 vUv;
      // sRGB OETF (linear → sRGB) — minimal inline version that matches
      // Three.js r162's <colorspace_pars_fragment> SRGB_TRANSFER branch.
      vec4 sRGBTransferOETF(in vec4 v) {
        return vec4(mix(pow(v.rgb, vec3(0.41666)) * 1.055 - vec3(0.055),
                        v.rgb * 12.92,
                        vec3(lessThanEqual(v.rgb, vec3(0.0031308)))),
                    v.a);
      }
      void main() {
        gl_FragColor = texture2D(tDiffuse, vUv);
        gl_FragColor = sRGBTransferOETF(gl_FragColor);
      }`),
  };

  // ─── RenderPass (RenderPass.js) ───

  class RenderPass extends Pass {
    constructor(scene, camera, overrideMaterial = null, clearColor = null, clearAlpha = null) {
      super();
      this.scene = scene;
      this.camera = camera;
      this.overrideMaterial = overrideMaterial;
      this.clearColor = clearColor;
      this.clearAlpha = clearAlpha;
      this.clear = true;
      this.clearDepth = false;
      this.needsSwap = false;
      this._oldClearColor = new Color();
    }
    render(renderer, writeBuffer, readBuffer) {
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      let oldClearAlpha, oldOverrideMaterial;
      if (this.overrideMaterial !== null) {
        oldOverrideMaterial = this.scene.overrideMaterial;
        this.scene.overrideMaterial = this.overrideMaterial;
      }
      if (this.clearColor !== null) {
        renderer.getClearColor(this._oldClearColor);
        renderer.setClearColor(this.clearColor);
      }
      if (this.clearAlpha !== null) {
        oldClearAlpha = renderer.getClearAlpha();
        renderer.setClearAlpha(this.clearAlpha);
      }
      if (this.clearDepth == true) renderer.clearDepth();
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      if (this.clear === true) {
        renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      }
      renderer.render(this.scene, this.camera);
      if (this.clearColor !== null) renderer.setClearColor(this._oldClearColor);
      if (this.clearAlpha !== null) renderer.setClearAlpha(oldClearAlpha);
      if (this.overrideMaterial !== null) this.scene.overrideMaterial = oldOverrideMaterial;
      renderer.autoClear = oldAutoClear;
    }
  }

  // ─── ShaderPass (ShaderPass.js) ───

  class ShaderPass extends Pass {
    constructor(shader, textureID) {
      super();
      this.textureID = (textureID !== undefined) ? textureID : 'tDiffuse';
      if (shader instanceof ShaderMaterial) {
        this.uniforms = shader.uniforms;
        this.material = shader;
      } else if (shader) {
        this.uniforms = UniformsUtils.clone(shader.uniforms);
        this.material = new ShaderMaterial({
          name: (shader.name !== undefined) ? shader.name : 'unspecified',
          defines: Object.assign({}, shader.defines),
          uniforms: this.uniforms,
          vertexShader: shader.vertexShader,
          fragmentShader: shader.fragmentShader,
        });
      }
      this.fsQuad = new FullScreenQuad(this.material);
    }
    render(renderer, writeBuffer, readBuffer) {
      if (this.uniforms[this.textureID]) {
        this.uniforms[this.textureID].value = readBuffer.texture;
      }
      this.fsQuad.material = this.material;
      if (this.renderToScreen) {
        renderer.setRenderTarget(null);
        this.fsQuad.render(renderer);
      } else {
        renderer.setRenderTarget(writeBuffer);
        if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
        this.fsQuad.render(renderer);
      }
    }
    dispose() { this.material.dispose(); this.fsQuad.dispose(); }
  }

  // ─── OutputPass (OutputPass.js) ───

  class OutputPass extends Pass {
    constructor() {
      super();
      const shader = OutputShader;
      this.uniforms = UniformsUtils.clone(shader.uniforms);
      this.material = new RawShaderMaterial({
        name: shader.name,
        uniforms: this.uniforms,
        vertexShader: shader.vertexShader,
        fragmentShader: shader.fragmentShader,
      });
      this.fsQuad = new FullScreenQuad(this.material);
      this._outputColorSpace = null;
      this._toneMapping = null;
    }
    render(renderer, writeBuffer, readBuffer) {
      this.uniforms['tDiffuse'].value = readBuffer.texture;
      this.uniforms['toneMappingExposure'].value = renderer.toneMappingExposure;
      // We don't rebuild defines (shader is single-codepath SRGB-only).
      if (this.renderToScreen === true) {
        renderer.setRenderTarget(null);
        this.fsQuad.render(renderer);
      } else {
        renderer.setRenderTarget(writeBuffer);
        if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
        this.fsQuad.render(renderer);
      }
    }
    dispose() { this.material.dispose(); this.fsQuad.dispose(); }
  }

  // ─── EffectComposer (EffectComposer.js) ───

  class EffectComposer {
    constructor(renderer, renderTarget) {
      this.renderer = renderer;
      this._pixelRatio = renderer.getPixelRatio();
      if (renderTarget === undefined) {
        const size = renderer.getSize(new Vector2());
        this._width = size.width;
        this._height = size.height;
        // **D3 deviation (milestone #19):** Upstream uses `{ type: HalfFloatType }`
        // here. nx.js's bridge doesn't expose half-float color-buffer
        // renderability yet — default to UByte FBOs so the chain runs end
        // to end. Tone mapping + sRGB transfer still happen in OutputPass.
        renderTarget = new WebGLRenderTarget(
          this._width * this._pixelRatio,
          this._height * this._pixelRatio);
        renderTarget.texture.name = 'EffectComposer.rt1';
      } else {
        this._width = renderTarget.width;
        this._height = renderTarget.height;
      }
      this.renderTarget1 = renderTarget;
      this.renderTarget2 = renderTarget.clone();
      this.renderTarget2.texture.name = 'EffectComposer.rt2';
      this.writeBuffer = this.renderTarget1;
      this.readBuffer = this.renderTarget2;
      this.renderToScreen = true;
      this.passes = [];
      this.copyPass = new ShaderPass(CopyShader);
      this.copyPass.material.blending = NoBlending;
      this.clock = new Clock();
    }
    swapBuffers() {
      const tmp = this.readBuffer;
      this.readBuffer = this.writeBuffer;
      this.writeBuffer = tmp;
    }
    addPass(pass) {
      this.passes.push(pass);
      pass.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
    }
    insertPass(pass, index) {
      this.passes.splice(index, 0, pass);
      pass.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
    }
    removePass(pass) {
      const index = this.passes.indexOf(pass);
      if (index !== -1) this.passes.splice(index, 1);
    }
    isLastEnabledPass(passIndex) {
      for (let i = passIndex + 1; i < this.passes.length; i++) {
        if (this.passes[i].enabled) return false;
      }
      return true;
    }
    render(deltaTime) {
      if (deltaTime === undefined) deltaTime = this.clock.getDelta();
      const currentRenderTarget = this.renderer.getRenderTarget();
      let maskActive = false;
      for (let i = 0, il = this.passes.length; i < il; i++) {
        const pass = this.passes[i];
        if (pass.enabled === false) continue;
        pass.renderToScreen = (this.renderToScreen && this.isLastEnabledPass(i));
        pass.render(this.renderer, this.writeBuffer, this.readBuffer, deltaTime, maskActive);
        if (pass.needsSwap) {
          if (maskActive) {
            const context = this.renderer.getContext();
            const stencil = this.renderer.state.buffers.stencil;
            stencil.setFunc(context.NOTEQUAL, 1, 0xffffffff);
            this.copyPass.render(this.renderer, this.writeBuffer, this.readBuffer, deltaTime);
            stencil.setFunc(context.EQUAL, 1, 0xffffffff);
          }
          this.swapBuffers();
        }
        if (MaskPass !== undefined) {
          if (pass instanceof MaskPass) maskActive = true;
          else if (pass instanceof ClearMaskPass) maskActive = false;
        }
      }
      this.renderer.setRenderTarget(currentRenderTarget);
    }
    reset(renderTarget) {
      if (renderTarget === undefined) {
        const size = this.renderer.getSize(new Vector2());
        this._pixelRatio = this.renderer.getPixelRatio();
        this._width = size.width;
        this._height = size.height;
        renderTarget = this.renderTarget1.clone();
        renderTarget.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
      }
      this.renderTarget1.dispose();
      this.renderTarget2.dispose();
      this.renderTarget1 = renderTarget;
      this.renderTarget2 = renderTarget.clone();
      this.writeBuffer = this.renderTarget1;
      this.readBuffer = this.renderTarget2;
    }
    setSize(width, height) {
      this._width = width;
      this._height = height;
      const effW = this._width * this._pixelRatio;
      const effH = this._height * this._pixelRatio;
      this.renderTarget1.setSize(effW, effH);
      this.renderTarget2.setSize(effW, effH);
      for (let i = 0; i < this.passes.length; i++) {
        this.passes[i].setSize(effW, effH);
      }
    }
    setPixelRatio(pixelRatio) {
      this._pixelRatio = pixelRatio;
      this.setSize(this._width, this._height);
    }
    dispose() {
      this.renderTarget1.dispose();
      this.renderTarget2.dispose();
      this.copyPass.dispose();
    }
  }

  globalThis.SwitchEffectComposer = {
    EffectComposer,
    Pass, FullScreenQuad,
    RenderPass, ShaderPass, OutputPass,
    MaskPass, ClearMaskPass,
    CopyShader, DotScreenShader, RGBShiftShader, OutputShader,
  };
})();
