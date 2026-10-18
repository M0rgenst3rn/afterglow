// Erzeugt die Bilder der README aus einer Nachtszene (tools/make-scene.py) mit der echten Engine.
// node tools/make-showcase.js   (braucht Python mit Pillow für Szene und Beschriftung)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const Core = require(path.join(__dirname, "..", "glow", "core.js"));
const { encodePNG } = require("./png.js");
const OUT = path.join(__dirname, "..", "docs", "images"), TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "msglow-"));
fs.mkdirSync(OUT, { recursive: true });
function scene(w, h, text) {
  const f = path.join(TMP, `scene-${w}x${h}.png`);
  if (!fs.existsSync(f + ".raw")) execFileSync("python3", ["-I", path.join(__dirname, "make-scene.py"), f, String(w), String(h), text]);
  return new Uint8Array(fs.readFileSync(f + ".raw"));
}
function rgbOf(rgba, n) { const o = new Uint8Array(n * 3); for (let i = 0; i < n; i++) { o[i * 3] = rgba[i * 4]; o[i * 3 + 1] = rgba[i * 4 + 1]; o[i * 3 + 2] = rgba[i * 4 + 2]; } return o; }
function glow(rgba, w, h, p) { return Core.composite(Core.render({ rgba, w, h, params: p, sizeBase: h }), w, h, rgbOf(rgba, w * h)); }
function save(name, rgb, w, h) { const f = path.join(TMP, name + ".png"); fs.writeFileSync(f, encodePNG(w, h, rgb, 3)); return f; }
function sheet(out, title, tiles, cols, tw, th) {
  const js = path.join(TMP, "sheet.json"); fs.writeFileSync(js, JSON.stringify({ out: path.join(OUT, out), title, cols, tw, th, tiles }));
  execFileSync("python3", ["-I", "-c", `
import json,sys
from PIL import Image, ImageDraw, ImageFont
s=json.load(open(sys.argv[1])); pad=16; head=70 if s["title"] else 0; lab=34
rows=(len(s["tiles"])+s["cols"]-1)//s["cols"]
W=s["cols"]*(s["tw"]+pad)+pad; H=head+rows*(s["th"]+lab+pad)+pad
im=Image.new("RGB",(W,H),(10,11,13)); d=ImageDraw.Draw(im)
fb=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Black.ttf",34); fl=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf",19); fs=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf",14)
if s["title"]:
  t=Image.new("RGBA",(W,head)); ImageDraw.Draw(t).text((pad+4,14),s["title"],font=fb,fill=(242,242,242)); t=t.transform(t.size,Image.AFFINE,(1,0.2,-8,0,1,0),resample=Image.BICUBIC); im.paste(t,(0,0),t)
for n,tile in enumerate(s["tiles"]):
  x=pad+(n%s["cols"])*(s["tw"]+pad); y=head+pad+(n//s["cols"])*(s["th"]+lab+pad)
  im.paste(Image.open(tile["img"]).resize((s["tw"],s["th"]),Image.LANCZOS),(x,y))
  d.text((x+2,y+s["th"]+7),tile["label"],font=fl,fill=(240,240,240))
  if tile.get("sub"): d.text((x+s["tw"]-2,y+s["th"]+10),tile["sub"],font=fs,fill=(140,144,152),anchor="ra")
im.save(s["out"])
`, js]);
}
const W = 960, H = 540, base = scene(W, H, "MS GLOW");
// 1) Hero
{ const w = 1800, h = 760, src = scene(w, h, "MS GLOW"); fs.writeFileSync(path.join(OUT, "hero.png"), encodePNG(w, h, glow(src, w, h, Object.assign(Core.presetParams("dreamy"), { amount: 75, protect: 70, streaks: 30, streakLength: 45, halation: 25, stars: 30, starLength: 30 })), 3)); }
// 2) alle Looks
sheet("looks.png", Core.PRESETS.length + " Looks", Core.PRESETS.map((pr) => ({ img: save("look-" + pr.id, glow(base, W, H, Core.presetParams(pr.id)), W, H), label: pr.name })), 3, 560, 315);
// 3) die Effekte einzeln
const only = { amount: 0, halation: 0, diffusion: 0, streaks: 0, stars: 0 };
sheet("effekte.png", "Die Effekte einzeln", [
  { label: "Glow", sub: "physikalischer Abfall", p: Object.assign({}, Core.DEFAULTS, only, { amount: 100 }) },
  { label: "Halation", sub: "Lichtsaum wie bei Film", p: Object.assign({}, Core.DEFAULTS, only, { halation: 90, threshold: 50 }) },
  { label: "Diffusion", sub: "Pro-Mist", p: Object.assign({}, Core.DEFAULTS, only, { diffusion: 80 }) },
  { label: "Lichtstreifen", sub: "anamorph", p: Object.assign({}, Core.DEFAULTS, only, { streaks: 85, streakLength: 70 }) },
  { label: "Sterne", sub: "Sternfilter, 6 Strahlen", p: Object.assign({}, Core.DEFAULTS, only, { stars: 90, starRays: 6, starLength: 45 }) },
  { label: "Dunst", sub: "Nebel in der Luft, Türkis", p: Object.assign({}, Core.DEFAULTS, only, { haze: 85, hazeRadius: 60, hazeTint: 65 }) },
  { label: "Prisma", sub: "Farbsäume", p: Object.assign({}, Core.DEFAULTS, { prism: 100, amount: 100, saturation: 30 }) },
  { label: "Farbbereich", sub: "nur Pink leuchtet", p: Core.presetParams("pinkonly") },
  { label: "Eigene Farbe", sub: "Mondlicht", p: Core.presetParams("moon") },
  { label: "Kern schützen", sub: "0 % und 100 % im Vergleich", p: null },
].map((t, n) => {
  if (!t.p) {   // geteiltes Bild: links ohne, rechts mit Kernschutz
    const a = glow(base, W, H, Object.assign({}, Core.DEFAULTS, { amount: 120, protect: 0 })), b = glow(base, W, H, Object.assign({}, Core.DEFAULTS, { amount: 120, protect: 100 }));
    for (let y = 0; y < H; y++) for (let x = W / 2; x < W; x++) for (let c = 0; c < 3; c++) a[(y * W + x) * 3 + c] = b[(y * W + x) * 3 + c];
    for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) a[(y * W + W / 2) * 3 + c] = 255;
    return { img: save("fx-" + n, a, W, H), label: t.label, sub: t.sub };
  }
  return { img: save("fx-" + n, glow(base, W, H, t.p), W, H), label: t.label, sub: t.sub };
}), 3, 560, 315);
// 4) Abfall
sheet("abfall.png", "Abfall: weit, mittel, eng", [0, 50, 100].map((f) => ({ img: save("fall-" + f, glow(base, W, H, Object.assign({}, Core.DEFAULTS, { falloff: f, amount: 100, radius: 60 })), W, H), label: `Abfall ${f} %`, sub: f === 0 ? "weiter, flacher Schein" : f === 100 ? "eng um die Lichtquelle" : "" })), 3, 560, 315);
// 5) Vorher / Nachher
sheet("vorher-nachher.png", "", [
  { img: save("orig", rgbOf(base, W * H), W, H), label: "Vorher" },
  { img: save("after-dreamy", glow(base, W, H, Core.presetParams("dreamy")), W, H), label: "Traumhaft" },
  { img: save("after-stage", glow(base, W, H, Core.presetParams("stage")), W, H), label: "Bühnenlicht" },
], 3, 560, 315);
console.log("Bilder geschrieben:", fs.readdirSync(OUT).join(", "));
