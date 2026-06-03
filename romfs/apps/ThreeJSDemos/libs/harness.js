// Minimal Khronos WebGL conformance test harness adapted for
// switch-web-browser. Exposes the standard test API
// (description, debug, testPassed/Failed, shouldBe*, WebGLTestUtils,
// finishTest) that tests under WebGL/sdk/tests/conformance/ depend on.
//
// Differences from the upstream js-test-pre.js / webgl-test-utils.js:
//   - Output goes to a `<canvas id="khronos-status">` element on the
//     page instead of `<div id="console">`/innerHTML.
//   - The full log is also written to
//     `sdmc:/switch/brewser/logs/<test>.log` via
//     `Switch.writeFileSync`, so the user can paste-back without
//     screenshot crops.
//   - Test name is sourced from `globalThis.__khronosTestName`, which
//     each test's index.html sets before loading this harness.
//   - `wtu.create3DContext` auto-enables `gl.enableGpuBridgePrototype(true)`
//     so test draws use the bridge path. Same default as our demos.
//   - `console.warn/log/error/info` are silenced (otherwise nx.js flips
//     the canvas into text-render mode and freezes the page — see the
//     `console-error-switches-render-mode` memory).

(function () {
  'use strict';

  console.warn = function () {};
  console.log = function () {};
  console.error = function () {};
  console.info = function () {};

  const log = [];
  let passCount = 0;
  let failCount = 0;
  let finished = false;
  const testName = (typeof globalThis.__khronosTestName === 'string')
    ? globalThis.__khronosTestName : 'unnamed';

  function appendLog(line) { log.push(String(line == null ? '' : line)); }

  function quoteVal(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return '"' + v + '"';
    try { return String(v); } catch (e) { return '[unprintable]'; }
  }

  // ---- Khronos test API (globals) ----

  globalThis.description = function (msg) { appendLog('TEST: ' + (msg || '')); };
  globalThis.debug = function (msg) { appendLog('  ' + (msg || '')); };

  globalThis.testPassed = function (msg) {
    passCount++;
    appendLog('  PASS: ' + msg);
  };

  globalThis.testFailed = function (msg) {
    failCount++;
    appendLog('  FAIL: ' + msg);
  };

  // Khronos tests pass expression STRINGS to shouldBe; we eval them in
  // the global scope. eval inside this IIFE doesn't reach test scope,
  // so we route through globalThis.eval.
  function gEval(expr) { return (0, eval)(expr); }

  globalThis.shouldBe = function (_a, _b, quiet) {
    let av, bv;
    try { av = gEval(_a); }
    catch (e) { globalThis.testFailed(_a + ' threw: ' + e); return; }
    try { bv = gEval(_b); }
    catch (e) { globalThis.testFailed(_b + ' threw: ' + e); return; }
    if (av === bv) {
      if (!quiet) globalThis.testPassed(_a + ' is ' + quoteVal(av));
    } else {
      globalThis.testFailed(_a + ' should be ' + quoteVal(bv) + '. Was ' + quoteVal(av) + '.');
    }
  };
  globalThis.shouldBeTrue = function (a) { globalThis.shouldBe(a, 'true'); };
  globalThis.shouldBeFalse = function (a) { globalThis.shouldBe(a, 'false'); };
  globalThis.shouldBeNull = function (a) { globalThis.shouldBe(a, 'null'); };
  globalThis.shouldBeUndefined = function (a) { globalThis.shouldBe(a, 'undefined'); };
  globalThis.shouldBeNonNull = function (a) {
    let v;
    try { v = gEval(a); }
    catch (e) { globalThis.testFailed(a + ' threw: ' + e); return; }
    if (v != null) globalThis.testPassed(a + ' is non-null');
    else globalThis.testFailed(a + ' should be non-null. Was ' + quoteVal(v));
  };
  globalThis.shouldBeNonZero = function (a) {
    let v;
    try { v = gEval(a); }
    catch (e) { globalThis.testFailed(a + ' threw: ' + e); return; }
    if (v !== 0) globalThis.testPassed(a + ' is non-zero');
    else globalThis.testFailed(a + ' should be non-zero. Was ' + quoteVal(v));
  };

  globalThis.shouldNotThrow = function (expr, opt_msg) {
    try {
      gEval(expr);
      globalThis.testPassed((opt_msg || expr) + ' did not throw');
    } catch (e) {
      globalThis.testFailed((opt_msg || expr) + ' threw: ' + e);
    }
  };

  globalThis.assertMsg = function (assertion, msg) {
    if (assertion) globalThis.testPassed(msg);
    else globalThis.testFailed(msg);
  };

  // ---- WebGLTestUtils ----

  const wtu = {};

  wtu.getDefault3DContextVersion = function () { return 1; };

  // Stock fragment shader Khronos tests use for "any draw, just need
  // a complete program" pattern.
  wtu.simpleColorFragmentShader =
    'precision mediump float;\n' +
    'uniform vec4 u_color;\n' +
    'void main() { gl_FragColor = u_color; }\n';

  wtu.getScript = function (scriptId) {
    const el = document.getElementById(scriptId);
    if (!el) throw new Error('unknown script id: ' + scriptId);
    return el.text || el.textContent || '';
  };

  // Replace `$(name)` placeholders in `str` with values from one or
  // more lookup objects (later objects shadow earlier ones).
  wtu.replaceParams = function (str /*, ...lookups */) {
    const args = arguments;
    return str.replace(/\$\(([^)]+)\)/g, function (_, key) {
      for (let i = 1; i < args.length; i++) {
        if (args[i][key] !== undefined) return args[i][key];
      }
      throw new Error('unknown replaceParams key: ' + key);
    });
  };

  // Reverse-lookup for GL enum names. Only includes the constants
  // Khronos tests commonly print via glEnumToString — extend as needed.
  wtu.glEnumToString = function (gl, value) {
    const known = [
      'NO_ERROR','INVALID_ENUM','INVALID_VALUE','INVALID_OPERATION',
      'INVALID_FRAMEBUFFER_OPERATION','OUT_OF_MEMORY','CONTEXT_LOST_WEBGL',
      'FLOAT','FLOAT_VEC2','FLOAT_VEC3','FLOAT_VEC4',
      'FLOAT_MAT2','FLOAT_MAT3','FLOAT_MAT4',
      'INT','INT_VEC2','INT_VEC3','INT_VEC4',
      'BOOL','BOOL_VEC2','BOOL_VEC3','BOOL_VEC4',
      'SAMPLER_2D','SAMPLER_CUBE',
      'UNSIGNED_BYTE','UNSIGNED_SHORT','UNSIGNED_INT',
      'RGB','RGBA','LUMINANCE','ALPHA','LUMINANCE_ALPHA',
      'TEXTURE_2D','TEXTURE_CUBE_MAP',
      'VERTEX_SHADER','FRAGMENT_SHADER',
      'COMPILE_STATUS','LINK_STATUS','DELETE_STATUS',
      'ACTIVE_UNIFORMS','ACTIVE_ATTRIBUTES',
      'TRIANGLES','TRIANGLE_STRIP','TRIANGLE_FAN',
      'LINES','LINE_STRIP','LINE_LOOP','POINTS',
      'ARRAY_BUFFER','ELEMENT_ARRAY_BUFFER',
      'STATIC_DRAW','DYNAMIC_DRAW','STREAM_DRAW',
      'BLEND','DEPTH_TEST','CULL_FACE','SCISSOR_TEST',
      'BLEND_SRC_RGB','BLEND_SRC_ALPHA','BLEND_DST_RGB','BLEND_DST_ALPHA',
      'ONE','ZERO','SRC_ALPHA','ONE_MINUS_SRC_ALPHA',
    ];
    for (const name of known) {
      // Skip names the gl context doesn't expose at all — otherwise
      // two `undefined` values would falsely compare equal and any
      // unknown enum would print as the first undefined constant in
      // the list.
      if (gl[name] !== undefined && gl[name] === value) return name;
    }
    return '0x' + (value >>> 0).toString(16);
  };

  wtu.create3DContext = function (elementOrId, attribs) {
    const canvas = (typeof elementOrId === 'string')
      ? document.getElementById(elementOrId) : elementOrId;
    if (!canvas) {
      globalThis.testFailed('canvas element not found: ' + elementOrId);
      return null;
    }
    const gl = canvas.getContext('webgl', attribs || {});
    if (!gl) { globalThis.testFailed('getContext("webgl") returned null'); return null; }
    if (typeof gl.enableGpuBridgePrototype === 'function') {
      gl.enableGpuBridgePrototype(true);
    }
    // Drain any error state inherited from a previously-loaded page.
    // The inline-canvas WebGL shares ONE screen-GL context across pages
    // (see [[swb-shared-gl-state-leak]]) and `getContext` doesn't reset
    // `context->error`. Khronos tests expect a fresh context to have
    // NO_ERROR; without this drain, conformance tests run after the
    // demo can fail their first `glErrorShouldBe(NO_ERROR)` assertion
    // on a leftover error from prior dispatch.
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    return gl;
  };

  wtu.loadShader = function (gl, source, type, errFn) {
    const onErr = errFn || globalThis.testFailed;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      onErr('shader compile failed: ' + info);
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  wtu.loadShaderFromScript = function (gl, scriptId, type, errFn) {
    const onErr = errFn || globalThis.testFailed;
    const el = document.getElementById(scriptId);
    if (!el) { onErr('script element not found: ' + scriptId); return null; }
    if (!type) {
      const t = (el.type || (el.getAttribute && el.getAttribute('type')) || '');
      if (t === 'x-shader/x-vertex') type = gl.VERTEX_SHADER;
      else if (t === 'x-shader/x-fragment') type = gl.FRAGMENT_SHADER;
      else { onErr('unknown shader type for ' + scriptId + ': ' + t); return null; }
    }
    const src = el.text || el.textContent || '';
    return wtu.loadShader(gl, src, type, errFn);
  };

  wtu.setupProgram = function (gl, shaders, opt_attribs, opt_locations) {
    const program = gl.createProgram();
    for (let i = 0; i < shaders.length; i++) {
      let sh = shaders[i];
      if (typeof sh === 'string') {
        // String could be a script element id OR inline GLSL source. Try
        // the id first; fall back to inline source.
        const el = document.getElementById(sh);
        if (el) sh = wtu.loadShaderFromScript(gl, shaders[i]);
        else sh = wtu.loadShader(gl, shaders[i],
          i === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
      }
      if (!sh) return null;
      gl.attachShader(program, sh);
    }
    if (opt_attribs) {
      for (let i = 0; i < opt_attribs.length; i++) {
        const loc = (opt_locations && opt_locations[i] !== undefined)
          ? opt_locations[i] : i;
        if (typeof gl.bindAttribLocation === 'function') {
          gl.bindAttribLocation(program, loc, opt_attribs[i]);
        }
      }
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      globalThis.testFailed('program link failed: ' + gl.getProgramInfoLog(program));
      return null;
    }
    gl.useProgram(program);
    return program;
  };

  wtu.setupUnitQuad = function (gl, positionLoc, texLoc) {
    if (positionLoc === undefined) positionLoc = 0;
    const positions = new Float32Array([
      -1, -1, 0,   1, -1, 0,  -1,  1, 0,
      -1,  1, 0,   1, -1, 0,   1,  1, 0,
    ]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0);
    if (texLoc !== undefined) {
      const texcoords = new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]);
      const tb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, tb);
      gl.bufferData(gl.ARRAY_BUFFER, texcoords, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(texLoc);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
    }
    return [buf];
  };

  wtu.drawUnitQuad = function (gl) { gl.drawArrays(gl.TRIANGLES, 0, 6); };

  wtu.setupColorQuad = function (gl) {
    const program = wtu.setupProgram(gl, [
      'attribute vec4 a_position; void main() { gl_Position = a_position; }',
      'precision mediump float; uniform vec4 u_color; void main() { gl_FragColor = u_color; }',
    ], ['a_position']);
    wtu.setupUnitQuad(gl, 0);
    return program;
  };

  wtu.drawFloatColorQuad = function (gl, color) {
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    const loc = gl.getUniformLocation(program, 'u_color');
    if (loc != null) gl.uniform4f(loc, color[0], color[1], color[2], color[3]);
    wtu.drawUnitQuad(gl);
  };

  wtu.glErrorShouldBe = function (gl, glErrors, opt_msg) {
    if (!Array.isArray(glErrors)) glErrors = [glErrors];
    const err = gl.getError();
    if (glErrors.indexOf(err) >= 0) {
      globalThis.testPassed('getError was expected value: 0x' + err.toString(16) +
        (opt_msg ? ' : ' + opt_msg : ''));
    } else {
      globalThis.testFailed('getError expected: ' + glErrors.map(e => '0x' + e.toString(16)).join(' or ') +
        '. Was 0x' + err.toString(16) + (opt_msg ? ' : ' + opt_msg : ''));
    }
  };

  wtu.checkCanvasRect = function (gl, x, y, w, h, expectedColor, msg, errorRange) {
    if (errorRange === undefined) errorRange = 0;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const o = (py * w + px) * 4;
        for (let c = 0; c < 4; c++) {
          if (Math.abs(buf[o + c] - expectedColor[c]) > errorRange) {
            globalThis.testFailed((msg || 'checkCanvasRect') +
              ' at (' + (x + px) + ',' + (y + py) + ') ch=' + c +
              ' expected ' + expectedColor[c] + ' got ' + buf[o + c]);
            return;
          }
        }
      }
    }
    globalThis.testPassed((msg || 'checkCanvasRect') + ' all pixels match [' +
      expectedColor.join(',') + ']');
  };

  wtu.checkCanvas = function (gl, expectedColor, msg, errorRange) {
    wtu.checkCanvasRect(gl, 0, 0,
      gl.drawingBufferWidth || gl.canvas.width,
      gl.drawingBufferHeight || gl.canvas.height,
      expectedColor, msg, errorRange);
  };

  globalThis.WebGLTestUtils = wtu;

  // ---- finishTest: render + write SDMC log file ----

  function renderToStatusCanvas() {
    const canvas = document.getElementById('khronos-status');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#14202d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '12px system-ui';
    ctx.textBaseline = 'top';
    const status = (failCount === 0) ? 'PASS' : 'FAIL';
    ctx.fillStyle = (failCount === 0) ? '#7eda9f' : '#ff8a6c';
    ctx.font = 'bold 14px system-ui';
    ctx.fillText(status + ': ' + passCount + ' passed, ' + failCount +
      ' failed   (' + testName + ')', 12, 10);
    ctx.font = '12px system-ui';
    let py = 32;
    const lineH = 14;
    const maxLines = Math.floor((canvas.height - py - 4) / lineH);
    for (let i = 0; i < log.length && i < maxLines; i++) {
      const line = log[i];
      if (line.indexOf('PASS:') >= 0) ctx.fillStyle = '#7eda9f';
      else if (line.indexOf('FAIL:') >= 0) ctx.fillStyle = '#ff8a6c';
      else if (line.indexOf('TEST:') === 0) ctx.fillStyle = '#ffd35e';
      else ctx.fillStyle = '#c2dafc';
      ctx.fillText(line.slice(0, 140), 12, py);
      py += lineH;
    }
    if (log.length > maxLines) {
      ctx.fillStyle = '#9bb1d6';
      ctx.fillText('... (' + (log.length - maxLines) + ' more lines — see sdmc log)', 12, py);
    }
  }

  function writeSdmcLog() {
    if (typeof Switch === 'undefined' ||
        typeof Switch.writeFileSync !== 'function') {
      return false;
    }
    try { Switch.mkdirSync('sdmc:/switch/brewser/'); } catch (_) {}
    try { Switch.mkdirSync('sdmc:/switch/brewser/webprofiles/'); } catch (_) {}
    try { Switch.mkdirSync('sdmc:/switch/brewser/webprofiles/default/'); } catch (_) {}
    try { Switch.mkdirSync('sdmc:/switch/brewser/logs/'); } catch (_) {}
    try {
      const header = '=== ' + testName + ' === ' +
        new Date().toISOString() + '\n' +
        'RESULT: ' + (failCount === 0 ? 'PASS' : 'FAIL') +
        '  (' + passCount + ' passed, ' + failCount + ' failed)\n\n';
      Switch.writeFileSync(
        'sdmc:/switch/brewser/logs/' + testName + '.log',
        header + log.join('\n') + '\n');
      return true;
    } catch (e) {
      globalThis.__khronosLogWriteError = (e && e.message) || String(e);
      return false;
    }
  }

  globalThis.finishTest = function () {
    if (finished) return;
    finished = true;
    appendLog('=== ' + (failCount === 0 ? 'PASSED' : 'FAILED') +
      ' (' + passCount + ' / ' + (passCount + failCount) + ') ===');
    const wrote = writeSdmcLog();
    if (wrote) {
      appendLog('Log saved: sdmc:/switch/brewser/logs/' +
        testName + '.log');
    } else if (globalThis.__khronosLogWriteError) {
      appendLog('SDMC log write failed: ' + globalThis.__khronosLogWriteError);
    }
    renderToStatusCanvas();
    globalThis.__khronosResult = {
      name: testName,
      passed: passCount,
      failed: failCount,
      status: failCount === 0 ? 'PASS' : 'FAIL',
    };
  };
})();
