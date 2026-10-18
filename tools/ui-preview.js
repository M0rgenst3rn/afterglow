// Zeigt die Panel-Oberfläche im Browser (ohne Photoshop): Photoshop/UXP werden nachgebildet.
const SCRIPT_END = "</" + "script>";
const f = document.getElementById("frame");
(async () => {
  const html = await (await fetch("../glow/index.html")).text();
  const core = await (await fetch("../glow/core.js")).text();
  const main = await (await fetch("../glow/main.js")).text();
  const stub = "<script>" + `
  customElements.define("sp-slider", class extends HTMLElement {
    connectedCallback() { if (this._i) return; const i = document.createElement("input"); i.type = "range"; i.min = this.getAttribute("min"); i.max = this.getAttribute("max"); i.step = this.getAttribute("step"); i.style.width = "100%"; i.addEventListener("input", () => this.dispatchEvent(new Event("input"))); this.appendChild(i); this._i = i; this.style.display = "block"; }
    get value() { return this._i ? this._i.value : 0; } set value(v) { if (this._i) this._i.value = v; }
  });
  (function () { const module = { exports: {} };
  ` + core + `
  window.CoreMod = module.exports; })();
  const CoreMod = window.CoreMod;
  const fake = { app: { activeDocument: null, version: "test" }, core: { executeAsModal: async (fn) => fn({ hostControl: { suspendHistory: async () => 1, resumeHistory: async () => {} } }) },
    action: { batchPlay: async () => [{}], addNotificationListener: () => {} }, imaging: {}, constants: {} };
  window.require = (n) => n === "photoshop" ? fake : n === "./core.js" ? CoreMod : { storage: { localFileSystem: { getDataFolder: async () => ({ createFile: async () => ({ write: async () => {} }), getEntry: async () => { throw 1; } }) }, formats: {} } };
  ` + SCRIPT_END;
  const doc = html
    .replace('<link rel="stylesheet" href="styles.css">', () => '<link rel="stylesheet" href="../glow/styles.css">' + stub)
    .replace('<script src="main.js"></' + 'script>', () => "<script>" + main + SCRIPT_END);
  f.srcdoc = doc;
})();
