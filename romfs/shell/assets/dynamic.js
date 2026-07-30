// Example dynamic background — JS + WebGL, shell-driven.
//
// This is the "dynamic.js" counterpart to dynamic.html. The difference
// that matters: this file does NOT own an rAF loop, a <canvas>, or any
// CSS. It exposes a tiny factory the shell drives — the shell owns the
// canvas/GL surface, the frame clock, the resolution scale and the
// pause/idle policy. That is the whole reason JS is cheaper than HTML
// here (see the investigation report): no second live-DOM page, no
// parse/layout/cascade, no independent timer — just a program + a draw.
//
// Contract (proposed):
//   const bg = createDynamicBackground(gl);   // gl: WebGLRenderingContext
//   bg.resize(w, h);                            // on viewport change
//   bg.render(tSeconds);                        // once per background frame
//   bg.dispose();                               // on theme switch / teardown
//
// The shader itself is a faithful port of dynamic.html's water shader.

// ---- tuning knobs (shell may override via the styles.json entry) ----
const DEFAULTS = {
  zoom: 2.5,   // smaller = larger, calmer swells
  // RES (internal render scale) and FPS are owned by the SHELL now,
  // not baked in here — the shell sizes the GL surface and decides how
  // often to call render(). Kept out of this module on purpose.
};

const VS = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;

// Five directional sine waves. Each costs a sin + a cos, and from that
// same pair we get height, slope (for the normal) and laplacian (for
// the caustics).
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 res; uniform float t; uniform float zoom;

#define W(DX,DY,F,A,S) { float ang=(p.x*(DX)+p.y*(DY))*(F)+t*(S); float sn=sin(ang), cs=cos(ang); g+=(A)*(F)*cs*vec2(DX,DY); lap-=(A)*(F)*(F)*sn; }

void main(){
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p  = (gl_FragCoord.xy * 2.0 - res) / res.y * zoom;

  vec2 g = vec2(0.0); float lap = 0.0;
  W( 1.00, 0.00,  2.30, 0.300,  1.10)
  W( 0.60, 0.80,  3.70, 0.200, -1.50)
  W(-0.30, 0.95,  5.30, 0.120,  1.90)
  W(-0.85,-0.53,  8.10, 0.055, -2.40)
  W( 0.42,-0.91, 12.70, 0.028,  3.10)

  vec3 n = normalize(vec3(-g, 1.0));

  vec2 fl = p + n.xy * 0.7;
  float depth = 0.5 + 0.5 * sin(fl.x * 0.33 + 0.7) * cos(fl.y * 0.29 - 0.4);
  vec3 col = mix(vec3(0.015, 0.085, 0.125), vec3(0.045, 0.30, 0.335), depth * 0.75);

  float ca = clamp(-lap * 0.10, 0.0, 1.0);
  col += vec3(0.30, 0.70, 0.72) * ca * ca;
  col += vec3(0.85, 1.00, 0.98) * pow(ca, 7.0) * 0.55;

  float sp = pow(max(dot(n, normalize(vec3(0.55, 0.45, 0.72))), 0.0), 90.0);
  col += vec3(1.0, 0.97, 0.90) * sp * 0.55;

  vec2 q = uv * 2.0 - 1.0;
  col *= 1.0 - 0.30 * dot(q, q);
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

// Factory. Returns null if GL is unavailable / the program won't link,
// so the caller can fall back to the static `background` image cleanly.
export function createDynamicBackground(gl, opts) {
  if (!gl) return null;
  const zoom = (opts && typeof opts.zoom === 'number') ? opts.zoom : DEFAULTS.zoom;

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    return null; // caller falls back to the static background
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'res');
  const uT = gl.getUniformLocation(prog, 't');
  gl.uniform1f(gl.getUniformLocation(prog, 'zoom'), zoom);

  let w = 0, h = 0;

  return {
    resize(nw, nh) {
      w = Math.max(1, nw | 0);
      h = Math.max(1, nh | 0);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);
      gl.uniform2f(uRes, w, h);
    },
    // tSeconds is a monotonically increasing clock the SHELL advances
    // (already scaled for reduced-motion / speed if desired). One draw
    // call, one triangle, no clear needed (opaque full-screen quad).
    render(tSeconds) {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(uT, tSeconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      try { gl.deleteBuffer(buf); } catch (_) {}
      try { gl.deleteProgram(prog); } catch (_) {}
    },
  };
}

export default createDynamicBackground;
