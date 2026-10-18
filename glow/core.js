"use strict";
// MS Glow – Kern-Engine (reines JavaScript, läuft im Panel und in Node).
// Erzeugt Licht-Effekte aus den hellen Stellen eines Bilds. Jeder Effekt wird eine eigene Ebene, die über dem
// Original liegt und es nur aufhellt (Negativ multiplizieren / Linear abwedeln) – das Original bleibt unberührt:
//   glow       weiches Leuchten mit physikalischem Abfall (viele überlagerte Unschärfe-Stufen)
//   halation   rot-oranger Lichtsaum um helle Kanten, wie bei Filmmaterial
//   diffusion  nebliger Weichzeichner (Pro-Mist): das ganze Bild leuchtet weich nach
//   streaks    anamorphe Lichtstreifen (lang, waagerecht)
//   stars      Sternfilter: Strahlen an den hellsten Punkten
//   haze       Dunst: sehr weiter, farbiger Lichtschleier wie Nebel in der Luft
// Alle Größen hängen an der Bildhöhe (sizeBase) – die kleine Vorschau sieht aus wie das Ergebnis.

const DEFAULTS = {
  threshold: 55,         // ab welcher Helligkeit es leuchtet
  knee: 40,              // weicher Übergang an der Schwelle
  amount: 70,            // Stärke des Glows
  radius: 35,            // Reichweite in % der halben Bildhöhe
  falloff: 50,           // Abfall: klein = weit und flach, groß = eng um die Lichtquelle
  protect: 45,           // Kern schützen: helle Flächen behalten ihre Zeichnung
  outer: 0,              // nur außen leuchten: im Objekt selbst kein Glow (bleibt unverfärbt)
  gamma: 100,            // Gamma der Lichtquellen (%)
  saturation: 0,         // Sättigung des Glows
  colorMode: "original", // original | tint
  tint: "#ffcf9a",
  prism: 0,              // Farbsäume: Rot reicht weiter als Blau
  rangeColor: "#ff3fa4", // nur dieser Farbbereich leuchtet …
  rangeWidth: 0,         // … 0 = aus
  glowBlend: "screen",   // screen | linearDodge
  halation: 0,
  halationRadius: 30,
  halationColor: "#ff4a1a",
  diffusion: 0,
  diffusionRadius: 35,
  streaks: 0,
  streakLength: 50,
  streakColor: "#4aa8ff",
  stars: 0,
  starRays: 4,           // 4 | 6 | 8
  starLength: 40,
  starAngle: 0,
  haze: 0,               // Dunst
  hazeRadius: 60,
  hazeColor: "#2fb8b0",
  hazeTint: 50,          // wie stark der Dunst die Dunst-Farbe annimmt
  opacity: 100,          // Gesamt-Deckkraft
};

const BLENDS = [{ id: "screen", name: "Negativ multiplizieren" }, { id: "linearDodge", name: "Linear abwedeln (Hinzufügen)" }];
const RAYS = [4, 6, 8];

