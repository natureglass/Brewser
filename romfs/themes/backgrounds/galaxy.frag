// Animated wallpaper shader — "galaxy". WebGL1 fragment shader driven by the
// shell's dynamic-background renderer (runtime `presentDynamicBackground`).
// The vertex stage + full-screen triangle are supplied by the host; this file
// is ONLY the fragment shader and is fully self-contained — the host supplies
// just two uniforms:
//     uniform vec2  res;   // drawable size in pixels
//     uniform float t;     // global animation clock, seconds (host-reset on select)
//
// Extracted from D:\Downloads\galaxy-swirl.html (the page named these `uR`/`uT`;
// renamed to the host's `res`/`t`). A tilted, squashed spiral disc: slow rigid
// rotation plus a static 1/r differential shear that winds fbm noise into two
// spiral arms (kept time-independent so the arms never over-wind), with dust
// lanes, H-II knots, a warm nucleus and a twinkling star field front and back.
//
// ---------- PERFORMANCE ----------
// The three `fbm` fields are ~two-thirds of the per-pixel cost, so speed is
// governed by (a) how many octaves each fbm runs and (b) how many pixels run
// the galaxy path at all. Two levers, both tuned to be visually near-lossless:
//   * FBM_OCT   — octaves per fbm. 6 = original. Octaves 4-6 sit below the
//                 tone-map/vignette floor on a full-screen background, so 3 is
//                 near-indistinguishable. Normalization (÷ total amplitude)
//                 keeps CONTRAST fixed as octaves drop, so arm brightness and
//                 every downstream threshold stay valid — only fine texture
//                 softens. Drop to 2 for more speed (gas goes visibly blobbier).
//   * R_CULL    — skip the entire disc where its envelope is already < ~1/255.
//                 disc = exp(-r*r*1.4) < 6e-4 for r > 2.3, and the gp.y*=2.1
//                 inclination squash pushes a large top/bottom band past that,
//                 so ~1/3 of the screen skips all 3 fbm fields + disc-stars for
//                 no visible difference. The star sky is drawn separately and is
//                 unaffected.
#define FBM_OCT 3    // was 6; 2 = fastest/softest, 4-6 = original fine detail
#define R_CULL 2.3   // cull the disc past here (envelope already sub-1/255)

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 res; uniform float t;

// ---------- helpers ----------
float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Normalized fbm: dividing by the accumulated amplitude maps the result to a
// fixed [0,1] range regardless of FBM_OCT, so lowering the octave count softens
// texture WITHOUT lowering contrast — the gas/dust magnitudes (and therefore
// every threshold that reads them) stay put. `tot` is loop-invariant per octave
// count and folds to a constant at compile time.
float fbm(vec2 p) {
  float v = 0.0, amp = 0.5, tot = 0.0;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);   // rotate + scale per octave
  for (int i = 0; i < FBM_OCT; i++) {
    v   += amp * vnoise(p);
    tot += amp;
    p    = m * p;
    amp *= 0.5;
  }
  return v / tot;
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// one point star per grid cell, gated by a density threshold
float stars(vec2 p, float thresh, float tm) {
  vec2 i = floor(p), f = fract(p);
  float h = hash(i);
  if (h < thresh) return 0.0;
  vec2 sp = 0.2 + 0.6 * vec2(hash(i + vec2(31.3, 17.7)), hash(i + vec2(9.2, 4.9)));
  float d = length(f - sp);
  float star = exp(-d * d * 160.0);
  float tw = 0.72 + 0.28 * sin(tm * (1.5 + h * 4.0) + h * 80.0);
  return star * tw * (h - thresh) / (1.0 - thresh + 1e-4) * 1.6;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - res) / min(res.x, res.y);

  // ---------- deep-space background ----------
  // Kept separate from `col` so the vignette in the grade section never touches
  // it — the star field then continues at full strength out to the corners.
  // Drawn for every pixel (stars fill the whole frame), independent of the disc.
  vec3 sky = vec3(0.006, 0.008, 0.018);
  sky += vec3(0.9, 0.95, 1.0) * stars(uv * 34.0, 0.90, t) * 0.7;   // far field
  sky += vec3(1.0)             * stars(uv * 16.0 + 50.0, 0.94, t); // near field

  // ---------- galaxy plane (tilted, squashed disc) ----------
  vec3 col = vec3(0.0);
  vec2 gp = rot(-0.35) * uv;   // roll the whole disc slightly
  gp.y *= 2.1;                 // fake inclination
  gp *= 1.35;                  // framing

  float r = length(gp) + 1e-4;

  // Skip the entire disc where its envelope has already fallen below ~1/255 —
  // the arms, gas, dust, knots, bulge, nucleus and disc-stars are all gated by
  // exp(-r*r*...) terms that are effectively zero out here, so culling them is
  // invisible while removing all 3 fbm fields for the outer band of the frame.
  if (r < R_CULL) {
    // Swirl = slow rigid rotation + static differential shear.
    // The 1/r term shears the noise domain into spiral filaments;
    // keeping it time-independent means the arms never over-wind.
    float T  = t * 0.05;
    float tw = T * 3.0 + 1.0 / (0.30 + r * 1.2) * 2.6;
    vec2  q  = rot(tw) * gp;
    float sa = atan(q.y, q.x);

    // two-arm modulation, measured in the swirled frame
    float arms = 0.5 + 0.5 * cos(sa * 2.0);
    arms = pow(arms, 1.5);

    // gas + drifting dust
    float gas  = fbm(q * 2.2 + 7.0);
    float dust = fbm(q * 3.1 - 4.0 + vec2(0.0, T * 0.5));

    float disc   = exp(-r * r * 1.4);
    float bright = disc * mix(0.25, 1.0, arms) * (0.35 + 1.6 * gas * gas);

    // dark dust lanes carved out of the mid-disc
    float lane = smoothstep(0.52, 0.80, dust) * smoothstep(0.05, 0.25, r) * exp(-r * 1.1);
    bright *= 1.0 - 0.72 * lane;

    // ---------- color ----------
    vec3 cCool = vec3(0.25, 0.45, 0.95);
    vec3 cMag  = vec3(0.72, 0.34, 0.95);
    vec3 cWarm = vec3(1.00, 0.80, 0.55);

    vec3 gcol = mix(cCool, cMag, clamp(gas * 1.25, 0.0, 1.0));
    gcol = mix(gcol, cWarm, exp(-r * r * 6.0));   // warm toward the bulge
    col += gcol * bright;

    // H-II star-forming knots strung along the arms
    float knots = smoothstep(0.72, 0.95, fbm(q * 4.0 + 13.0)) * arms * disc;
    col += vec3(1.0, 0.45, 0.60) * knots * 0.7;

    // core bulge + nucleus
    col += vec3(1.00, 0.85, 0.65) * exp(-r * r * 9.0)  * 1.1;
    col += vec3(1.00, 0.95, 0.85) * exp(-r * r * 60.0) * 2.4;

    // disc stars sampled in the swirled frame, so they orbit with the arms
    float ds = stars(q * 22.0 + 3.0, 0.88, t) + stars(q * 44.0 + 9.0, 0.93, t) * 0.6;
    col += vec3(0.92, 0.95, 1.0) * ds * disc * (0.4 + 0.6 * arms);
  }

  // ---------- grade ----------
  col *= 1.0 - 0.30 * dot(uv, uv);      // vignette — galaxy disc only
  col += sky;                           // flat star field, added after the vignette
  col = 1.0 - exp(-col * 1.9);          // soft tone map
  col = pow(col, vec3(0.92));           // slight lift

  gl_FragColor = vec4(col, 1.0);
}
