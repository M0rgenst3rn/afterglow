// Erzeugt die Bilder der README mit der echten Engine: eine Chrome-Schrift (MS Render, Ordner daneben)
// als eigene Ebene, darauf Morgenstern Glow im Ebenen-Modus – so, wie man das Tool in Photoshop benutzt.
// node tools/make-showcase.js   (braucht Python mit Pillow für Schrift und Beschriftung)
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const Core = require(path.join(__dirname, "..", "glow", "core.js"));
const { encodePNG } = require("./png.js");
const { chromeScene } = require("./chrome-scene.js");
const OUT = path.join(__dirname, "..", "docs", "images"), TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "msglow-"));
fs.mkdirSync(OUT, { recursive: true });

function glow(sc, p) {
  const res = Core.render({ rgba: sc.layer, w: sc.W, h: sc.H, params: p, sizeBase: sc.H, layerMode: true });
  return Core.composite(res, sc.W, sc.H, sc.base);
}
function save(name, rgb, w, h) { const f = path.join(TMP, name + ".png"); fs.writeFileSync(f, encodePNG(w, h, rgb, 3)); return f; }
function sheet(out, title, tiles, cols, tw, th) {
  const js = path.join(TMP, "sheet.json"); fs.writeFileSync(js, JSON.stringify({ out: path.join(OUT, out), title, cols, tw, th, tiles }));
  execFileSync("python3", ["-I", "-c", `
import json,sys
from PIL import Image, ImageDraw, ImageFont
s=json.load(open(sys.argv[1])); pad=16; head=70 if s["title"] else 0; lab=34
rows=(len(s["tiles"])+s["cols"]-1)//s["cols"]
W=s["cols"]*(s["tw"]+pad)+pad; H=head+rows*(s["th"]+lab+pad)+pad
im=Image.new("RGB",(W,H),(6,8,14)); d=ImageDraw.Draw(im)
fb=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Black.ttf",34); fl=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf",19); fs=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf",14)
if s["title"]:
  t=Image.new("RGBA",(W,head)); ImageDraw.Draw(t).text((pad+4,14),s["title"],font=fb,fill=(242,242,242)); t=t.transform(t.size,Image.AFFINE,(1,0.2,-8,0,1,0),resample=Image.BICUBIC); im.paste(t,(0,0),t)
for n,tile in enumerate(s["tiles"]):
  x=pad+(n%s["cols"])*(s["tw"]+pad); y=head+pad+(n//s["cols"])*(s["th"]+lab+pad)
  im.paste(Image.open(tile["img"]).resize((s["tw"],s["th"]),Image.LANCZOS),(x,y))
  d.text((x+2,y+s["th"]+7),tile["label"],font=fl,fill=(240,240,240))
  if tile.get("sub"): d.text((x+s["tw"]-2,y+s["th"]+10),tile["sub"],font=fs,fill=(150,160,185),anchor="ra")
im.save(s["out"])
`, js]);
}

// der Morgenstern-Look: tiefblaues Licht hinter Chrome
const SIGNATURE = Object.assign(Core.presetParams("chromeaura"), {
  amount: 200, radius: 100, falloff: 0, gamma: 50, tint: "#3d6bff",
  haze: 50, hazeRadius: 100, hazeColor: "#2f5bff", hazeTint: 100, diffusion: 20,
});
const W = 960, H = 405;
const sc = chromeScene({ lines: ["GLOW"], W, H, px: 320, fill: 0.62 });

// 1) Titelbild
{
  const big = chromeScene({ lines: ["GLOW"], W: 1800, H: 760, px: 420, fill: 0.62 });
  fs.writeFileSync(path.join(OUT, "hero.png"), encodePNG(big.W, big.H, glow(big, SIGNATURE), 3));
}
// 2) Vorher / Nachher
sheet("vorher-nachher.png", "", [
  { img: save("orig", sc.base, W, H), label: "Vorher", sub: "Chrome aus MS Render" },
  { img: save("after-sig", glow(sc, SIGNATURE), W, H), label: "Nachher", sub: "blaues Licht dahinter" },
], 2, 840, 354);
// 3) alle Looks
sheet("looks.png", Core.PRESETS.length + " Looks", Core.PRESETS.map((pr) => ({ img: save("look-" + pr.id, glow(sc, Core.presetParams(pr.id)), W, H), label: pr.name })), 3, 560, 236);
// 4) die Effekte einzeln
const only = { amount: 0, halation: 0, diffusion: 0, streaks: 0, stars: 0, haze: 0 };
const blue = { colorMode: "tint", tint: "#3d6bff" };
sheet("effekte.png", "Die Effekte einzeln", [
  { label: "Glow", sub: "physikalischer Abfall", p: Object.assign({}, Core.DEFAULTS, only, blue, { amount: 180, radius: 70 }) },
  { label: "Halation", sub: "Lichtsaum wie bei Film", p: Object.assign({}, Core.DEFAULTS, only, { halation: 100 }) },
  { label: "Diffusion", sub: "Pro-Mist", p: Object.assign({}, Core.DEFAULTS, only, { diffusion: 90 }) },
  { label: "Dunst", sub: "Nebel in der Luft", p: Object.assign({}, Core.DEFAULTS, only, { haze: 90, hazeRadius: 90, hazeColor: "#2f5bff", hazeTint: 90 }) },
  { label: "Lichtstreifen", sub: "anamorph", p: Object.assign({}, Core.DEFAULTS, only, { streaks: 100, streakLength: 80 }) },
  { label: "Sterne", sub: "Sternfilter, 6 Strahlen", p: Object.assign({}, Core.DEFAULTS, only, { stars: 100, starRays: 6, starLength: 100, threshold: 30 }) },
  { label: "Prisma", sub: "Farbsäume", p: Object.assign({}, Core.DEFAULTS, { prism: 100, amount: 180, radius: 60, saturation: 40 }) },
  { label: "Nur außen", sub: "Chrome bleibt Chrome", p: Object.assign({}, SIGNATURE, { haze: 0, diffusion: 0 }) },
  { label: "Eigene Farbe", sub: "Mondlicht", p: Core.presetParams("moon") },
].map((t, n) => ({ img: save("fx-" + n, glow(sc, t.p), W, H), label: t.label, sub: t.sub })), 3, 560, 236);
// 5) Abfall
sheet("abfall.png", "Abfall: weit, mittel, eng", [0, 50, 100].map((f) => ({
  img: save("fall-" + f, glow(sc, Object.assign({}, Core.DEFAULTS, blue, { falloff: f, amount: 180, radius: 80 })), W, H),
  label: `Abfall ${f} %`, sub: f === 0 ? "weiter, flacher Schein" : f === 100 ? "eng um die Schrift" : "",
})), 3, 560, 236);
// 6) Nur außen: Glow über allem vs. nur drumherum
sheet("aura.png", "", [
  { img: save("aura-all", glow(sc, Object.assign({}, SIGNATURE, { outer: 0, haze: 0, diffusion: 0 })), W, H), label: "Glow über allem", sub: "auch die Schrift leuchtet" },
  { img: save("aura-out", glow(sc, Object.assign({}, SIGNATURE, { haze: 0, diffusion: 0 })), W, H), label: "Nur außen", sub: "Chrome bleibt Chrome" },
], 2, 840, 354);
console.log("Bilder geschrieben:", fs.readdirSync(OUT).join(", "));
