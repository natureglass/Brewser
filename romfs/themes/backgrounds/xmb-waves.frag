// Animated wallpaper shader — "xmb-waves" (SIMPLIFIED). WebGL1 fragment shader
// driven by the shell's dynamic-background renderer. The vertex stage +
// full-screen triangle are supplied by the host; this file is ONLY the fragment
// shader and is fully self-contained — the host supplies just two uniforms:
//     uniform vec2  res;   // drawable size in pixels
//     uniform float t;     // seconds since the shell started animating (global timer)
//
// A COMPACT reimplementation of the PlayStation-3 XMB wave layer
// (linkev/PlayStation-3-XMB, MIT; originally Alphardex's CodePen). The faithful
// port did a 100-row per-pixel depth integration — far too big for the Tegra X1
// / Mesa-Nouveau shader compiler (it wouldn't compile, so the wallpaper fell
// back to static). This keeps the visual signature — the XMB blue gradient field
// and a translucent, Fresnel-edged flowing wave sheet — with a small fixed depth
// loop, a single cheap surface eval per step, and a z-slope Fresnel (no
// x-derivative). Same gradient + flow as the original.
//
// PERF — exact wave-march early-out: the sheet height is bounded to |Y| <= 0.193
// clip units, so pixels outside that horizontal band can never be covered and
// skip the whole depth march (bit-for-bit identical output); ~3/4 of the screen.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;   // `t` grows unbounded; highp keeps the motion stable over time
#else
precision mediump float;
#endif
uniform vec2 res; uniform float t;

#define FLOW_SPEED 0.38
// Depth rows integrated per pixel. The original used 100 for a perfectly smooth
// sheet; this is the cost/quality knob — raise for smoother layering, lower if
// it still won't run.
#define STEPS 16

// Background gradient (XMB blue), verbatim from the source.
const vec3 GRAD_TOP = vec3(0.0130588, 0.0314118, 0.0758118);
const vec3 GRAD_BOT = vec3(0.0899608, 0.2163922, 0.4352157);

// Wave-sheet height field. A trimmed analytic stand-in for the original's spline
// displacement + FFD terms: enough (x,z,t) coupling that marching z sweeps the
// sheet up and down and the z-slope reads as the bright Fresnel edge. The height
// is three z-dependent sinusoids plus a z-invariant sway/bias:
//     0.110*sin(x*3 + z*1.7 + flow)          <- term 1  (w = +1.7)
//   + 0.055*sin(x*5 - z*1.2 - flow*1.3)      <- term 2  (w = -1.2)
//   + 0.028*cos(x*8 + z*3   + flow*0.7)      <- term 3  (w = +3.0)
//   + 0.045*sin(x*5.677 + flow) - 0.10       <- sway + bias (no z)
// Rather than a waveY() call per row (4 sin/cos x STEPS+1 rows), main() evals the
// three z-terms once via phase-rotation recurrence (each row is the previous row
// rotated by a fixed dz*w angle) and folds the z-invariant sway into the compare
// axis. Same height field, a fraction of the transcendentals.

void main(){
  vec2 uv = gl_FragCoord.xy / res;
  float sx = uv.x * 2.0 - 1.0;
  float sy = uv.y * 2.0 - 1.0;
  float flow = t * FLOW_SPEED;

  // Background gradient (runs top→bottom, smoothstepped).
  float g = 1.0 - uv.y;
  g = g * g * (3.0 - 2.0 * g);
  vec3 col = mix(GRAD_TOP, GRAD_BOT, g);

  // Wave sheet: march the depth rows, accumulate Fresnel-weighted coverage.
  // Same collapse the original relies on — every fragment of the sheet is white
  // and differs only in alpha, so over-compositing reduces to
  // mix(bg, white, 1 - product(1 - a_i)).
  float pixH = 2.0 / res.y;                 // one pixel, clip units
  float T    = 1.0;                         // transmittance

  // Fold the z-invariant sway + bias into the compare axis once, instead of
  // adding it inside every row eval: it shifts the whole sheet equally, so the
  // row-to-row slope (and thus coverage vs Fresnel) is unchanged.
  float sway = 0.045 * sin(sx * 5.677 + flow) - 0.10;
  float syc  = sy - sway;

  // EXACT early-out. The sheet height is bounded: |Y| <= 0.110+0.055+0.028 =
  // 0.193 clip units. A pixel whose compare axis syc sits farther than that
  // (plus a half-pixel of AA reach) from 0 can never be covered by ANY strip —
  // every strip's `cov` clamps to 0 and T stays 1 — so its colour is exactly the
  // gradient. The sheet only occupies a horizontal band (~1/4 of the screen), so
  // this skips the entire depth march for the other ~3/4. Bit-for-bit identical.
  if (abs(syc) <= 0.193 + 0.5 * pixH){
    float dz = 2.0 / float(STEPS);

    // Phase-rotation recurrence for the three z-terms: seed each sinusoid at the
    // z = -1 row, then advance it by a fixed dz*w rotation per step (the rows are
    // just a rotating unit vector). o*.x = sin, o*.y = cos of that term's phase;
    // term 3 reads the cos component. Replaces 3 sin/cos per row with a mat2 mul.
    vec2 o1 = vec2(sin(sx * 3.0 + flow       - 1.7), cos(sx * 3.0 + flow       - 1.7));
    vec2 o2 = vec2(sin(sx * 5.0 - flow * 1.3 + 1.2), cos(sx * 5.0 - flow * 1.3 + 1.2));
    vec2 o3 = vec2(sin(sx * 8.0 + flow * 0.7 - 3.0), cos(sx * 8.0 + flow * 0.7 - 3.0));
    float d1 = dz * 1.7, d2 = dz * -1.2, d3 = dz * 3.0;
    mat2 R1 = mat2(cos(d1), -sin(d1), sin(d1), cos(d1));
    mat2 R2 = mat2(cos(d2), -sin(d2), sin(d2), cos(d2));
    mat2 R3 = mat2(cos(d3), -sin(d3), sin(d3), cos(d3));
    float prevY = 0.110 * o1.x + 0.055 * o2.x + 0.028 * o3.y;

    for (int i = 1; i <= STEPS; i++){
      o1 = R1 * o1; o2 = R2 * o2; o3 = R3 * o3;   // advance to z = -1 + dz*i
      float Y = 0.110 * o1.x + 0.055 * o2.x + 0.028 * o3.y;

      // Antialiased coverage of this pixel by the strip spanning prevY..Y.
      float lo = min(prevY, Y), hi = max(prevY, Y);
      float cov = clamp((min(hi, syc + 0.5 * pixH) - max(lo, syc - 0.5 * pixH)) / pixH, 0.0, 1.0);

      if (cov > 0.0){
        // Cheap Fresnel: bright where the sheet is steep in z (seen edge-on).
        float Yz = (Y - prevY) / dz;
        float nz = abs(Yz) * inversesqrt(Yz * Yz + 1.0);
        float q  = max(0.0, 1.0 - nz);
        float F  = 0.5 * (q * q) * (q * q);                // pow(...,4) -> mul
        float a  = clamp(F * 0.7 * 0.98, 0.0, 1.0) * cov;   // OPACITY * BRIGHTNESS
        T *= (1.0 - a);
      }
      prevY = Y;
    }
  }
  col = mix(col, vec3(1.0), 1.0 - T);

  // Dither to kill banding on the gradient and the wave glow.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
