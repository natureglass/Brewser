// Gamepad-driven OrbitControls equivalent for switch-web-browser
// Three.js demos.
//
// Mirrors enough of Three.js r162's `OrbitControls` to drop into demos
// that expect it. The upstream OrbitControls is ~1000 LOC and depends
// on DOM event handlers (pointerdown/move/up, wheel, keys) that don't
// exist on nx.js. This module exposes the same surface the demos use
// (`update()`, `enableDamping`, `dampingFactor`, `minDistance`,
// `maxDistance`, `minPolarAngle`, `maxPolarAngle`, `target` Vector3,
// `screenSpacePanning`) but reads gamepad input each `update()` call.
//
// Gamepad mapping:
//   - Left stick (axes 0/1)  → orbit (azimuth + polar angle)
//   - Right stick (axes 2/3) → pan target (left/right, up/down)
//   - ZL / ZR (buttons 6/7)  → zoom in / out (distance to target)
//
// Designed to be attached to a `globalThis.__THREE_R162_STAGED__`-style
// Three.js setup. Pass `THREE` explicitly to the constructor so the
// module doesn't assume a particular global name.
//
// Usage:
//   const controls = new SwitchOrbitControls(THREE, camera);
//   controls.minDistance = 100;
//   controls.maxDistance = 500;
//   controls.maxPolarAngle = Math.PI / 2;
//   controls.enableDamping = true;
//   controls.dampingFactor = 0.05;
//   // in animate():
//   controls.update();
//   renderer.render(scene, camera);

