"""Erzeugt eine Nachtszene mit Lichtquellen (Neonschrift, Röhren, Lampen, Mond) als PNG und rohe RGBA-Datei.
Aufruf: python3 tools/make-scene.py <out.png> <breite> <hoehe> [text]"""
import sys, math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

out, W, H = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
text = sys.argv[4] if len(sys.argv) > 4 else "MS GLOW"
img = Image.new("RGB", (W, H))
px = img.load()
for y in range(H):
    t = y / H
    for x in range(W):
        px[x, y] = (int(8 + 18 * t), int(6 + 10 * t), int(22 + 30 * (1 - t)))
d = ImageDraw.Draw(img)
s = H / 540
# Häuser-Silhouetten mit Fenstern
random.seed(4)
x = 0
while x < W:
    bw = int(random.uniform(60, 140) * s); bh = int(random.uniform(120, 300) * s)
    d.rectangle([x, H - bh, x + bw, H], fill=(14, 12, 24))
    for wy in range(H - bh + int(14 * s), H - int(10 * s), int(22 * s)):
        for wx in range(x + int(8 * s), x + bw - int(12 * s), int(18 * s)):
            if random.random() < 0.35:
                c = random.choice([(255, 214, 140), (255, 190, 110), (200, 220, 255)])
                d.rectangle([wx, wy, wx + int(7 * s), wy + int(10 * s)], fill=c)
    x += bw + int(4 * s)
# Mond
mx, my, mr = int(W * 0.82), int(H * 0.2), int(H * 0.09)
d.ellipse([mx - mr, my - mr, mx + mr, my + mr], fill=(250, 246, 232))
# Neonröhren
lw = max(2, int(5 * s))
d.line([(W * 0.08, H * 0.18), (W * 0.32, H * 0.18)], fill=(80, 230, 255), width=lw)
d.arc([W * 0.05, H * 0.24, W * 0.2, H * 0.5], 200, 520, fill=(255, 70, 200), width=lw)
# Straßenlampen (Punkte)
for i in range(6):
    lx = W * (0.1 + i * 0.16); ly = H * 0.62
    r = 5 * s
    d.ellipse([lx - r, ly - r, lx + r, ly + r], fill=(255, 250, 235))
# Neonschrift
f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Black.ttf", int(H * 0.2))
layer = Image.new("RGBA", (W, H)); ld = ImageDraw.Draw(layer)
tw = ld.textlength(text, font=f)
ld.text(((W - tw) / 2 + W * 0.05, H * 0.3), text, font=f, fill=(255, 120, 230, 255), stroke_width=int(4 * s), stroke_fill=(255, 235, 250, 255))
layer = layer.transform(layer.size, Image.AFFINE, (1, 0.2, -H * 0.06, 0, 1, 0), resample=Image.BICUBIC)
img.paste(layer, (0, 0), layer)
img.save(out)
with open(out + ".raw", "wb") as fh:
    fh.write(img.convert("RGBA").tobytes())
print(out, W, H)