const PRESETS = [
  { id: "dreamy", name: "Traumhaft", p: {} },
  { id: "promist", name: "Pro-Mist", p: { amount: 35, threshold: 40, radius: 25, diffusion: 45, diffusionRadius: 30, protect: 35 } },
  { id: "halation", name: "Filmhalation", p: { amount: 40, threshold: 62, radius: 20, halation: 70, halationRadius: 25, protect: 40 } },
  { id: "ethereal", name: "Ätherisch", p: { amount: 90, threshold: 35, knee: 60, radius: 70, falloff: 25, diffusion: 30, protect: 30 } },
  { id: "neon", name: "Neon", p: { amount: 110, threshold: 30, radius: 30, falloff: 60, saturation: 45, glowBlend: "linearDodge", protect: 10 } },
  { id: "anamorphic", name: "Anamorph", p: { amount: 55, threshold: 65, radius: 25, streaks: 75, streakLength: 70 } },
  { id: "starfilter", name: "Sternfilter", p: { amount: 50, threshold: 68, radius: 20, stars: 80, starRays: 4, starLength: 45, starAngle: 0 } },
  { id: "stage", name: "Bühnenlicht", p: { amount: 70, threshold: 60, radius: 35, stars: 55, starRays: 6, starLength: 35, starAngle: 15, streaks: 45, streakLength: 55 } },
  { id: "sunset", name: "Abendsonne", p: { amount: 85, threshold: 45, radius: 55, falloff: 35, colorMode: "tint", tint: "#ffb060", halation: 30 } },
  { id: "moon", name: "Mondlicht", p: { amount: 75, threshold: 50, radius: 50, falloff: 40, colorMode: "tint", tint: "#9cc4ff", diffusion: 25 } },
  { id: "candle", name: "Kerzenlicht", p: { amount: 95, threshold: 55, radius: 40, falloff: 55, colorMode: "tint", tint: "#ff9a3a", halation: 40, halationColor: "#ff5a10" } },
  { id: "gold", name: "Gold", p: { amount: 80, threshold: 50, radius: 40, colorMode: "tint", tint: "#ffd27a", stars: 40, starRays: 8, starLength: 25 } },
  { id: "prism", name: "Prisma", p: { amount: 85, threshold: 45, radius: 45, prism: 80, saturation: 30 } },
  { id: "cyber", name: "Cyber", p: { amount: 100, threshold: 35, radius: 35, falloff: 55, prism: 60, saturation: 60, glowBlend: "linearDodge", streaks: 35, streakColor: "#3fd4ff" } },
  { id: "chromeaura", name: "Chrome-Aura", p: { colorMode: "tint", tint: "#6a5cff", amount: 190, radius: 60, falloff: 8, threshold: 35, knee: 60, gamma: 60, saturation: 50, protect: 20, outer: 100 } },
  { id: "fogcity", name: "Nebelstadt", p: { amount: 90, radius: 70, falloff: 20, threshold: 45, protect: 40, haze: 70, hazeRadius: 60, hazeColor: "#2fb8b0", hazeTint: 60, diffusion: 30 } },
  { id: "soft", name: "Weichzeichner", p: { amount: 20, threshold: 30, radius: 15, diffusion: 65, diffusionRadius: 20, protect: 50 } },
];
function presetParams(id) { const pr = PRESETS.find((x) => x.id === id); return pr ? Object.assign({}, DEFAULTS, pr.p) : null; }

