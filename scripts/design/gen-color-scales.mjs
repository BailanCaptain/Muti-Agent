// F039: OKLCH → sRGB hex scale generator (Björn Ottosson's OKLab math).
// Shared L-ramp + per-family hue/chroma → harmonized status/identity palettes.

function oklchToSrgb(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  // OKLab -> LMS'
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  // LMS -> linear sRGB
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, bb];
}

const gamma = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

function toHex(L, C, H) {
  // clip chroma into sRGB gamut (binary search)
  let lo = 0;
  let hi = C;
  let rgb = oklchToSrgb(L, C, H);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToSrgb(L, mid, H))) lo = mid; else hi = mid;
    }
    rgb = oklchToSrgb(L, lo, H);
  }
  return (
    "#" +
    rgb
      .map((v) => Math.round(gamma(Math.min(1, Math.max(0, v))) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

// Shared ramps (matches F036 accent ramp, extended with 800/950)
const L_RAMP = { 50: 0.97, 100: 0.94, 200: 0.88, 300: 0.78, 400: 0.65, 500: 0.55, 600: 0.45, 700: 0.36, 800: 0.27, 900: 0.2, 950: 0.13 };
const C_MULT = { 50: 0.2, 100: 0.3, 200: 0.5, 300: 0.7, 400: 0.9, 500: 1.0, 600: 1.0, 700: 0.9, 800: 0.7, 900: 0.5, 950: 0.35 };

// 6 harmonized families ← 16 stock hue families
const FAMILIES = {
  red: { hue: 30, chroma: 0.13 },     // critical / destructive (warm red, ≈semantic-critical)
  amber: { hue: 78, chroma: 0.13 },   // warning + codex identity (distinct from accent h50)
  green: { hue: 145, chroma: 0.11 },  // success (emerald/lime merge here)
  teal: { hue: 185, chroma: 0.1 },    // gemini identity (cyan merges here)
  blue: { hue: 235, chroma: 0.1 },    // info (sky merges here)
  violet: { hue: 295, chroma: 0.11 }, // claude identity (indigo/purple/fuchsia merge here)
};

const out = {};
for (const [name, { hue, chroma }] of Object.entries(FAMILIES)) {
  out[name] = {};
  for (const step of Object.keys(L_RAMP)) {
    out[name][step] = toHex(L_RAMP[step], chroma * C_MULT[step], hue);
  }
}

for (const [name, scale] of Object.entries(out)) {
  console.log(`        ${name}: {`);
  for (const [step, hex] of Object.entries(scale)) {
    console.log(`          ${step}: "${hex}",`);
  }
  console.log('        },');
}

// sanity: WCAG contrast of 600-on-50 and 700-on-white for each family
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return ((x + 0.05) / (y + 0.05)).toFixed(2); };
console.log("\n// contrast checks (AA needs 4.5 body / 3.0 large):");
for (const [name, s] of Object.entries(out)) {
  console.log(`// ${name}: 600 on 50 = ${cr(s[600], s[50])}, 700 on 50 = ${cr(s[700], s[50])}, 600 on white = ${cr(s[600], "#ffffff")}, 500 on white = ${cr(s[500], "#ffffff")}`);
}
