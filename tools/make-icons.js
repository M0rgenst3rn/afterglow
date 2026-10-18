// Creates the plugin icons: a light source with a halo and four rays.
const fs = require("fs"), path = require("path");
const { encodePNG } = require("./png.js");
const dir = path.join(__dirname, "..", "glow", "icons");
fs.mkdirSync(dir, { recursive: true });
function icon(size, file) {
  const rgba = new Uint8Array(size * size * 4), c = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - c, dy = y + 0.5 - c, d = Math.hypot(dx, dy) / size;
    const core = Math.max(0, Math.min(1, (0.16 - d) * size * 0.6 + 0.5));
    const halo = 0.55 * Math.exp(-d * d / 0.02);
    const ray = Math.max(0, 1 - Math.min(Math.abs(dx), Math.abs(dy)) / (size * 0.035)) * Math.max(0, 1 - d / 0.48);
    const a = Math.min(1, core + halo * 0.8 + ray * 0.9);
    const i = (y * size + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = 225; rgba[i + 3] = a * 255;
  }
  fs.writeFileSync(path.join(dir, file), encodePNG(size, size, rgba, 4));
}
icon(23, "icon@1x.png"); icon(46, "icon@2x.png"); icon(48, "plugin@1x.png"); icon(96, "plugin@2x.png");
console.log("icons written:", fs.readdirSync(dir).join(", "));
