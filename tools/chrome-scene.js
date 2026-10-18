// Chrome-Schrift als Szene für die README-Bilder: Text (Arial Black, kursiv) → Chrome aus der
// MS-Render-Engine (Ordner daneben: ../../MS Render) → eigene Ebene über einem dunklen Hintergrund.
// Liefert die Ebene (RGBA, transparent drumherum) und das fertige Hintergrundbild darunter (RGB).
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
const E = require(path.join(__dirname, "..", "..", "MS Render", "render", "engine.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "msglow-chrome-"));

// Text als Alpha-Maske (Python + Pillow)
function textAlpha(lines, px) {
  const f = path.join(TMP, "text.raw");
  const out = execFileSync("python3", ["-I", "-c", `
import sys, json
from PIL import Image, ImageDraw, ImageFont
lines = json.loads(sys.argv[2]); px = int(sys.argv[3])
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Black.ttf", px)
lh = int(px * 1.02)
ws = [font.getbbox(t)[2] for t in lines]
W = max(ws) + int(px * 0.5); H = lh * len(lines) + int(px * 0.3)
im = Image.new("L", (W, H), 0); d = ImageDraw.Draw(im)
for i, t in enumerate(lines):
    d.text(((W - ws[i]) // 2, int(px * 0.05) + i * lh), t, font=font, fill=255)
# kursiv: nach rechts scheren
im = im.transform((W + int(H * 0.2), H), Image.AFFINE, (1, 0.2, -H * 0.2, 0, 1, 0), resample=Image.BICUBIC)
bb = im.getbbox(); im = im.crop((bb[0] - 4, bb[1] - 4, bb[2] + 4, bb[3] + 4))
open(sys.argv[1], "wb").write(im.tobytes())
print(im.size[0], im.size[1])
`, f, JSON.stringify(lines), String(px)]).toString().trim().split(" ").map(Number);
  return { alpha: new Uint8Array(fs.readFileSync(f)), w: out[0], h: out[1] };
}

// Hintergrund: fast schwarzes Nachtblau mit einem weichen Lichthof in der Mitte
function background(W, H, tint) {
  const rgb = new Uint8Array(W * H * 3), t = tint || [10, 16, 40];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W * 0.6), dy = (y - H * 0.55) / (H * 0.8), r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
    const k = 1 - r * r, i = (y * W + x) * 3;
    rgb[i] = 4 + t[0] * k; rgb[i + 1] = 5 + t[1] * k; rgb[i + 2] = 9 + t[2] * k;
  }
  return rgb;
}

// Szene bauen: lines = Textzeilen, W/H = Bildgröße, fill = Anteil der Bildbreite für die Schrift
function chromeScene(opts) {
  const { lines, W, H } = opts;
  const t = textAlpha(lines, opts.px || 300);
  const r = E.renderFromAlpha(t.alpha, t.w, t.h, Object.assign({ material: "chrome" }, opts.chrome || {}));
  const src = new Uint8Array(r.rgba.buffer, r.rgba.byteOffset, r.rgba.length);
  // auf Bildgröße skalieren und mittig platzieren (bilinear)
  const fill = opts.fill || 0.72, s = Math.min(W * fill / r.w, H * (opts.fillH || 0.78) / r.h);
  const dw = Math.round(r.w * s), dh = Math.round(r.h * s), ox = Math.round((W - dw) / 2), oy = Math.round((H - dh) / 2 + (opts.dy || 0) * H);
  const layer = new Uint8Array(W * H * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const X = x + ox, Y = y + oy;
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    const fx = Math.min(r.w - 1.001, x / s), fy = Math.min(r.h - 1.001, y / s), x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
    const o = (Y * W + X) * 4;
    let a = 0; const c = [0, 0, 0];
    for (const [xx, yy, wgt] of [[x0, y0, (1 - ax) * (1 - ay)], [x0 + 1, y0, ax * (1 - ay)], [x0, y0 + 1, (1 - ax) * ay], [x0 + 1, y0 + 1, ax * ay]]) {
      const i = (yy * r.w + xx) * 4, al = src[i + 3] * wgt;
      a += al; c[0] += src[i] * al; c[1] += src[i + 1] * al; c[2] += src[i + 2] * al;
    }
    if (a > 0) { layer[o] = c[0] / a; layer[o + 1] = c[1] / a; layer[o + 2] = c[2] / a; }
    layer[o + 3] = a;
  }
  const bg = background(W, H, opts.bg);
  const base = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const a = layer[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) base[i * 3 + c] = layer[i * 4 + c] * a + bg[i * 3 + c] * (1 - a);
  }
  return { layer, base, W, H };
}

module.exports = { chromeScene, textAlpha, background };
