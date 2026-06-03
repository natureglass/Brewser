// Gamepad-driven FirstPersonControls equivalent for switch-web-browser
// Three.js demos.
//
// Mirrors enough of Three.js r162's `FirstPersonControls` (used by
// `webgl_geometry_dynamic` and a handful of others) to drop into demos
// that expect it. Upstream FPC depends on DOM pointer/key events that
// don't exist on nx.js. This module exposes the same surface those
// demos use (`update(delta)`, `movementSpeed`, `lookSpeed`,
// `lookVertical`, `activeLook`, `heightSpeed`, `constrainVertical`,
// `lookAt(...)`, `handleResize()`, `dispose()`) but reads gamepad input
// each `update()` call.
//
// Gamepad mapping:
//   - Right stick (axes 2/3) -> look (yaw delta, pitch delta)
//     -> drives `lon` / `lat` exactly like upstream pointer position
//        drives lat/lon.
//   - B button (index 1)     -> forward  (upstream: left click)
//   - A button (index 0)     -> backward (upstream: right click)
//   - Left stick (axes 0/1)  -> strafe   (upstream: WASD keys)
//
// Pass `THREE` explicitly so the module doesn't assume a particular
// global name.
//
// Usage:
//   const controls = new SwitchFirstPersonControls(THREE, camera);
//   controls.movementSpeed = 500;
//   controls.lookSpeed = 0.1;
//   // in animate():
//   controls.update(delta);
//   renderer.render(scene, camera);

(function () {
  const STICK_DEADZONE = 0.15;

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

  class SwitchFirstPersonControls {
    constructor(THREE, camera) {
      this.THREE = THREE;
      this.object = camera;

      // Public API matching upstream FirstPersonControls field names.
      this.enabled = true;

      this.movementSpeed = 1.0;
      this.lookSpeed = 0.005;

      this.lookVertical = true;
      this.autoForward = false;

      this.activeLook = true;

      this.heightSpeed = false;
      this.heightCoef = 1.0;
      this.heightMin = 0.0;
      this.heightMax = 1.0;

      this.constrainVertical = false;
      this.verticalMin = 0;
      this.verticalMax = Math.PI;

      // Internals — match upstream names so callers can poke them.
      this.autoSpeedFactor = 0.0;
      this.moveForward = false;
      this.moveBackward = false;
      this.moveLeft = false;
      this.moveRight = false;
      this.moveUp = false;
      this.moveDown = false;

      this._lat = 0;
      this._lon = 0;
      this._targetPosition = new THREE.Vector3();

      // Seed lat/lon from camera's current orientation, same as upstream's
      // setOrientation() does. Lets callers `camera.position.set(...)` +
      // optionally `controls.lookAt(...)` and have it stick.
      this._setOrientationFromCamera();
    }

    _setOrientationFromCamera() {
      const THREE = this.THREE;
      const quaternion = this.object.quaternion;
      const lookDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
      const spherical = new THREE.Spherical().setFromVector3(lookDirection);
      this._lat = 90 - THREE.MathUtils.radToDeg(spherical.phi);
      this._lon = THREE.MathUtils.radToDeg(spherical.theta);
    }

    lookAt(x, y, z) {
      const THREE = this.THREE;
      const target = (x && x.isVector3) ? x.clone() : new THREE.Vector3(x, y, z);
      this.object.lookAt(target);
      this._setOrientationFromCamera();
      return this;
    }

    handleResize() { /* no-op — fixed-size canvas */ }

    dispose() { /* no-op — no DOM listeners */ }

    update(delta) {
      if (this.enabled === false) return;
      const THREE = this.THREE;

      // Poll gamepad and translate to move/look flags.
      const pad = pickGamepad();
      let pointerDX = 0;
      let pointerDY = 0;
      if (pad) {
        // B = button 1 = forward, A = button 0 = backward.
        // (Upstream FPC's `onPointerDown`: left click sets moveForward,
        // right click sets moveBackward.)
        this.moveForward = !!(pad.buttons[1] && pad.buttons[1].pressed);
        this.moveBackward = !!(pad.buttons[0] && pad.buttons[0].pressed);

        // Left stick -> strafe + forward/back analog override.
        const lx = applyDeadzone(pad.axes[0] || 0);
        const ly = applyDeadzone(pad.axes[1] || 0);
        if (lx < 0) { this.moveLeft = true; this.moveRight = false; }
        else if (lx > 0) { this.moveRight = true; this.moveLeft = false; }
        else { this.moveLeft = false; this.moveRight = false; }
        // ly < 0 (stick up) = forward, ly > 0 = backward — let it
        // override the button state if the stick is held.
        if (ly < 0) this.moveForward = true;
        else if (ly > 0) this.moveBackward = true;

        // Right stick -> look delta. Upstream FPC reads pointer
        // position (in pixels) and multiplies by `actualLookSpeed`
        // (delta * lookSpeed); we substitute a per-frame stick value
        // scaled to feel like a pointer offset.
        const rx = applyDeadzone(pad.axes[2] || 0);
        const ry = applyDeadzone(pad.axes[3] || 0);
        // 160-pixel-equivalent at full stick deflection: tuned so
        // lookSpeed = 0.1 (upstream demo default) feels natural.
        pointerDX = rx * 160;
        pointerDY = ry * 160;
      } else {
        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
      }

      if (this.heightSpeed) {
        const y = THREE.MathUtils.clamp(this.object.position.y, this.heightMin, this.heightMax);
        const heightDelta = y - this.heightMin;
        this.autoSpeedFactor = delta * (heightDelta * this.heightCoef);
      } else {
        this.autoSpeedFactor = 0.0;
      }

      const actualMoveSpeed = delta * this.movementSpeed;
      if (this.moveForward || (this.autoForward && !this.moveBackward)) {
        this.object.translateZ(-(actualMoveSpeed + this.autoSpeedFactor));
      }
      if (this.moveBackward) this.object.translateZ(actualMoveSpeed);
      if (this.moveLeft) this.object.translateX(-actualMoveSpeed);
      if (this.moveRight) this.object.translateX(actualMoveSpeed);
      if (this.moveUp) this.object.translateY(actualMoveSpeed);
      if (this.moveDown) this.object.translateY(-actualMoveSpeed);

      let actualLookSpeed = delta * this.lookSpeed;
      if (!this.activeLook) actualLookSpeed = 0;

      let verticalLookRatio = 1;
      if (this.constrainVertical) {
        verticalLookRatio = Math.PI / (this.verticalMax - this.verticalMin);
      }

      this._lon -= pointerDX * actualLookSpeed;
      if (this.lookVertical) this._lat -= pointerDY * actualLookSpeed * verticalLookRatio;
      this._lat = Math.max(-85, Math.min(85, this._lat));

      let phi = THREE.MathUtils.degToRad(90 - this._lat);
      const theta = THREE.MathUtils.degToRad(this._lon);
      if (this.constrainVertical) {
        phi = THREE.MathUtils.mapLinear(phi, 0, Math.PI, this.verticalMin, this.verticalMax);
      }

      const position = this.object.position;
      this._targetPosition.setFromSphericalCoords(1, phi, theta).add(position);
      this.object.lookAt(this._targetPosition);
    }
  }

  globalThis.SwitchFirstPersonControls = SwitchFirstPersonControls;
})();