(function () {
  const STICK_DEADZONE = 0.15;
  const ORBIT_SPEED = 0.04;   // radians per frame at full stick deflection
  const PAN_SPEED = 0.02;     // world-units per frame per unit-distance from target
  const ZOOM_SPEED = 0.02;    // fraction of distance per frame while held

  function applyDeadzone(value) {
    const abs = Math.abs(value);
    if (abs < STICK_DEADZONE) return 0;
    return Math.sign(value) * ((abs - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  }

  function pickGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected) return p;
    }
    return null;
  }

  class SwitchOrbitControls {
    constructor(THREE, camera) {
      this.THREE = THREE;
      this.object = camera;
      this.target = new THREE.Vector3(0, 0, 0);

      // Public API matching upstream OrbitControls field names.
      this.enabled = true;
      this.enableDamping = false;
      this.dampingFactor = 0.05;
      this.enableRotate = true;
      this.enableZoom = true;
      // Default OFF — project convention: right stick is reserved for
      // shell navigation, never for orbit-controls pan. Demos that
      // genuinely want pan can opt in via `controls.enablePan = true`.
      this.enablePan = false;
      this.minDistance = 0;
      this.maxDistance = Infinity;
      this.minPolarAngle = 0;
      this.maxPolarAngle = Math.PI;
      this.minAzimuthAngle = -Infinity;
      this.maxAzimuthAngle = Infinity;
      this.screenSpacePanning = false;
      this.rotateSpeed = 1.0;
      this.panSpeed = 1.0;
      this.zoomSpeed = 1.0;
      // Last sampled gamepad axes — exposed for diagnostic overlays so
      // demos can render the raw stick values in their status canvas
      // (helps diagnose Citron / real-Tegra axis mapping discrepancies).
      this._lastAxes = [0, 0, 0, 0];

      // Working state — spherical coords (theta=azimuth, phi=polar)
      // relative to target. Initialized from the current camera pose
      // on first update().
      this._spherical = new THREE.Spherical();
      this._sphericalDelta = new THREE.Spherical();
      this._panOffset = new THREE.Vector3();
      this._initialized = false;
    }

    // Three.js upstream API stub — does nothing here since we don't
    // listen to DOM key events. Demos that call this expect a method
    // to exist; we accept it and ignore.
    listenToKeyEvents(_window) { /* no-op */ }

    // Three.js upstream API: dispose listeners. No listeners to remove.
    dispose() { /* no-op */ }

    update() {
      if (!this.enabled) return false;
      const THREE = this.THREE;
      const camera = this.object;

      if (!this._initialized) {
        // Seed spherical state from the camera's current offset from target.
        const offset = new THREE.Vector3()
          .copy(camera.position).sub(this.target);
        this._spherical.setFromVector3(offset);
        this._initialized = true;
      }

      const pad = pickGamepad();
      if (pad) {
        const ax = applyDeadzone(pad.axes[0] || 0);
        const ay = applyDeadzone(pad.axes[1] || 0);
        const rx = applyDeadzone(pad.axes[2] || 0);
        const ry = applyDeadzone(pad.axes[3] || 0);
        // Cache raw (post-deadzone) axes for diagnostic overlays.
        this._lastAxes[0] = ax; this._lastAxes[1] = ay;
        this._lastAxes[2] = rx; this._lastAxes[3] = ry;
        // Orbit (left stick) — only when enableRotate is true (matches
        // upstream OrbitControls field). Demos like webgl_materials_cubemap
        // keep rotate enabled but disable pan + zoom.
        if (this.enableRotate) {
          this._sphericalDelta.theta -= ax * ORBIT_SPEED * this.rotateSpeed;
          this._sphericalDelta.phi  -= ay * ORBIT_SPEED * this.rotateSpeed;
        }
        // Zoom (ZL / ZR triggers — buttons 6 and 7 in Web Gamepad standard).
        // Gated by enableZoom (upstream OrbitControls field).
        if (this.enableZoom) {
          const zl = pad.buttons[6] && pad.buttons[6].pressed ? 1 : 0;
          const zr = pad.buttons[7] && pad.buttons[7].pressed ? 1 : 0;
          if (zl) this._spherical.radius *= (1 - ZOOM_SPEED * this.zoomSpeed);
          if (zr) this._spherical.radius *= (1 + ZOOM_SPEED * this.zoomSpeed);
        }
        // Pan (right stick) — gated by enablePan (upstream OrbitControls
        // field). Move target left/right + up/down in camera-relative
        // space, scaled by distance so it feels right at any zoom level.
        if (this.enablePan && (rx !== 0 || ry !== 0)) {
          const distance = this._spherical.radius;
          const panX = rx * PAN_SPEED * this.panSpeed * distance;
          const panY = -ry * PAN_SPEED * this.panSpeed * distance;
          // Camera-relative axes
          const right = new THREE.Vector3()
            .setFromMatrixColumn(camera.matrixWorld, 0);
          let up;
          if (this.screenSpacePanning) {
            up = new THREE.Vector3()
              .setFromMatrixColumn(camera.matrixWorld, 1);
          } else {
            up = new THREE.Vector3(0, 1, 0);
          }
          this._panOffset.addScaledVector(right, panX);
          this._panOffset.addScaledVector(up, panY);
        }
      }

      // Integrate spherical delta into current spherical pose.
      const damping = this.enableDamping ? this.dampingFactor : 1.0;
      this._spherical.theta += this._sphericalDelta.theta;
      this._spherical.phi  += this._sphericalDelta.phi;

      // Constraints
      this._spherical.theta = Math.max(this.minAzimuthAngle,
        Math.min(this.maxAzimuthAngle, this._spherical.theta));
      this._spherical.phi = Math.max(this.minPolarAngle,
        Math.min(this.maxPolarAngle, this._spherical.phi));
      // Phi must stay open of 0 and π to avoid gimbal singularity.
      this._spherical.phi = Math.max(0.000001,
        Math.min(Math.PI - 0.000001, this._spherical.phi));
      this._spherical.radius = Math.max(this.minDistance,
        Math.min(this.maxDistance, this._spherical.radius));

      // Apply pan to target.
      this.target.add(this._panOffset);

      // Reconstruct camera position from target + spherical offset.
      const offset = new THREE.Vector3().setFromSpherical(this._spherical);
      camera.position.copy(this.target).add(offset);
      camera.lookAt(this.target);

      // Apply damping: decay deltas toward zero.
      this._sphericalDelta.theta *= (1 - damping);
      this._sphericalDelta.phi  *= (1 - damping);
      this._panOffset.multiplyScalar(1 - damping);

      return true;
    }
  }

  // Export onto a global namespace so demos can pick it up without
  // module syntax (our IIFE-only setup has no module resolution).
  globalThis.SwitchOrbitControls = SwitchOrbitControls;
})();