const RANGES = {
  threshold: [0, 100], knee: [0, 100], amount: [0, 200], radius: [2, 100], falloff: [0, 100], protect: [0, 100], gamma: [50, 200],
  saturation: [-100, 100], prism: [0, 100], rangeWidth: [0, 100], halation: [0, 100], halationRadius: [5, 100], diffusion: [0, 100],
  diffusionRadius: [5, 100], streaks: [0, 100], streakLength: [5, 100], stars: [0, 100], starLength: [5, 100], starAngle: [0, 90], opacity: [0, 100],
  outer: [0, 100], haze: [0, 100], hazeRadius: [10, 100], hazeTint: [0, 100],
};
const COLOR_KEYS = ["tint", "rangeColor", "halationColor", "streakColor", "hazeColor"];
function sanitize(p) {
  const out = Object.assign({}, DEFAULTS);
  if (!p || typeof p !== "object") return out;
  for (const k of Object.keys(DEFAULTS)) {
    const v = p[k];
    if (v === undefined || v === null) continue;
    if (RANGES[k]) { const n = Number(v); if (isFinite(n)) out[k] = Math.max(RANGES[k][0], Math.min(RANGES[k][1], n)); }
    else if (k === "colorMode") { if (v === "original" || v === "tint") out[k] = v; }
    else if (k === "glowBlend") { if (BLENDS.some((b) => b.id === v)) out[k] = v; }
    else if (k === "starRays") { const n = Number(v); if (RAYS.indexOf(n) >= 0) out[k] = n; }
    else if (COLOR_KEYS.indexOf(k) >= 0) { const t = String(v).toLowerCase(); if (/^#[0-9a-f]{6}$/.test(t)) out[k] = t; }
  }
  return out;
}

// ---------------------------------------------------------------- Helfer
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / Math.max(1e-6, b - a)); return t * t * (3 - 2 * t); };
function hexRgb(h) { const n = parseInt(String(h).slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return { h: 0, s: 0 };
  let h;
  if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / (mx || 1) };
}
// Box-Blur (2 Durchgänge ≈ Gauß) in x und y
function boxBlur(src, w, h, rx, ry) {
  rx = Math.max(0, Math.round(rx)); ry = Math.max(0, Math.round(ry === undefined ? rx : ry));
  let a = src;
  if (rx) {
    const out = new Float32Array(w * h), win = 2 * rx + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let k = -rx; k <= rx; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) { out[row + x] = acc / win; acc += a[row + Math.min(w - 1, x + rx + 1)] - a[row + Math.max(0, x - rx)]; }
    }
    a = out;
  }
  if (ry) {
    const out = new Float32Array(w * h), win = 2 * ry + 1;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -ry; k <= ry; k++) acc += a[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = acc / win; acc += a[Math.min(h - 1, y + ry + 1) * w + x] - a[Math.max(0, y - ry) * w + x]; }
    }
    a = out;
  }
  return a;
}
const blur2 = (a, w, h, rx, ry) => boxBlur(boxBlur(a, w, h, rx * 0.6, (ry === undefined ? rx : ry) * 0.6), w, h, rx * 0.6, (ry === undefined ? rx : ry) * 0.6);
// halbe Auflösung (2×2-Mittel)
function half(a, w, h) {
  const W = Math.max(1, Math.ceil(w / 2)), H = Math.max(1, Math.ceil(h / 2)), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = x * 2, y0 = y * 2, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    out[y * W + x] = (a[y0 * w + x0] + a[y0 * w + x1] + a[y1 * w + x0] + a[y1 * w + x1]) / 4;
  }
  return { a: out, w: W, h: H };
}
// verkleinert um Faktor f (Box-Mittel)
function shrink(a, w, h, f) {
  if (f <= 1) return { a, w, h };
  const W = Math.max(1, Math.ceil(w / f)), H = Math.max(1, Math.ceil(h / f)), out = new Float32Array(W * H), cnt = new Float32Array(W * H);
  for (let y = 0; y < h; y++) { const row = ((y / f) | 0) * W; for (let x = 0; x < w; x++) { const j = row + ((x / f) | 0); out[j] += a[y * w + x]; cnt[j]++; } }
  for (let j = 0; j < out.length; j++) out[j] /= cnt[j] || 1;
  return { a: out, w: W, h: H };
}
// bilinear an Original-Pixel (x, y) aus einem um s verkleinerten Feld
function at(f, s, x, y) {
  let fx = (x + 0.5) / s - 0.5, fy = (y + 0.5) / s - 0.5;
  if (fx < 0) fx = 0; else if (fx > f.w - 1) fx = f.w - 1;
  if (fy < 0) fy = 0; else if (fy > f.h - 1) fy = f.h - 1;
  const x0 = fx | 0, y0 = fy | 0, x1 = x0 + 1 < f.w ? x0 + 1 : x0, y1 = y0 + 1 < f.h ? y0 + 1 : y0, tx = fx - x0, ty = fy - y0, a = f.a, W = f.w;
  return (a[y0 * W + x0] * (1 - tx) + a[y0 * W + x1] * tx) * (1 - ty) + (a[y1 * W + x0] * (1 - tx) + a[y1 * W + x1] * tx) * ty;
}

