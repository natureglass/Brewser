// Animated wallpaper shader — "aurora" (SIMPLIFIED). WebGL1 fragment shader
// driven by the shell's dynamic-background renderer (runtime
// `presentDynamicBackground`). The vertex stage + full-screen triangle are
// supplied by the host; this file is ONLY the fragment shader and is fully
// self-contained — the host supplies just two uniforms:
//     uniform vec2  res;   // drawable size in pixels
//     uniform float t;     // global animation clock, seconds (host-reset on select)
//
// Extracted from D:\Downloads\aurora-bands.html, then cut down hard for the
// Tegra X1 / Mesa-Nouveau shader compiler. The faithful port evaluated 4-octave
// fbm several times per band (~130 hash() calls/pixel). This keeps the visual
// signature — three stacked green->purple sine "curtains" with fine drifting
// striations over a starry night sky — with NO fbm and NO loops: pure sines for
// the wave shape plus ONE value-noise() call per band for the rays (~14 hash()
// /pixel total). The rays MUST come from noise, not a plain sine: a regular sine
// dims each curtain in even columns and reads as a row of blobs; noise is
// irregular, so it reads as natural striations.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 res; uniform float t;

// Tiny value hash — feeds noise() (curtain rays) and the star field.
float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// Value noise (single octave, no fbm) — cheap organic variation for the rays.
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i),                 hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// One aurora curtain: a wavy horizontal glow shading green (core) to purple
// (upper fringe), textured with drifting vertical rays. p: aspect-corrected
// coords. y0: rest height. amp/freq/speed shape the sine; seed decorrelates
// stacked bands.
vec3 band(vec2 p, float y0, float amp, float freq, float speed, float seed) {
  float tt = t * speed;
  // wavy centre line: main sine + a slower harmonic for a natural undulation
  float wave = sin(p.x * freq + tt + seed)
             + 0.35 * sin(p.x * freq * 2.3 - tt * 1.3 + seed);
  float d = p.y - (y0 + wave * amp);

  // soft vertical glow, taller above the centre than below
  float w = d > 0.0 ? 0.16 : 0.05;
  float glow = exp(-(d * d) / (w * w));

  // drifting vertical curtain rays — irregular (noise), so no blob beading
  glow *= 0.55 + 0.45 * noise(vec2(p.x * 22.0 + seed * 7.0, tt * 0.15));

  // green core -> purple fringe as we rise above the centre
  float h = clamp(d / 0.16, 0.0, 1.0);
  vec3 col = mix(vec3(0.05, 0.95, 0.45), vec3(0.55, 0.15, 0.85),
                 smoothstep(0.0, 1.0, h));
  return col * glow;
}

// Cheap star field with twinkle. One hash gates a small round sparkle; a second
// hash sets per-star brightness AND — via a free fract() reshuffle, no third
// hash — selects a ~15% subset that flares ABOVE base with a per-star rate and
// phase. The sin sits behind BOTH the star gate and the blink gate, so it runs
// for only a tiny fraction of pixels. Reproduces aurora-bands.html's blink at
// one fewer hash than the original (which spent a separate hash on the subset).
float stars(vec2 uv) {
  vec2 g = uv * 90.0;
  vec2 cell = floor(g);
  if (hash(cell) < 0.985) return 0.0;
  vec2 f = fract(g) - 0.5;
  float sparkle = exp(-dot(f, f) * 48.0);
  float hb = hash(cell + 42.7);
  float intensity = 0.15 + 0.85 * hb;            // per-star base brightness
  float b = fract(hb * 91.7);                     // decorrelated twinkle key (free)
  if (b > 0.85) {                                 // ~15% of stars twinkle
    float bl = 0.5 + 0.5 * sin(t * (1.5 + b * 6.0) + b * 80.0);
    intensity += bl * bl * 1.6;                   // peaky flare, never dips below base
  }
  return sparkle * intensity;
}

void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 p = uv;
  p.x *= res.x / res.y;   // aspect correction so waves don't stretch

  // night-sky base gradient
  vec3 col = mix(vec3(0.008, 0.015, 0.05), vec3(0.02, 0.04, 0.10), uv.y);
  // stars in the top half only, fading out by mid-screen
  col += stars(p) * vec3(0.8, 0.9, 1.0) * smoothstep(0.5, 1.0, uv.y);

  // three stacked curtains: y0, amp, freq, speed, seed
  col += band(p, 0.62, 0.060, 2.2, 0.45, 1.7) * 0.95;
  col += band(p, 0.45, 0.085, 1.6, 0.30, 5.3) * 0.80;
  col += band(p, 0.30, 0.045, 3.1, 0.60, 9.1) * 0.55;

  // faint reflected haze near the bottom (one sine, was 4-octave fbm)
  col += vec3(0.03, 0.10, 0.07) * (1.0 - smoothstep(0.0, 0.35, uv.y))
       * (0.6 + 0.4 * sin(p.x * 2.0 + t * 0.3));

  // tone map + cheap dot-product vignette (no sqrt, no gamma pow)
  col = col / (1.0 + col);
  vec2 q = uv * 2.0 - 1.0;
  col *= 1.0 - 0.25 * dot(q, q);

  gl_FragColor = vec4(col, 1.0);
}