// ---------------------------------------------------------------- Lichtquellen
// opts: { rgba, w, h, pxScale (Ziel-Pixel je Bildpixel), sizeBase (Bezugshöhe in Ziel-Pixeln), params }
function geometry(opts) {
  const p = sanitize(opts.params), ps = opts.pxScale || 1, base = opts.sizeBase || opts.h * ps;
  return { p, w: opts.w, h: opts.h, N: opts.w * opts.h, ps, base, unit: base / ps / 100 };   // unit: 1 % der Bildhöhe in Bildpixeln
}
// Helle Stellen (vormultipliziert mit Alpha) als drei Float-Kanäle, dazu die Quell-Helligkeit
function lightSources(opts, g) {
  const p = g.p, src = opts.rgba, N = g.N;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), L = new Float32Array(N), C = new Float32Array(N);
  const t = p.threshold / 100, k = Math.max(0.01, p.knee / 100 * 0.5), gam = p.gamma / 100;   // < 100 %: auch Mitteltöne leuchten, > 100 %: nur die hellsten
  const tint = hexRgb(p.tint), sat = 1 + p.saturation / 100;
  const rc = hueOf(...hexRgb(p.rangeColor)), rw = p.rangeWidth / 100 * 90;
  // Hintergrund-Helligkeit (10 %-Perzentil) – was deutlich heller ist, zählt bei „nur außen“ als Objekt
  let bg = 0;
  if (p.outer > 0 && !opts.layerMode) {
    const hist = new Uint32Array(256), step = Math.max(1, Math.floor(N / 200000));
    let n = 0;
    for (let i = 0; i < N; i += step) { hist[Math.round((0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2]) * src[i * 4 + 3] / 255)]++; n++; }
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.1) { bg = v / 255; break; } }
  }
  for (let i = 0; i < N; i++) {
    const a = src[i * 4 + 3] / 255;
    let r = src[i * 4] / 255, gg = src[i * 4 + 1] / 255, b = src[i * 4 + 2] / 255;
    const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
    L[i] = lum * a;
    // Objekt-Abdeckung: bei einer Ebene ihre Form, im ganzen Dokument die (etwas weiter gefassten) hellen Flächen
    C[i] = opts.layerMode ? a : smooth(bg + 0.05, bg + 0.16, lum * a);
    let wgt = smooth(t - k, t + k, lum);
    if (wgt <= 0) continue;
    if (rw > 0) {   // nur ein Farbbereich leuchtet
      const hs = hueOf(r, gg, b);
      let dh = Math.abs(hs.h - rc.h); if (dh > 180) dh = 360 - dh;
      wgt *= (1 - smooth(rw * 0.6, rw, dh)) * smooth(0.12, 0.3, hs.s);
      if (wgt <= 0) continue;
    }
    wgt = Math.pow(wgt, gam) * a;
    if (p.colorMode === "tint") { const l = lum * 1.15; r = tint[0] * l; gg = tint[1] * l; b = tint[2] * l; }
    if (sat !== 1) { const l = 0.299 * r + 0.587 * gg + 0.114 * b; r = Math.max(0, l + (r - l) * sat); gg = Math.max(0, l + (gg - l) * sat); b = Math.max(0, l + (b - l) * sat); }
    R[i] = r * wgt; G[i] = gg * wgt; B[i] = b * wgt;
  }
  return { R, G, B, L, C };
}

// ---------------------------------------------------------------- Effekte
const toRGBA = (N, fn) => { const out = new Uint8ClampedArray(N * 4); const c = [0, 0, 0]; for (let i = 0; i < N; i++) { fn(i, c); out[i * 4] = c[0] * 255; out[i * 4 + 1] = c[1] * 255; out[i * 4 + 2] = c[2] * 255; out[i * 4 + 3] = 255; } return out; };

// Glow: Pyramide aus Unschärfe-Stufen, jede Stufe doppelt so groß; ihre Gewichte bilden den Abfall
// (~ inverse Quadrate: viel Licht nah an der Quelle, ein langer, schwacher Ausläufer).
function renderGlow(opts, ls) {
  const g = geometry(opts), p = g.p, { w, h, N } = g;
  if (p.amount <= 0) return null;
  const rmax = Math.max(1.5, p.radius / 100 * 50 * g.unit);   // in Bildpixeln
  const K = Math.max(1, Math.min(12, Math.ceil(Math.log2(rmax / 1.5)) + 1));
  const e = 0.05 + p.falloff / 100 * 1.1, pr = p.prism / 100 * 0.5;
  const wts = (ex) => { const a = []; let s = 0; for (let k = 0; k < K; k++) { a.push(Math.pow(2, -k * ex)); s += a[k]; } return a.map((v) => v / s); };
  const wc = [wts(Math.max(0.05, e - pr)), wts(e), wts(e + pr)];
  const amt = p.amount / 100 * (1 + 0.32 * K);   // mehr Stufen = mehr Licht im weiten Hof
  const levels = [ls.R, ls.G, ls.B].map((ch) => {
    const out = []; let cur = { a: ch, w, h }, s = 1;
    for (let k = 0; k < K; k++) {
      out.push({ a: blur2(cur.a, cur.w, cur.h, 1.5), w: cur.w, h: cur.h, s });
      cur = half(cur.a, cur.w, cur.h); s *= 2;
    }
    return out;
  });
  const prot = p.protect / 100, out = p.outer / 100;
  // „nur außen“: die (kantengeglättete) Form des Objekts – innen kein Glow, der Schein beginnt an der Kante
  const cov = out > 0 ? ls.C : null;
  return toRGBA(N, (i, c) => {
    const x = i % w, y = (i / w) | 0;
    for (let ch = 0; ch < 3; ch++) {
      let v = 0;
      const lv = levels[ch], ww = wc[ch];
      for (let k = 0; k < K; k++) v += ww[k] * at(lv[k], lv[k].s, x, y);
      c[ch] = Math.min(1, v * amt * (1 - prot * ls.L[i]) * (cov ? 1 - out * Math.min(1, cov[i] * 1.15) : 1));
    }
  });
}

// Halation: Ring um helle Kanten (weite minus enge Unschärfe), in Filmfarbe
function renderHalation(opts, ls) {
  const g = geometry(opts), p = g.p, { w, h, N } = g;
  if (p.halation <= 0) return null;
  const r = Math.max(1, p.halationRadius / 100 * 6 * g.unit), f = Math.max(1, Math.floor(r / 4));
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.299 * ls.R[i] + 0.587 * ls.G[i] + 0.114 * ls.B[i];
  const s = shrink(lum, w, h, f);
  const wide = { a: blur2(s.a, s.w, s.h, r / f), w: s.w, h: s.h }, narrow = { a: blur2(s.a, s.w, s.h, r / f * 0.3), w: s.w, h: s.h };
  const col = hexRgb(p.halationColor), amt = p.halation / 100 * 3.2;
  return toRGBA(N, (i, c) => {
    const x = i % w, y = (i / w) | 0;
    const v = Math.max(0, at(wide, f, x, y) * 1.15 - at(narrow, f, x, y) * 0.85 - lum[i] * 0.5) * amt;
    c[0] = Math.min(1, col[0] * v); c[1] = Math.min(1, col[1] * v); c[2] = Math.min(1, col[2] * v);
  });
}

// Diffusion: das ganze Bild weich nachleuchten lassen (Pro-Mist)
function renderDiffusion(opts) {
  const g = geometry(opts), p = g.p, { w, h, N } = g, src = opts.rgba;
  if (p.diffusion <= 0) return null;
  const r = Math.max(1, p.diffusionRadius / 100 * 8 * g.unit), f = Math.max(1, Math.floor(r / 4)), amt = p.diffusion / 100 * 0.75;
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = src[i * 4 + c] / 255 * src[i * 4 + 3] / 255; a[i] = v * v; }   // helle Teile tragen mehr
    const s = shrink(a, w, h, f);
    return { a: blur2(s.a, s.w, s.h, r / f), w: s.w, h: s.h };
  });
  return toRGBA(N, (i, c) => { const x = i % w, y = (i / w) | 0; for (let k = 0; k < 3; k++) c[k] = Math.min(1, Math.sqrt(Math.max(0, at(ch[k], f, x, y))) * amt); });
}

// Dunst: sehr weite Unschärfe des ganzen Bilds, hebt die Schatten wie Nebel in der Luft; mit eigener Farbe
function renderHaze(opts) {
  const g = geometry(opts), p = g.p, { w, h, N } = g, src = opts.rgba;
  if (p.haze <= 0) return null;
  const r = Math.max(2, p.hazeRadius / 100 * 50 * g.unit), f = Math.max(1, Math.floor(r / 5)), amt = p.haze / 100 * 1.1, tint = p.hazeTint / 100, hc = hexRgb(p.hazeColor);
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = src[i * 4 + c] / 255 * src[i * 4 + 3] / 255;
    const s = shrink(a, w, h, f);
    return { a: blur2(blur2(s.a, s.w, s.h, r / f * 0.6), s.w, s.h, r / f * 0.6), w: s.w, h: s.h };
  });
  return toRGBA(N, (i, c) => {
    const x = i % w, y = (i / w) | 0;
    const v = [at(ch[0], f, x, y), at(ch[1], f, x, y), at(ch[2], f, x, y)], l = 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
    for (let k = 0; k < 3; k++) {
      const col = v[k] * (1 - tint) + Math.min(1, l * 1.8) * hc[k] * tint;   // Nebel nimmt Licht und Dunst-Farbe an
      c[k] = Math.min(1, (col * 1.6 + hc[k] * 0.05 * tint) * amt);
    }
  });
}

// gerichtete Unschärfe mit exponentiellem Abfall entlang (dx, dy) auf einem verkleinerten Feld
function streakBlur(f, dx, dy, len) {
  const { a, w, h } = f, out = new Float32Array(w * h), L = Math.max(1, Math.round(len)), tau = L * 0.35;
  const wts = []; let sum = 0;
  for (let s = -L; s <= L; s++) { const v = Math.exp(-Math.abs(s) / tau); wts.push(v); sum += v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let s = -L; s <= L; s++) {
      const xx = Math.round(x + dx * s), yy = Math.round(y + dy * s);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      v += a[yy * w + xx] * wts[s + L];
    }
    out[y * w + x] = v / sum;   // Mittel entlang des Strahls – große helle Flächen werden nicht zu Balken
  }
  return { a: out, w, h };
}
// nur die hellsten Punkte (für Streifen und Sterne)
function hotSpots(ls, N, lift, w, h, unit, sharp) {
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.299 * ls.R[i] + 0.587 * ls.G[i] + 0.114 * ls.B[i];
  // Umgebung (ca. 3 % der Bildhöhe): kleine, helle Punkte ragen heraus, große Flächen kaum
  const r = Math.max(1, unit * 3), f = Math.max(1, Math.floor(r / 4)), sm = shrink(lum, w, h, f), env = { a: blur2(sm.a, sm.w, sm.h, r / f), w: sm.w, h: sm.h };
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i / w) | 0, l = lum[i];
    const peak = clamp01((l - at(env, f, x, y) * 0.85) * 3);
    const k = Math.pow(smooth(lift, Math.min(1.2, lift + 0.2), l) * peak, sharp || 1);
    R[i] = ls.R[i] * k; G[i] = ls.G[i] * k; B[i] = ls.B[i] * k;
  }
  return [R, G, B];
}
// Anamorphe Lichtstreifen: lang und waagerecht, eingefärbt
function renderStreaks(opts, ls) {
  const g = geometry(opts), p = g.p, { w, h, N } = g;
  if (p.streaks <= 0) return null;
  const len = p.streakLength / 100 * 60 * g.unit, f = Math.max(1, Math.floor(len / 40));
  const hot = hotSpots(ls, N, 0.55, w, h, g.unit), col = hexRgb(p.streakColor), amt = p.streaks / 100 * 6;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.299 * hot[0][i] + 0.587 * hot[1][i] + 0.114 * hot[2][i];
  const s = shrink(lum, w, h, f);
  const st = streakBlur({ a: boxBlur(s.a, s.w, s.h, 0, 0.6), w: s.w, h: s.h }, 1, 0, len / f);
  return toRGBA(N, (i, c) => {
    const x = i % w, y = (i / w) | 0, v = at(st, f, x, y) * amt;
    c[0] = Math.min(1, v * (col[0] * 0.8 + 0.2)); c[1] = Math.min(1, v * (col[1] * 0.8 + 0.2)); c[2] = Math.min(1, v * (col[2] * 0.8 + 0.2));
  });
}
// Maximum-Filter (quadratisches Fenster, Radius r Zellen), getrennt in x und y
function maxFilter(f, r) {
  const { a, w, h } = f, t = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, a[y * w + k]); t[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, t[k * w + x]); out[y * w + x] = m; }
  return out;
}
// Sternfilter: 4/6/8 Strahlen – nur an einzelnen Lichtpunkten (lokale Helligkeits-Maxima wie Lampen, Glanzlichter),
// nicht an jeder hellen Kante; sonst würde helle Schrift zu einem Block aus Strahlen.
function renderStars(opts, ls) {
  const g = geometry(opts), p = g.p, { w, h, N } = g;
  if (p.stars <= 0) return null;
  const len = p.starLength / 100 * 15 * g.unit, f = Math.max(1, Math.floor(len / 30));
  const amt = p.stars / 100 * 1.1, dirs = p.starRays / 2;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.299 * ls.R[i] + 0.587 * ls.G[i] + 0.114 * ls.B[i];
  const ch = [ls.R, ls.G, ls.B].map((c) => shrink(c, w, h, f)), L = shrink(lum, w, h, f);
  const Lb = { a: blur2(L.a, L.w, L.h, 1.2), w: L.w, h: L.h };
  // Umgebung (ca. 4 % der Bildhöhe) und Fenster für die Maxima (ca. 2,5 %)
  const env = blur2(Lb.a, L.w, L.h, Math.max(2, g.unit * 4 / f)), mx = maxFilter(Lb, Math.max(2, Math.round(g.unit * 2.5 / f)));
  const pts = [new Float32Array(L.a.length), new Float32Array(L.a.length), new Float32Array(L.a.length)];
  for (let j = 0; j < L.a.length; j++) {
    const v = Lb.a[j];
    if (v < 0.35 || v < mx[j] - 1e-6 || v < env[j] * 1.35) continue;   // nur echte, herausragende Spitzen
    const k = Math.min(1, (v - env[j]) * 2) * Math.pow(smooth(0.35, 0.95, v), 3);   // die hellsten Punkte dominieren
    for (let c = 0; c < 3; c++) pts[c][j] = ch[c].a[j] / Math.max(1e-4, L.a[j]) * v * k;
  }
  const acc = pts.map((a) => ({ a: new Float32Array(a.length), w: L.w, h: L.h }));
  for (let d = 0; d < dirs; d++) {
    const ang = (p.starAngle + d * 180 / dirs) * Math.PI / 180, dx = Math.cos(ang), dy = Math.sin(ang);
    for (let c = 0; c < 3; c++) { const r = rayBlur({ a: pts[c], w: L.w, h: L.h }, dx, dy, len / f); for (let j = 0; j < r.length; j++) acc[c].a[j] += r[j]; }
  }
  return toRGBA(N, (i, c) => {
    const x = i % w, y = (i / w) | 0;
    const v = [at(acc[0], f, x, y), at(acc[1], f, x, y), at(acc[2], f, x, y)], l = (v[0] + v[1] + v[2]) / 3;
    for (let k = 0; k < 3; k++) c[k] = Math.min(1, (v[k] * 0.6 + l * 0.4) * amt);
  });
}
// Strahl von einzelnen Punkten: Summe entlang der Richtung, hell am Punkt, spitz auslaufend
function rayBlur(f, dx, dy, len) {
  const { a, w, h } = f, out = new Float32Array(w * h), L = Math.max(1, Math.round(len));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = a[y * w + x];
    if (!v) continue;
    for (let s = -L; s <= L; s++) {
      const xx = Math.round(x + dx * s), yy = Math.round(y + dy * s);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const t = 1 - Math.abs(s) / (L + 1);
      out[yy * w + xx] += v * t * t;
    }
  }
  return out;
}

// Ebenen von oben nach unten, wie sie in der Gruppe liegen
const LAYERS = [
  { key: "stars", name: "Sterne", mode: () => "linearDodge" },
  { key: "streaks", name: "Lichtstreifen", mode: () => "linearDodge" },
  { key: "halation", name: "Halation", mode: () => "screen" },
  { key: "glow", name: "Glow", mode: (p) => p.glowBlend },
  { key: "diffusion", name: "Diffusion", mode: () => "screen" },
  { key: "haze", name: "Dunst", mode: () => "screen" },
];
function layerKeys(p) {
  p = sanitize(p);
  const has = { stars: p.stars > 0, streaks: p.streaks > 0, halation: p.halation > 0, glow: p.amount > 0, diffusion: p.diffusion > 0, haze: p.haze > 0 };
  return LAYERS.filter((d) => has[d.key]).map((d) => d.key);
}
// eine Ebene berechnen (ls = Lichtquellen, einmal je Bild)
function renderLayer(key, opts, ls) {
  if (key === "glow") return renderGlow(opts, ls);
  if (key === "halation") return renderHalation(opts, ls);
  if (key === "diffusion") return renderDiffusion(opts);
  if (key === "haze") return renderHaze(opts);
  if (key === "streaks") return renderStreaks(opts, ls);
  if (key === "stars") return renderStars(opts, ls);
  return null;
}
function render(opts) {
  const g = geometry(opts), ls = lightSources(opts, g), out = { params: g.p };
  for (const d of LAYERS) out[d.key] = layerKeys(g.p).indexOf(d.key) >= 0 ? renderLayer(d.key, opts, ls) : null;
  return out;
}
// Ebenen wie in Photoshop übereinanderlegen (Vorschau). base: RGB darunter (Uint8, 3 Kanäle)
function composite(res, w, h, base) {
  const p = res.params, N = w * h, out = new Uint8Array(N * 3), op = p.opacity / 100;
  const order = LAYERS.slice().reverse().filter((d) => res[d.key]);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) {
    const b = base[i * 3 + c] / 255;
    let v = b;
    for (const d of order) {
      const l = res[d.key][i * 4 + c] / 255;
      v = d.mode(p) === "linearDodge" ? Math.min(1, v + l) : 1 - (1 - v) * (1 - l);
    }
    out[i * 3 + c] = Math.round((b * (1 - op) + v * op) * 255);
  }
  return out;
}
// Rand, den die Effekte über ein Objekt hinaus brauchen (in % der Bezugshöhe)
function reachPct(p) {
  p = sanitize(p);
  return Math.max(p.amount > 0 ? p.radius / 100 * 50 : 0, p.halation > 0 ? p.halationRadius / 100 * 12 : 0, p.diffusion > 0 ? p.diffusionRadius / 100 * 16 : 0,
    p.streaks > 0 ? p.streakLength / 100 * 60 : 0, p.stars > 0 ? p.starLength / 100 * 15 : 0, p.haze > 0 ? p.hazeRadius / 100 * 100 : 0) + 2;
}

const api = { DEFAULTS, BLENDS, RAYS, PRESETS, RANGES, LAYERS, presetParams, sanitize, geometry, lightSources, renderLayer, render, composite, layerKeys, reachPct, hexRgb };
if (typeof module !== "undefined") module.exports = api;
