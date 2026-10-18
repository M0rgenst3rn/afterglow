"use strict";
// MS Glow – Photoshop-UXP-Panel.
// Licht-Effekte für das ganze Dokument oder einzelne Ebenen, nicht-destruktiv:
//  • Ganzes Dokument: oben eine Gruppe „MS Glow“ mit echten Ebenen (Glow, Halation, Diffusion, Lichtstreifen,
//    Sterne), die das Artwork nur aufhellen. Das Artwork darunter bleibt unverändert.
//  • Ausgewählte Ebenen: jede Ebene wandert in eine Gruppe „MS Glow · Name“; das Original liegt sichtbar darin,
//    die Effekt-Ebenen darüber (Ebenenmaske berücksichtigt). Entfernen stellt alles wieder her.
// Die Einstellungen stehen im XMP der Effekt-Ebenen – Gruppe auswählen lädt sie wieder ins Panel.

const { app, core, action, imaging, constants } = require("photoshop");
const { batchPlay } = action;
const Core = require("./core.js");
const uxpStorage = require("uxp").storage;
const lfs = uxpStorage.localFileSystem;

const $ = (id) => document.getElementById(id);
const STORE_KEY = "msglow.state.v1";
const TARGET_KEY = "msglow.target.v1";
const PRESET_KEY = "msglow.presets.v1";
const GROUP_DOC = "MS Glow";
const LAYER_PREFIX = "MS Glow · ";
const HIST = "MS Glow";
const XMP_NS = "http://ms-glow/1.0/";
const MAX_PIXELS = 60e6;
const TARGET = [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];
const RENDER_NAMES = new Set(Core.LAYERS.map((l) => l.name));


const SLIDERS = [
  { key: "opacity", label: "Gesamt-Deckkraft", min: 0, max: 100, step: 1, unit: "%", parent: "secStrengthTop" },
  { key: "threshold", label: "Schwelle", min: 0, max: 100, step: 1, unit: "%", parent: "secSource", tip: "Ab welcher Helligkeit etwas leuchtet" },
  { key: "knee", label: "Übergang", min: 0, max: 100, step: 1, unit: "%", parent: "secSource", tip: "Weicher Übergang an der Schwelle" },
  { key: "gamma", label: "Gamma", min: 50, max: 200, step: 1, unit: "%", parent: "secSource", tip: "Höher = nur die hellsten Stellen leuchten kräftig" },
  { key: "rangeWidth", label: "Farbbereich", min: 0, max: 100, step: 1, unit: "%", parent: "secRange", tip: "0 = alle Farben leuchten; sonst nur Farben nahe der gewählten" },
  { key: "amount", label: "Stärke", min: 0, max: 200, step: 1, unit: "%", parent: "secGlow" },
  { key: "radius", label: "Radius", min: 2, max: 100, step: 1, unit: "%", parent: "secGlow", tip: "Reichweite des Leuchtens" },
  { key: "falloff", label: "Abfall", min: 0, max: 100, step: 1, unit: "%", parent: "secGlow", tip: "Klein = weiter, flacher Schein; groß = eng um die Lichtquelle" },
  { key: "protect", label: "Kern schützen", min: 0, max: 100, step: 1, unit: "%", parent: "secGlow", tip: "Helle Flächen behalten ihre Zeichnung statt weiß zu werden" },
  { key: "saturation", label: "Sättigung", min: -100, max: 100, step: 1, unit: "", parent: "secGlow" },
  { key: "prism", label: "Prisma", min: 0, max: 100, step: 1, unit: "%", parent: "secGlow", tip: "Farbsäume: Rot reicht weiter als Blau" },
  { key: "halation", label: "Halation", min: 0, max: 100, step: 1, unit: "%", parent: "secHalation", tip: "Rot-oranger Lichtsaum um helle Kanten, wie bei Film" },
  { key: "halationRadius", label: "Halation-Radius", min: 5, max: 100, step: 1, unit: "%", parent: "secHalation", show: (p) => p.halation > 0 },
  { key: "diffusion", label: "Diffusion", min: 0, max: 100, step: 1, unit: "%", parent: "secDiffusion", tip: "Nebliger Weichzeichner (Pro-Mist)" },
  { key: "diffusionRadius", label: "Diffusion-Radius", min: 5, max: 100, step: 1, unit: "%", parent: "secDiffusion", show: (p) => p.diffusion > 0 },
  { key: "streaks", label: "Lichtstreifen", min: 0, max: 100, step: 1, unit: "%", parent: "secStreaks", tip: "Anamorphe, waagerechte Streifen an hellen Punkten" },
  { key: "streakLength", label: "Streifen-Länge", min: 5, max: 100, step: 1, unit: "%", parent: "secStreaks", show: (p) => p.streaks > 0 },
  { key: "stars", label: "Sterne", min: 0, max: 100, step: 1, unit: "%", parent: "secStars", tip: "Sternfilter: Strahlen an den hellsten Punkten" },
  { key: "starLength", label: "Strahlen-Länge", min: 5, max: 100, step: 1, unit: "%", parent: "secStars", show: (p) => p.stars > 0 },
  { key: "starAngle", label: "Drehung", min: 0, max: 90, step: 1, unit: "°", parent: "secStars", show: (p) => p.stars > 0 },
];

let params = loadParams();
let target = loadTarget();         // "document" | "layers"
let previewSrc = null;
let thumbSrc = null;
let previewMode = "fit";
let busy = false;
let activeLook = null;
const ctl = {};
const lastApplied = new Map();     // Ziel-Schlüssel -> Parameter (für den Hinweis „noch nicht angewendet“)
let loadedKey = null;              // Gruppe, deren Einstellungen zuletzt ins Panel geladen wurden

// ---------------------------------------------------------------- Persistenz
function loadParams() { try { return Core.sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch (e) { return Object.assign({}, Core.DEFAULTS); } }
function saveParams() { try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch (e) { /* egal */ } }
function loadTarget() { try { return localStorage.getItem(TARGET_KEY) === "layers" ? "layers" : "document"; } catch (e) { return "document"; } }
function saveTarget() { try { localStorage.setItem(TARGET_KEY, target); } catch (e) { /* egal */ } }
function loadUserPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || "{}"); } catch (e) { return {}; } }
function saveUserPresets(p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch (e) { /* egal */ } }

// ---------------------------------------------------------------- Helfer
function setStatus(msg, isErr) { const el = $("status"); el.textContent = msg || ""; el.className = isErr ? "status err" : "status"; }
function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hexToRgb(hex) { const n = parseInt(String(hex).slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
function rgbToHex(r, g, b) { return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
function docBounds(doc) { return { left: 0, top: 0, right: Math.round(Number(doc.width)), bottom: Math.round(Number(doc.height)) }; }
function boundsOf(layer) { const b = layer.boundsNoEffects || layer.bounds; return { left: Math.floor(b.left), top: Math.floor(b.top), right: Math.ceil(b.right), bottom: Math.ceil(b.bottom) }; }
// Bereich einer Ebene: das ganze Dokument – das Licht strahlt weit über das Objekt hinaus
function layerRegion(doc) { return docBounds(doc); }
function clampBounds(b, d) { return { left: Math.max(d.left, b.left), top: Math.max(d.top, b.top), right: Math.min(d.right, b.right), bottom: Math.min(d.bottom, b.bottom) }; }
async function selectLayer(id) { await batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false }], {}); }
async function selectLayers(ids) {
  const cmds = ids.map((id, i) => {
    const c = { _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false };
    if (i > 0) c.selectionModifier = { _enum: "selectionModifierType", _value: "addToSelection" };
    return c;
  });
  if (cmds.length) await batchPlay(cmds, {});
}
function allLayers(container, out) { for (const l of container.layers || []) { out.push(l); if (l.layers) allLayers(l, out); } return out; }
const isGroup = (l) => !!(l && l.layers);
const isDocGroup = (l) => isGroup(l) && l.name === GROUP_DOC;
const isLayerGroup = (l) => isGroup(l) && String(l.name).startsWith(LAYER_PREFIX);
function docGroups(doc) { return doc.layers.filter(isDocGroup); }
function to8bit(data, cs) {
  if (cs === 8) return data;
  const out = new Uint8Array(data.length), f = cs === 16 ? 255 / 32768 : 255;
  for (let i = 0; i < data.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(data[i] * f)));
  return out;
}
function fromBuf8(buf, doc) {
  if (buf instanceof Uint8ClampedArray) buf = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);   // Photoshop nimmt nur Uint8/Uint16/Float32
  const depth = String(doc.bitsPerChannel || "");
  if (depth.indexOf("16") >= 0) { const out = new Uint16Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = Math.round(buf[i] * 32768 / 255); return out; }
  if (depth.indexOf("32") >= 0) { const out = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 255; return out; }
  return buf;
}
function toRGBA(raw, comps, n) {
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (comps >= 3) { out[i * 4] = raw[i * comps]; out[i * 4 + 1] = raw[i * comps + 1]; out[i * 4 + 2] = raw[i * comps + 2]; }
    else out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = raw[i * comps];
    out[i * 4 + 3] = comps === 4 || comps === 2 ? raw[i * comps + comps - 1] : 255;
  }
  return out;
}
function needsRGB(doc) {
  if (String(doc.mode).toLowerCase().indexOf("rgb") >= 0) return false;
  setStatus(HIST + " braucht ein RGB-Dokument – Bild › Modus › RGB-Farbe.", true);
  return true;
}

// ---------------------------------------------------------------- Protokoll
const logLines = [];
let logTimer = null;
function log(msg, data) {
  logLines.push(new Date().toISOString() + " " + msg + (data !== undefined ? " " + JSON.stringify(data) : ""));
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  clearTimeout(logTimer);
  logTimer = setTimeout(async () => {
    try { const f = await (await lfs.getDataFolder()).createFile("glow-log.txt", { overwrite: true }); await f.write(logLines.join("\n") + "\n"); } catch (e) { /* egal */ }
  }, 300);
}

// ---------------------------------------------------------------- XMP (Einstellungen an den Effekt-Ebenen)
function xmpFor(p, sourceId) {
  const json = JSON.stringify({ params: p, sourceId: sourceId || null }).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:msglow="${XMP_NS}"><msglow:params>${json}</msglow:params></rdf:Description></rdf:RDF></x:xmpmeta>`;
}
async function writeXmp(layerId, p, sourceId) {
  await batchPlay([{ _obj: "set", _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }], to: { _obj: "layer", XMPMetadataAsUTF8: xmpFor(p, sourceId) } }], {});
}
async function readXmp(layerId) {
  try {
    const r = await batchPlay([{ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, { _ref: "layer", _id: layerId }] }], {});
    const x = r && r[0] && r[0].XMPMetadataAsUTF8;
    const m = x && /<msglow:params>([\s\S]*?)<\/msglow:params>/.exec(x);
    if (!m) return null;
    const o = JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&amp;/g, "&"));
    return { params: Core.sanitize(o.params), sourceId: o.sourceId || null };
  } catch (e) { return null; }
}
async function groupInfo(group) {
  const kids = Array.from(group.layers);
  let saved = null, signal = null;
  for (const k of kids) { if (k.layers || !RENDER_NAMES.has(k.name)) continue; const x = await readXmp(k.id); if (x) { saved = x; signal = k; break; } }
  let source = saved && saved.sourceId ? kids.find((k) => k.id === saved.sourceId) : null;
  if (!source) source = kids.slice().reverse().find((k) => !RENDER_NAMES.has(k.name)) || null;   // ältere/fremde Gruppen
  return { group, source, signal, saved };
}

// Ebenen-Ziele: ausgewählte Ebenen; eine MS-Phase-Gruppe (oder eine Ebene darin) steht für ihr Original
async function resolveTargets(doc) {
  const out = [], seen = new Set(), skipped = [];
  for (const l of doc.activeLayers || []) {
    let g = null;
    if (isLayerGroup(l)) g = l;
    else if (l.parent && isLayerGroup(l.parent)) g = l.parent;
    if (g) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const info = await groupInfo(g);
      if (info.source) out.push(info); else skipped.push(g.name);
      continue;
    }
    if (isDocGroup(l) || (l.parent && isDocGroup(l.parent))) { skipped.push(l.name); continue; }
    if (isGroup(l) || l.isBackgroundLayer) { skipped.push(l.name); continue; }
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push({ group: null, source: l, signal: null, saved: null });
  }
  return { targets: out, skipped };
}

// ---------------------------------------------------------------- Pixel lesen
// Dokument OHNE die MS-Phase-Dokumentgruppe. hide/show: weitere Ebenen kurz aus-/einblenden (Protokoll wird
// zurückgerollt). inHistory: läuft schon in einem eigenen Protokollschritt – dann nichts aus-/einblenden,
// was danach nicht ohnehin ersetzt wird.
async function readComposite(ctx, doc, sourceBounds, targetSize, opt) {
  opt = opt || {};
  const hide = docGroups(doc).filter((g) => g.visible).concat((opt.hide || []).filter((l) => l.visible));
  const show = (opt.show || []).filter((l) => !l.visible);
  let hid = null;
  if (hide.length || show.length) {
    if (!opt.inHistory) hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " lesen" });
    for (const l of hide) l.visible = false;
    for (const l of show) l.visible = true;
  }
  try {
    const o = { documentID: doc.id, sourceBounds, colorSpace: "RGB", componentSize: 8 };
    if (targetSize) o.targetSize = targetSize;
    const res = await imaging.getPixels(o);
    const id = res.imageData;
    const raw = to8bit(await id.getData({ chunky: true }), id.componentSize || 8);
    const out = { w: id.width, h: id.height, rgba: toRGBA(raw, id.components, id.width * id.height), sb: res.sourceBounds || sourceBounds };
    id.dispose();
    return out;
  } finally {
    if (hid !== null) await ctx.hostControl.resumeHistory(hid, false);
    else if (opt.inHistory) { for (const l of hide) l.visible = true; for (const l of show) l.visible = false; }
  }
}
async function hasActiveMask(id) {
  try {
    const r = await batchPlay([{ _obj: "get", _target: [{ _property: "hasUserMask" }, { _ref: "layer", _id: id }] }, { _obj: "get", _target: [{ _property: "userMaskEnabled" }, { _ref: "layer", _id: id }] }], {});
    return !!(r && r[0] && r[0].hasUserMask) && !(r[1] && r[1].userMaskEnabled === false);
  } catch (e) { return false; }
}
// Pixel einer Ebene in voller Auflösung über sourceBounds – inkl. Ebenenmaske (freigestellte Objekte).
// Ein ausgeblendetes Original wird kurz eingeblendet. inHistory: läuft schon in einem eigenen Protokollschritt.
async function readLayer(ctx, doc, layer, sourceBounds, inHistory) {
  let hid = null;
  const wasHidden = !layer.visible;
  if (wasHidden) { if (!inHistory) hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " lesen" }); layer.visible = true; }
  const W = sourceBounds.right - sourceBounds.left, H = sourceBounds.bottom - sourceBounds.top;
  const rgba = new Uint8Array(W * H * 4);
  try {
    const res = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, sourceBounds, colorSpace: "RGB", componentSize: 8 });
    const id = res.imageData, raw = to8bit(await id.getData({ chunky: true }), id.componentSize || 8);
    const sb = res.sourceBounds || sourceBounds, src = toRGBA(raw, id.components, id.width * id.height);
    // getPixels liefert nur den belegten Bereich – auf den angefragten Ausschnitt legen
    for (let y = 0; y < id.height; y++) for (let x = 0; x < id.width; x++) {
      const tx = sb.left - sourceBounds.left + x, ty = sb.top - sourceBounds.top + y;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const s = (y * id.width + x) * 4, d = (ty * W + tx) * 4;
      rgba[d] = src[s]; rgba[d + 1] = src[s + 1]; rgba[d + 2] = src[s + 2]; rgba[d + 3] = src[s + 3];
    }
    id.dispose();
    if (await hasActiveMask(layer.id)) {
      const mr = await imaging.getLayerMask({ documentID: doc.id, layerID: layer.id, kind: "user", sourceBounds });
      const md = mr.imageData, mraw = to8bit(await md.getData({ chunky: true }), md.componentSize || 8);
      const mb = mr.sourceBounds || sourceBounds, mw = md.width, mh = md.height;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        // außerhalb der gelieferten Maske gilt ihr Randwert
        const mx = Math.max(0, Math.min(mw - 1, sourceBounds.left + x - mb.left)), my = Math.max(0, Math.min(mh - 1, sourceBounds.top + y - mb.top));
        const i = (y * W + x) * 4;
        rgba[i + 3] = rgba[i + 3] * mraw[(my * mw + mx) * md.components] / 255;
      }
      md.dispose();
    }
    return { w: W, h: H, rgba };
  } finally {
    if (wasHidden) { layer.visible = false; if (hid !== null) await ctx.hostControl.resumeHistory(hid, false); }
  }
}
// Verkleinert ein RGBA-Bild (Box-Mittel, Alpha-gewichtet) auf ein Raster mit ps Quell-Pixeln je Pixel
function downsample(src, sw, sh, ox, oy, w, h, ps) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(ox + x * ps), x1 = Math.max(x0 + 1, Math.floor(ox + (x + 1) * ps));
    const y0 = Math.floor(oy + y * ps), y1 = Math.max(y0 + 1, Math.floor(oy + (y + 1) * ps));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = Math.max(0, y0); yy < Math.min(sh, y1); yy++) for (let xx = Math.max(0, x0); xx < Math.min(sw, x1); xx++) {
      const i = (yy * sw + xx) * 4, al = src[i + 3];
      r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
    }
    n = (x1 - x0) * (y1 - y0);
    const o = (y * w + x) * 4;
    if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
    out[o + 3] = a / n;
  }
  return out;
}

// ---------------------------------------------------------------- UI aufbauen
function buildSliders() {
  for (const s of SLIDERS) {
    const row = document.createElement("div");
    row.className = "ctl";
    if (s.tip) row.title = s.tip;
    row.innerHTML = `<span class="ctl-label">${s.label}</span><sp-slider class="ctl-range" min="${s.min}" max="${s.max}" step="${s.step}"></sp-slider><input class="ctl-num" type="text"><span class="ctl-unit">${s.unit}</span>`;
    $(s.parent).appendChild(row);
    const range = row.querySelector(".ctl-range"), num = row.querySelector(".ctl-num");
    ctl[s.key] = { range, num, row, def: s };
    const onRange = () => { params[s.key] = Number(range.value); num.value = String(params[s.key]); activeLook = null; changed(); };
    range.addEventListener("input", onRange);
    range.addEventListener("change", onRange);
    num.addEventListener("change", () => {
      let v = parseFloat(String(num.value).replace(",", "."));
      if (isNaN(v)) v = params[s.key];
      params[s.key] = Math.max(s.min, Math.min(s.max, v));
      activeLook = null; syncUI(); changed();
    });
  }
}
function buildStatic() {
  $("glowBlend").innerHTML = Core.BLENDS.map((b) => `<option value="${b.id}">${b.name}</option>`).join("");
  $("starRays").innerHTML = Core.RAYS.map((n) => `<option value="${n}">${n} Strahlen</option>`).join("");
  const grid = $("lookGrid");
  grid.innerHTML = "";
  for (const pr of Core.PRESETS) {
    const t = document.createElement("div");
    t.className = "look";
    t.dataset.id = pr.id;
    t.title = pr.name;
    t.innerHTML = `<div class="ph"></div><div class="lbl">${pr.name}</div>`;
    t.addEventListener("click", () => applyLook(pr.id));
    grid.appendChild(t);
  }
  rebuildPresetSelect();
}
function rebuildPresetSelect() {
  const user = loadUserPresets();
  let html = `<option value="">– Eigenes Preset laden –</option>`;
  for (const n of Object.keys(user)) html += `<option value="${n}">★ ${n}</option>`;
  $("presetSelect").innerHTML = html;
  $("presetSelect").value = "";
}
function applyLook(id) {
  const pr = Core.presetParams(id);
  if (!pr) return;
  params = Object.assign(pr, { opacity: params.opacity });
  activeLook = id;
  syncUI(); changed();
  setStatus(`Look „${Core.PRESETS.find((x) => x.id === id).name}“ – alle Regler bleiben frei einstellbar.`);
}

// Farbfelder: [Element-ID, Parameter]
const COLOR_FIELDS = [["tint", "tint"], ["rangeColor", "rangeColor"], ["halationColor", "halationColor"], ["streakColor", "streakColor"]];
function syncUI() {
  for (const key of Object.keys(ctl)) {
    const c = ctl[key];
    c.range.value = String(params[key]); c.num.value = String(params[key]);
    c.row.className = c.def.show && !c.def.show(params) ? "ctl hidden" : "ctl";
  }
  document.querySelectorAll("#colorSeg .seg-btn").forEach((el) => { el.className = el.dataset.color === params.colorMode ? "seg-btn active" : "seg-btn"; });
  document.querySelectorAll("#targetSeg .seg-btn").forEach((el) => { el.className = el.dataset.target === target ? "seg-btn active" : "seg-btn"; });
  document.querySelectorAll("#previewModeSeg .seg-btn").forEach((el) => { el.className = el.dataset.mode === previewMode ? "seg-btn active" : "seg-btn"; });
  document.querySelectorAll(".look").forEach((el) => { el.className = el.dataset.id === activeLook ? "look active" : "look"; });
  $("lookName").textContent = activeLook ? "· " + Core.PRESETS.find((x) => x.id === activeLook).name : "";
  $("tintRow").className = params.colorMode === "tint" ? "row" : "row hidden";
  $("rangeRow").className = params.rangeWidth > 0 ? "row" : "row dim";
  $("halationColorRow").className = params.halation > 0 ? "row" : "row hidden";
  $("streakColorRow").className = params.streaks > 0 ? "row" : "row hidden";
  $("starRaysRow").className = params.stars > 0 ? "row" : "row hidden";
  for (const [id, key] of COLOR_FIELDS) { $("hex-" + id).value = params[key]; $("swatch-" + id).style.backgroundColor = params[key]; }
  $("glowBlend").value = params.glowBlend;
  $("starRays").value = String(params.starRays);
  $("apply").textContent = target === "document" ? "Look anwenden" : "Auf Ebene anwenden";
}

function bindControls() {
  document.querySelectorAll("#colorSeg .seg-btn").forEach((el) => el.addEventListener("click", () => { params.colorMode = el.dataset.color; activeLook = null; syncUI(); changed(); }));
  document.querySelectorAll("#targetSeg .seg-btn").forEach((el) => el.addEventListener("click", () => {
    target = el.dataset.target; saveTarget(); loadedKey = null; previewSrc = null; thumbSrc = null; syncUI(); refreshPreviewSource();
  }));
  document.querySelectorAll("#previewModeSeg .seg-btn").forEach((el) => el.addEventListener("click", () => { previewMode = el.dataset.mode; syncUI(); refreshPreviewSource(); }));
  $("glowBlend").addEventListener("change", (e) => { params.glowBlend = e.target.value; activeLook = null; syncUI(); changed(); });
  $("starRays").addEventListener("change", (e) => { params.starRays = Number(e.target.value); activeLook = null; syncUI(); changed(); });
  for (const [id, key] of COLOR_FIELDS) {
    $("hex-" + id).addEventListener("change", (e) => {
      let v = String(e.target.value).trim(); if (v[0] !== "#") v = "#" + v;
      if (/^#[0-9a-f]{6}$/i.test(v)) params[key] = v.toLowerCase();
      activeLook = null; syncUI(); changed();
    });
    $("swatch-" + id).addEventListener("click", () => pickColor(key));
  }
  $("previewOriginal").addEventListener("change", () => renderPreview());
  $("refreshPreview").addEventListener("click", () => { previewSrc = null; refreshPreviewSource(); });
  $("presetSelect").addEventListener("change", (e) => {
    const src = loadUserPresets()[e.target.value];
    if (!src) return;
    params = Core.sanitize(src); activeLook = null;
    syncUI(); changed();
    setStatus(`Preset „${e.target.value}“ geladen.`);
  });
  $("presetSave").addEventListener("click", () => {
    const name = String($("presetName").value || "").trim();
    if (!name) return setStatus("Bitte einen Namen für das Preset eingeben.", true);
    const user = loadUserPresets(); user[name] = Object.assign({}, params); saveUserPresets(user);
    rebuildPresetSelect(); $("presetName").value = "";
    setStatus(`Preset „${name}“ gespeichert.`);
  });
  $("presetDelete").addEventListener("click", () => {
    const v = $("presetSelect").value;
    if (!v) return setStatus("Wähle zuerst ein eigenes Preset aus.", true);
    const user = loadUserPresets(); delete user[v]; saveUserPresets(user); rebuildPresetSelect();
    setStatus("Preset gelöscht.");
  });
  $("resetAll").addEventListener("click", () => { params = Object.assign({}, Core.DEFAULTS); activeLook = Core.PRESETS[0].id; syncUI(); changed(); });
  $("liveCanvas").addEventListener("change", (e) => {
    liveLast = null;
    if (e.target.checked) applyEffect(true);
    else setStatus("Live aus – der aktuelle Stand bleibt im Dokument.");
  });
  $("apply").addEventListener("click", () => applyEffect(false));
  $("remove").addEventListener("click", removeEffect);
  $("verify").addEventListener("click", verifyNowUI);
  $("selfTest").addEventListener("click", runSelfTest);
}
async function pickColor(key) {
  const c0 = hexToRgb(params[key]);
  try {
    let res;
    await core.executeAsModal(async () => {
      res = await batchPlay([{ _obj: "showColorPicker", _target: { _ref: "application" }, context: HIST, color: { _obj: "RGBColor", red: c0.r, grain: c0.g, blue: c0.b } }], {});
    }, { commandName: "Farbe wählen" });
    const c = res && res[0] && (res[0].RGBFloatColor || res[0].color);
    if (c && c.red !== undefined) { params[key] = rgbToHex(c.red, c.grain !== undefined ? c.grain : c.green, c.blue); activeLook = null; syncUI(); changed(); }
  } catch (e) { setStatus("Farbwähler nicht verfügbar – Hex-Wert eintippen.", true); }
}


const debouncedPreview = debounce(() => renderPreview(), 60);
function changed() {
  params = Core.sanitize(params);
  saveParams();
  debouncedPreview();
  if ($("liveCanvas").checked) debouncedLive();
  else showSyncHint();
}
function showSyncHint() {
  const key = previewSrc && previewSrc.key;
  const applied = key && lastApplied.get(key);
  if (!applied) return;
  const diff = Object.keys(Core.DEFAULTS).filter((k) => JSON.stringify(applied[k]) !== JSON.stringify(params[k]));
  if (diff.length) setStatus(`● Noch nicht im Dokument – „${$("apply").textContent}“ klicken oder Live einschalten.`);
  else setStatus("Dokument entspricht den Einstellungen.");
}

// ---------------------------------------------------------------- Vorschau
const PV_W = 300, PV_H = 170, TH_W = 96, TH_H = 54;
const GRAY = 26;
function sizeFit(w, h, mw, mh) { const f = Math.min(1, mw / w, mh / h); return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round(h * f)) }; }
function rgbOf(rgba, n, bg) {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = bg === null ? 1 : rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = rgba[i * 4 + c] * a + (bg || 0) * (1 - a);
  }
  return out;
}
function flatRGB(n, v) { const o = new Uint8Array(n * 3); o.fill(v); return o; }

async function refreshPreviewSource() {
  if (busy) return;
  const doc = app.activeDocument;
  if (!doc) { previewSrc = null; showTarget(null); return renderPreview("Kein Dokument geöffnet."); }
  const dB = docBounds(doc), dw = dB.right, dh = dB.bottom;
  let info = null;
  if (target === "document") {
    const g = docGroups(doc)[0];
    if (g) info = await groupInfo(g);
    showTarget(doc.name || "Dokument");
  } else {
    const r = await resolveTargets(doc);
    if (!r.targets.length) {
      previewSrc = null; showTarget(null);
      return renderPreview(r.skipped.length ? "Gruppen und den Hintergrund bitte über „Ganzes Dokument“ bearbeiten." : "Wähle in der Ebenen-Palette eine Ebene (Bild, Text, Form)…");
    }
    info = r.targets[0];
    showTarget(info.source.name + (r.targets.length > 1 ? ` (+${r.targets.length - 1} weitere)` : ""));
  }
  // Einstellungen einer bestehenden Gruppe übernehmen (nur beim Wechsel der Gruppe – offene Änderungen bleiben)
  if (info && info.group && info.saved) {
    if (loadedKey !== info.group.id) {
      loadedKey = info.group.id;
      params = Core.sanitize(info.saved.params); activeLook = null;
      lastApplied.set(targetKey(doc, info), Object.assign({}, params));
      saveParams(); syncUI();
      setStatus(`Einstellungen aus „${info.group.name}“ geladen.`);
    }
  } else loadedKey = null;
  // Zielbereich: Dokument oder die Ebene; die Vorschau zeigt immer das Dokument
  const lb = dB;   // Licht reicht über das Objekt hinaus: immer das ganze Dokument
  const fw = lb.right - lb.left, fh = lb.bottom - lb.top;
  const ob = target === "document" ? dB : boundsOf(info.source);
  if (fw <= 0 || fh <= 0 || ob.right <= ob.left || ob.bottom <= ob.top) { previewSrc = null; return renderPreview("Die Ebene ist leer."); }
  let view = dB, ts = sizeFit(dw, dh, PV_W, PV_H);
  if (previewMode === "detail") {
    const w = Math.min(dw, PV_W), h = Math.min(dh, PV_H);
    const cx = (lb.left + lb.right) / 2, cy = (lb.top + lb.bottom) / 2;
    const left = Math.max(0, Math.min(dw - w, Math.round(cx - w / 2))), top = Math.max(0, Math.min(dh - h, Math.round(cy - h / 2)));
    view = { left, top, right: left + w, bottom: top + h }; ts = null;
  }
  const tts = sizeFit(dw, dh, TH_W, TH_H);
  try {
    let pv = null, th = null, lay = null;
    await core.executeAsModal(async (ctx) => {
      // im Ebenen-Modus: Dokument mit dem Original, aber ohne alte TV-Ebenen dieses Objekts
      const opt = target === "layers" && info.group ? { hide: Array.from(info.group.layers).filter((k) => k.id !== info.source.id), show: [info.source] } : {};
      pv = await readComposite(ctx, doc, view, ts, opt);
      th = await readComposite(ctx, doc, dB, tts, opt);
      if (target === "layers") lay = await readLayer(ctx, doc, info.source, lb, false);
    }, { commandName: HIST + " Vorschau" });
    ignoreEventsUntil = Date.now() + 600;
    const mk = (c, v, ps) => {
      const n = c.w * c.h, original = rgbOf(c.rgba, n, null);
      const s = { w: c.w, h: c.h, pxScale: ps, sizeBase: dh, original };
      s.rgba = target === "document" ? c.rgba : downsample(lay.rgba, lay.w, lay.h, v.left - lb.left, v.top - lb.top, c.w, c.h, ps);
      return s;
    };
    previewSrc = mk(pv, view, previewMode === "detail" ? 1 : dw / pv.w);
    previewSrc.key = targetKey(doc, info);
    const tsig = JSON.stringify([doc.id, target, lb, th.w, th.h]) + ":" + checksum(th.rgba) + ":" + (lay ? checksum(lay.rgba) : 0);
    const newThumbs = !thumbSrc || thumbSrc.sig !== tsig;
    thumbSrc = mk(th, dB, dw / th.w);
    thumbSrc.sig = tsig;
    renderPreview();
    if (newThumbs) renderThumbs();
  } catch (e) {
    previewSrc = null;
    renderPreview("Vorschau nicht möglich: " + (e.message || e));
  }
}
// zeigt unter der Vorschau, was gerade bearbeitet wird
function showTarget(name) {
  $("targetName").textContent = name ? (target === "document" ? "Ganzes Dokument" : "Ebene: " + name) : "–";
  $("targetInfo").innerHTML = target === "document"
    ? `Bearbeitet wird: <b>das ganze Dokument</b>${name ? " · " + esc(name) : ""}`
    : name ? `Bearbeitet wird nur: <b>${esc(name)}</b>` : `Bearbeitet wird nur: <b>die ausgewählte Ebene</b> – bitte eine auswählen`;
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function targetKey(doc, info) { return target === "document" ? "doc:" + doc.id : "layer:" + doc.id + ":" + (info && info.source ? info.source.id : "?"); }
function checksum(a) { let h = 0; for (let i = 0; i < a.length; i += 7) h = (h * 31 + a[i]) | 0; return h; }

function renderOn(s, p) {
  const res = Core.render({ rgba: s.rgba, w: s.w, h: s.h, pxScale: s.pxScale, sizeBase: s.sizeBase, params: p });
  return Core.composite(res, s.w, s.h, s.original);
}
let previewToken = 0;
async function renderPreview(msg) {
  const img = $("preview"), m = $("previewMsg");
  if (msg || !previewSrc) { img.className = "hidden"; m.className = "preview-msg"; m.textContent = msg || "Dokument öffnen…"; return; }
  const token = ++previewToken, s = previewSrc;
  const rgb = $("previewOriginal").checked ? s.original : renderOn(s, params);
  try {
    const url = await encodeRGB(rgb, s.w, s.h);
    if (token !== previewToken) return;
    img.src = url; img.className = ""; m.className = "hidden";
  } catch (e) { img.className = "hidden"; m.className = "preview-msg"; m.textContent = "Vorschau benötigt Photoshop 24.2 oder neuer."; }
}
async function encodeRGB(rgb, w, h) {
  const d = await imaging.createImageDataFromBuffer(rgb, { width: w, height: h, components: 3, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
  try { return "data:image/jpeg;base64," + await imaging.encodeImageData({ imageData: d, base64: true }); } finally { d.dispose(); }
}
// Look-Galerie mit dem eigenen Motiv
let thumbToken = 0;
async function renderThumbs() {
  const token = ++thumbToken, s = thumbSrc;
  if (!s) return;
  for (const pr of Core.PRESETS) {
    if (token !== thumbToken) return;
    try {
      const url = await encodeRGB(renderOn(s, Object.assign(Core.presetParams(pr.id), { opacity: 100 })), s.w, s.h);
      const tile = document.querySelector(`.look[data-id="${pr.id}"]`);
      if (tile && token === thumbToken) {
        const img = document.createElement("img"); img.src = url;
        tile.replaceChild(img, tile.firstChild);
      }
    } catch (e) { log("Thumb-Fehler", String(e.message || e)); return; }
    await sleep(0);
  }
}

// ---------------------------------------------------------------- Anwenden
async function makePixelLayer(doc, name, buf, w, h, off, mode, opacity) {
  await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name } }], {});
  const layer = doc.activeLayers[0];
  const d = await imaging.createImageDataFromBuffer(fromBuf8(buf, doc), { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
  try { await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: d, targetBounds: { left: off.left, top: off.top } }); }
  finally { d.dispose(); }
  await batchPlay([{ _obj: "set", _target: TARGET, to: { _obj: "layer", mode: { _enum: "blendMode", _value: mode }, opacity: { _unit: "percentUnit", _value: opacity } } }], {});
  return layer.id;
}
// Deckkraft einer Effekt-Ebene. Ganzes Dokument: Gesamt-Deckkraft sitzt an der Gruppe. Ebene: das Original liegt
// in der Gruppe – die Gesamt-Deckkraft sitzt an jeder Effekt-Ebene, das Original bleibt voll sichtbar.
function layerOpacity(p, layerMode) { return layerMode ? p.opacity : 100; }
// Legt die Effekt-Ebenen von unten nach oben über der aktiven Ebene an; jede wird einzeln berechnet (wenig Speicher)
async function makeEffectLayers(doc, o, off, layerMode) {
  const p = Core.sanitize(o.params), made = [], keys = Core.layerKeys(p);
  const ls = Core.lightSources(o, Core.geometry(o));
  for (const def of Core.LAYERS.slice().reverse()) {
    if (keys.indexOf(def.key) < 0) continue;
    const buf = Core.renderLayer(def.key, o, ls);
    if (!buf) continue;
    made.push({ id: await makePixelLayer(doc, def.name, buf, o.w, o.h, off, def.mode(p), layerOpacity(p, layerMode)), def });
  }
  return made;
}
async function deleteDeep(l) { if (l.layers) for (const k of Array.from(l.layers)) await deleteDeep(k); await l.delete(); }
async function deleteDocGroups(doc) { for (const g of docGroups(doc)) await deleteDeep(g); }

async function applyDocument(ctx, doc, p) {
  await deleteDocGroups(doc);
  const b = docBounds(doc);
  if (b.right * b.bottom > MAX_PIXELS) throw new Error(`Dokument zu groß (${Math.round(b.right * b.bottom / 1e6)} MP, maximal ${MAX_PIXELS / 1e6} MP).`);
  const c = await readComposite(ctx, doc, b, null);
  if (doc.layers[0]) await selectLayer(doc.layers[0].id);
  const made = await makeEffectLayers(doc, { rgba: c.rgba, w: c.w, h: c.h, params: p, sizeBase: b.bottom }, { left: 0, top: 0 }, false);
  if (!made.length) throw new Error("Alle Effekte stehen auf 0 – mindestens einen Effekt aufdrehen.");
  await selectLayers(made.map((m) => m.id));
  await batchPlay([{ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, name: GROUP_DOC }], {});
  await batchPlay([{ _obj: "set", _target: TARGET, to: { _obj: "layer", name: GROUP_DOC } }], {});
  // war oben eine (aufgeklappte) Gruppe ausgewählt, landet die neue Gruppe darin – ganz nach oben holen
  const made0 = doc.activeLayers[0];
  if (made0 && made0.parent && doc.layers[0] && doc.layers[0].id !== made0.id) await made0.move(doc.layers[0], constants.ElementPlacement.PLACEBEFORE);
  const g = docGroups(doc)[0];
  if (g) { g.opacity = p.opacity; loadedKey = g.id; }   // Deckkraft per batchPlay auf eine frische Gruppe würde ignoriert
  for (const m of made) await writeXmp(m.id, p, null);
  lastApplied.set("doc:" + doc.id, Object.assign({}, p));
  log("  Dokument", { ebenen: made.map((m) => m.def.name), w: c.w, h: c.h });
}

async function applyLayer(ctx, doc, t, p) {
  const src = t.source;
  if (t.group) for (const k of Array.from(t.group.layers)) if (k.id !== src.id) await deleteDeep(k);
  const sb0 = boundsOf(src);
  if (sb0.right <= sb0.left || sb0.bottom <= sb0.top) throw new Error(`„${src.name}“ ist leer.`);
  const b = layerRegion(doc, src);
  const w = b.right - b.left, h = b.bottom - b.top;
  if (w * h > MAX_PIXELS) throw new Error(`„${src.name}“ ist zu groß.`);
  if (!src.visible) src.visible = true;
  const px = await readLayer(ctx, doc, src, b, true);
  await selectLayer(src.id);
  const made = await makeEffectLayers(doc, { rgba: px.rgba, w, h, params: p, sizeBase: docBounds(doc).bottom }, b, true);
  if (!made.length) throw new Error("Alle Effekte stehen auf 0 – mindestens einen Effekt aufdrehen.");
  let group = t.group;
  if (!group) {
    await selectLayers([src.id].concat(made.map((m) => m.id)));
    await batchPlay([{ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, name: LAYER_PREFIX + src.name }], {});
    group = doc.activeLayers[0];
    await batchPlay([{ _obj: "set", _target: TARGET, to: { _obj: "layer", name: LAYER_PREFIX + src.name } }], {});
  }
  group.opacity = 100;
  for (const m of made) await writeXmp(m.id, p, src.id);
  await selectLayer(group.id);
  lastApplied.set("layer:" + doc.id + ":" + src.id, Object.assign({}, p));
  loadedKey = group.id;
  log("  Ebene", { quelle: src.name, ebenen: made.map((m) => m.def.name), w, h });
  return group;
}


let liveLast = null, livePending = false;
function historyStateId(doc) { try { return doc.activeHistoryState ? doc.activeHistoryState.id : null; } catch (e) { return null; } }
async function idleWithin(ms) { const end = Date.now() + ms; while (busy && Date.now() < end) await sleep(50); return !busy; }

async function applyEffect(live) {
  live = live === true;
  if (busy) {
    if (live) { livePending = true; return; }
    if (!(await idleWithin(6000))) return setStatus("Photoshop ist noch beschäftigt – gleich nochmal versuchen.", true);
  }
  const doc = app.activeDocument;
  if (!doc) return setStatus("Kein Dokument geöffnet.", true);
  if (needsRGB(doc)) return;
  let targets = null;
  if (target === "layers") {
    const r = await resolveTargets(doc);
    targets = r.targets;
    if (!targets.length) return setStatus(r.skipped.length ? "Gruppen und den Hintergrund bitte über „Ganzes Dokument“ bearbeiten." : "Wähle zuerst eine oder mehrere Ebenen aus.", true);
  }
  busy = true;
  setStatus(live ? "Live-Update…" : "Erzeuge Look…");
  const t0 = Date.now();
  let error = null;
  const key = target === "document" ? "doc" : targets.map((t) => t.source.id).join(",");
  const replaceLast = live && liveLast && liveLast.docId === doc.id && liveLast.key === key && liveLast.stateId !== null && liveLast.stateId === historyStateId(doc);
  const p = Core.sanitize(params);
  log(live ? "LIVE" : "ANWENDEN", { ziel: target, ersetzt: !!replaceLast, params: p });
  try {
    await core.executeAsModal(async (ctx) => {
      if (replaceLast) await batchPlay([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }], {});
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: live ? HIST + " Live" : HIST });
      try {
        if (target === "document") await applyDocument(ctx, doc, p);
        else {
          // nach einem Live-Rückschritt sind die Ebenen-Objekte neu – Ziele frisch auflösen
          const list = replaceLast ? (await resolveTargets(doc)).targets : targets;
          const groups = [];
          for (const t of list) groups.push(await applyLayer(ctx, doc, t, p));
          if (groups.length > 1) await selectLayers(groups.map((g) => g.id));
        }
      } catch (e) {
        await ctx.hostControl.resumeHistory(hid, false);   // Fehler: alles zurückrollen, nichts Halbfertiges bleibt liegen
        throw e;
      }
      await ctx.hostControl.resumeHistory(hid);
    }, { commandName: HIST + " anwenden" });
  } catch (e) { error = e.message || String(e); }
  liveLast = live && !error ? { docId: doc.id, key, stateId: historyStateId(doc) } : null;
  log("  Ergebnis", { fehler: error, ms: Date.now() - t0 });
  ignoreEventsUntil = Date.now() + 700;
  busy = false;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (error) setStatus("Fehler: " + error, true);
  else if (!live) setStatus(target === "document" ? `Fertig in ${secs}s – Gruppe „${GROUP_DOC}“ liegt oben. Rückgängig mit ⌘Z.` : `Fertig in ${secs}s – ${targets.length} Ebene(n) in MS-Phase-Gruppen. Entfernen stellt die Originale wieder her.`);
  else setStatus(`Live aktualisiert (${secs}s).`);
  if (livePending && $("liveCanvas").checked) { livePending = false; applyEffect(true); }
}
const debouncedLive = debounce(() => applyEffect(true), 250);

async function removeEffect() {
  if (busy && !(await idleWithin(6000))) return setStatus("Photoshop ist noch beschäftigt – gleich nochmal versuchen.", true);
  const doc = app.activeDocument;
  if (!doc) return setStatus("Kein Dokument geöffnet.", true);
  let list = [];
  if (target === "layers") {
    list = (await resolveTargets(doc)).targets.filter((t) => t.group);
    if (!list.length) return setStatus("Wähle eine MS-Phase-Gruppe (oder eine Ebene darin) aus.", true);
  } else if (!docGroups(doc).length) return setStatus(`Keine Gruppe „${GROUP_DOC}“ im Dokument.`, true);
  busy = true;
  try {
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " entfernen" });
      try {
        if (target === "document") await deleteDocGroups(doc);
        else for (const t of list) await unwrap(t);
      } catch (e) { await ctx.hostControl.resumeHistory(hid, false); throw e; }
      await ctx.hostControl.resumeHistory(hid);
    }, { commandName: HIST + " entfernen" });
    for (const t of list) lastApplied.delete("layer:" + doc.id + ":" + t.source.id);
    if (target === "document") lastApplied.delete("doc:" + doc.id);
    loadedKey = null;
    log("ENTFERNEN", { ziel: target, gruppen: list.length });
    setStatus(target === "document" ? `Gruppe „${GROUP_DOC}“ entfernt.` : `${list.length} Original(e) wiederhergestellt.`);
  } catch (e) { setStatus("Fehler beim Entfernen: " + (e.message || e), true); }
  ignoreEventsUntil = Date.now() + 700;
  busy = false;
}
// Gruppe auflösen: TV-Ebenen löschen, Original sichtbar an derselben Stelle
async function unwrap(t) {
  for (const k of Array.from(t.group.layers)) if (k.id !== t.source.id) await deleteDeep(k);
  await selectLayer(t.group.id);
  await batchPlay([{ _obj: "ungroupLayersEvent", _target: TARGET }], {});
  t.source.visible = true;
  await selectLayer(t.source.id);
}

// ---------------------------------------------------------------- Prüfen
async function readLayerRGBA(doc, layerId, b) {
  const r = await imaging.getPixels({ documentID: doc.id, layerID: layerId, sourceBounds: b, colorSpace: "RGB", componentSize: 8 });
  const d = r.imageData, raw = to8bit(await d.getData({ chunky: true }), d.componentSize || 8);
  const rb = r.sourceBounds || b, W = b.right - b.left, H = b.bottom - b.top, out = new Uint8Array(W * H * 4), c = d.components;
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
    const tx = rb.left - b.left + x, ty = rb.top - b.top + y;
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    const s = (y * d.width + x) * c, o = (ty * W + tx) * 4;
    out[o] = raw[s]; out[o + 1] = raw[s + 1]; out[o + 2] = raw[s + 2]; out[o + 3] = c >= 4 ? raw[s + 3] : 255;
  }
  d.dispose();
  return out;
}
// Anteil (in %) der Pixel, die deutlich abweichen (nur wo der Effekt sichtbar ist)
function pixelDiff(exp, act) {
  let big = 0, n = 0;
  for (let i = 0; i < exp.length; i += 4) {
    const e = Math.max(exp[i], exp[i + 1], exp[i + 2]), a = Math.max(act[i], act[i + 1], act[i + 2]);
    if (e < 6 && a < 6) continue;
    n++;
    if (Math.abs(exp[i] - act[i]) > 32 || Math.abs(exp[i + 1] - act[i + 1]) > 32 || Math.abs(exp[i + 2] - act[i + 2]) > 32) big++;
  }
  return n ? Math.round(big / n * 1000) / 10 : 0;
}
async function checkGroup(doc, g, o, b, sourceId) {
  const fail = [], p = Core.sanitize(o.params), kids = Array.from(g.layers);
  const keys = Core.layerKeys(p), defs = Core.LAYERS.filter((d) => keys.indexOf(d.key) >= 0);
  const names = kids.filter((k) => k.id !== sourceId).map((k) => k.name), want = defs.map((d) => d.name);
  if (JSON.stringify(names) !== JSON.stringify(want)) fail.push(`Ebenen ${names.join("/")} statt ${want.join("/")}`);
  const gOp = sourceId ? 100 : p.opacity;
  if (Math.abs(Number(g.opacity) - gOp) > 1) fail.push(`Gruppen-Deckkraft ${g.opacity} statt ${gOp}`);
  const ls = Core.lightSources(o, Core.geometry(o));
  const diffs = {};
  for (const d of defs) {
    const l = kids.find((k) => k.name === d.name);
    if (!l) continue;
    const mode = String(l.blendMode || "").replace(/^BlendMode\./, "").toLowerCase();
    if (mode !== d.mode(p).toLowerCase()) fail.push(`${d.name}: Mischmodus ${mode} statt ${d.mode(p)}`);
    const op = layerOpacity(p, !!sourceId);
    if (Math.abs(Number(l.opacity) - op) > 1) fail.push(`${d.name}: Deckkraft ${l.opacity} statt ${op}`);
    const diff = pixelDiff(Core.renderLayer(d.key, o, ls), await readLayerRGBA(doc, l.id, b));
    diffs[d.name] = diff;
    if (diff > 1.5) fail.push(`${d.name}: ${diff}% Pixel anders`);
    const saved = await readXmp(l.id);
    if (!saved || JSON.stringify(saved.params) !== JSON.stringify(p)) fail.push(`${d.name}: Einstellungen im XMP fehlen/abweichend`);
    if (sourceId && (!saved || saved.sourceId !== sourceId)) fail.push(`${d.name}: Original-ID im XMP falsch`);
  }
  return { fail, diff: diffs };
}
async function verifyDocument(ctx, doc, p) {
  const r = { fehler: [] }, groups = docGroups(doc);
  if (groups.length !== 1) { r.fehler.push(groups.length ? "mehrere Gruppen" : "Gruppe fehlt"); r.ok = false; return r; }
  if (doc.layers[0].id !== groups[0].id) r.fehler.push("Gruppe nicht ganz oben");
  const b = docBounds(doc), c = await readComposite(ctx, doc, b, null);
  const cg = await checkGroup(doc, groups[0], { rgba: c.rgba, w: c.w, h: c.h, params: p, sizeBase: b.bottom }, b, null);
  r.fehler = r.fehler.concat(cg.fail); r.abweichung = cg.diff; r.ok = !r.fehler.length;
  return r;
}
async function verifyLayerTarget(ctx, doc, t, p) {
  const r = { fehler: [] };
  if (!t.group) { r.fehler.push(`„${t.source.name}“ ist keiner ${HIST}-Gruppe zugeordnet`); r.ok = false; return r; }
  if (!t.source.visible) r.fehler.push("Original ist ausgeblendet");
  if (t.group.name !== LAYER_PREFIX + t.source.name) r.fehler.push(`Gruppenname „${t.group.name}“`);
  const kids = Array.from(t.group.layers);
  if (kids[kids.length - 1].id !== t.source.id) r.fehler.push("Original liegt nicht ganz unten");
  const b = layerRegion(doc, t.source);
  const px = await readLayer(ctx, doc, t.source, b, false);
  const cg = await checkGroup(doc, t.group, { rgba: px.rgba, w: px.w, h: px.h, params: p, sizeBase: docBounds(doc).bottom }, b, t.source.id);
  r.fehler = r.fehler.concat(cg.fail); r.abweichung = cg.diff; r.ok = !r.fehler.length;
  return r;
}

async function verifyNow(doc, p) {
  let r;
  await core.executeAsModal(async (ctx) => {
    if (target === "document") r = await verifyDocument(ctx, doc, p);
    else {
      const list = (await resolveTargets(doc)).targets;
      r = { ok: list.length > 0, fehler: list.length ? [] : ["keine Ebene ausgewählt"], ebenen: [] };
      for (const t of list) { const x = await verifyLayerTarget(ctx, doc, t, p); r.ebenen.push(x); if (!x.ok) { r.ok = false; r.fehler = r.fehler.concat(x.fehler); } }
    }
  }, { commandName: HIST + " prüfen" });
  return r;
}
async function verifyNowUI() {
  if (busy) return;
  const doc = app.activeDocument;
  if (!doc) return setStatus("Kein Dokument geöffnet.", true);
  busy = true;
  let r;
  try { r = await verifyNow(doc, Core.sanitize(params)); } catch (e) { r = { ok: false, fehler: [e.message || String(e)] }; }
  busy = false;
  ignoreEventsUntil = Date.now() + 600;
  log("PRÜFEN", r);
  if (r.ok) setStatus("✓ Das Dokument entspricht den aktuellen Einstellungen.");
  else setStatus("✗ " + r.fehler.join(", ") + " (Details im Log)", true);
}

// ---------------------------------------------------------------- Selbsttest
function testArtwork(w, h) {
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, t = y / h;
    let c = [10 + 20 * t, 8 + 10 * t, 30 + 20 * (1 - t)];
    const dx = x - 260, dy = y - 220, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 120) { const l = Math.max(0, 1 - d / 120); c = [120 + 135 * l, 180 + 75 * l, 230 + 25 * l]; }
    if (x > 560 && x < 780 && y > 140 && y < 300) c = [255, 210, 80];
    for (let k = 0; k < 5; k++) { const lx = 120 + k * 160, ly = 440, dd = Math.hypot(x - lx, y - ly); if (dd < 7) c = [255, 252, 240]; }
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  }
  return buf;
}
let selfTestRunning = false;
async function runSelfTest() {
  if (busy || selfTestRunning) return;
  selfTestRunning = true;
  const saved = Object.assign({}, params), savedTarget = target, wasLive = $("liveCanvas").checked;
  $("liveCanvas").checked = false;
  const results = [], t0 = Date.now();
  let doc = null, artId = null, textId = null;
  const check = async (name, fn) => {
    try { const r = await fn(); results.push({ test: name, ok: !!r.ok, details: r }); }
    catch (e) { results.push({ test: name, ok: false, details: String(e && e.stack || e) }); }
    setStatus(`Selbsttest: ${results.length} – ${name}`);
  };
  log("SELBSTTEST START");
  setStatus("Selbsttest läuft… (1–2 Minuten, bitte nichts anklicken)");
  try {
    await core.executeAsModal(async () => {
      doc = await app.documents.add({ width: 900, height: 520, resolution: 72, mode: "RGBColorMode", fill: "black", name: HIST + " Selbsttest" });
      await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: "Artwork" } }], {});
      const al = doc.activeLayers[0]; artId = al.id;
      const id = await imaging.createImageDataFromBuffer(testArtwork(900, 520), { width: 900, height: 520, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
      await imaging.putPixels({ documentID: doc.id, layerID: al.id, imageData: id, targetBounds: { left: 0, top: 0 } });
      id.dispose();
      await batchPlay([{ _obj: "make", _target: [{ _ref: "textLayer" }], using: { _obj: "textLayer", textKey: "GLOW",
        textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: 55 }, vertical: { _unit: "percentUnit", _value: 75 } },
        textStyleRange: [{ _obj: "textStyleRange", from: 0, to: 4, textStyle: { _obj: "textStyle", size: { _unit: "pointsUnit", _value: 110 }, color: { _obj: "RGBColor", red: 255, grain: 120, blue: 230 } } }] } }], {});
      textId = doc.activeLayers[0].id;
    }, { commandName: HIST + " Selbsttest vorbereiten" });
    const D = Object.assign({}, Core.DEFAULTS);
    const docCase = async (name, over) => check(name, async () => {
      target = "document"; params = Core.sanitize(Object.assign({}, D, over));
      await applyEffect(false);
      if ($("status").className.indexOf("err") >= 0) return { ok: false, status: $("status").textContent };
      return verifyNow(doc, params);
    });
    for (const pr of Core.PRESETS) await docCase(`Look ${pr.name}`, pr.p);
    const only = { amount: 0, halation: 0, diffusion: 0, streaks: 0, stars: 0 };
    await docCase("Nur Glow", Object.assign({}, only, { amount: 100 }));
    await docCase("Nur Halation", Object.assign({}, only, { halation: 90 }));
    await docCase("Nur Diffusion", Object.assign({}, only, { diffusion: 90 }));
    await docCase("Nur Lichtstreifen", Object.assign({}, only, { streaks: 90 }));
    await docCase("Nur Sterne, 6 Strahlen", Object.assign({}, only, { stars: 90, starRays: 6 }));
    await docCase("Sterne, 8 Strahlen gedreht", { stars: 70, starRays: 8, starAngle: 30 });
    await docCase("Glow „Linear abwedeln“", { glowBlend: "linearDodge", amount: 120 });
    await docCase("Eigene Farbe + Prisma", { colorMode: "tint", tint: "#5ab0ff", prism: 90 });
    await docCase("Nur ein Farbbereich", { rangeColor: "#ffd250", rangeWidth: 40, threshold: 20 });
    await docCase("Grenzen: alles voll", { amount: 200, radius: 100, falloff: 0, protect: 100, gamma: 200, saturation: 100, prism: 100, halation: 100, halationRadius: 100, diffusion: 100, diffusionRadius: 100, streaks: 100, streakLength: 100, stars: 100, starLength: 100 });
    await docCase("Grenzen: Schwelle 100, Radius klein", { threshold: 100, radius: 2, falloff: 100, gamma: 50 });
    await docCase("Gesamt-Deckkraft 30", { opacity: 30 });
    await check("Alle Effekte aus: klare Meldung, keine Gruppe", async () => {
      target = "document"; params = Core.sanitize(Object.assign({}, D, only));
      const before = docGroups(doc).length;
      await applyEffect(false);
      const st = $("status").textContent;
      return { ok: st.indexOf("mindestens einen Effekt") >= 0 && docGroups(doc).length === before, st };
    });
    await check("Erneut anwenden ersetzt die Gruppe", async () => {
      params = Core.sanitize(Object.assign({}, D));
      await applyEffect(false); await applyEffect(false);
      return { ok: docGroups(doc).length === 1, gruppen: docGroups(doc).length };
    });
    await check("Live: mehrere Updates = ein Protokollschritt", async () => {
      liveLast = null;
      const s0 = historyStateId(doc);
      params = Core.sanitize(Object.assign({}, D, { amount: 40 })); await applyEffect(true);
      params = Core.sanitize(Object.assign({}, D, { amount: 90, halation: 50 })); await applyEffect(true);
      params = Core.sanitize(Object.assign({}, D, { stars: 60 })); await applyEffect(true);
      const states = doc.historyStates, ai = states.findIndex((st) => st.id === historyStateId(doc));
      const before = ai > 0 ? states[ai - 1].id : null;
      const v = await verifyNow(doc, params);
      return { ok: before === s0 && states[ai].name === HIST + " Live" && v.ok, s0, before, v };
    });
    liveLast = null;
    await check("Gruppe auswählen lädt ihre Einstellungen", async () => {
      const want = Object.assign({}, params);
      params = Object.assign({}, D, { radius: 99 }); loadedKey = null;
      await refreshPreviewSource();
      return { ok: JSON.stringify(params) === JSON.stringify(want), radius: params.radius };
    });
    await check("Entfernen (Dokument) hinterlässt nichts", async () => {
      await removeEffect();
      return { ok: docGroups(doc).length === 0 && doc.layers.length === 3, ebenen: doc.layers.map((l) => l.name) };
    });
    // ---- Ebenen
    const layerCase = async (name, ids, over) => check(name, async () => {
      target = "layers"; params = Core.sanitize(Object.assign({}, D, over));
      await core.executeAsModal(async () => { await selectLayers(ids); }, { commandName: HIST + " Test" });
      await applyEffect(false);
      if ($("status").className.indexOf("err") >= 0) return { ok: false, status: $("status").textContent };
      return verifyNow(doc, params);
    });
    await layerCase("Ebene: Text", [textId], { amount: 120, halation: 40 });
    await layerCase("Ebene: Text erneut (über die Gruppe)", [textId], { amount: 80, stars: 50, streaks: 40 });
    await check("Ebene: genau eine Gruppe, Original sichtbar darin", async () => {
      const gs = doc.layers.filter(isLayerGroup);
      const t = gs[0] && await groupInfo(gs[0]);
      return { ok: gs.length === 1 && !!t && t.source.id === textId && t.source.visible, gruppen: gs.length };
    });
    await check("Ebene: Gesamt-Deckkraft sitzt an den Effekt-Ebenen", async () => {
      target = "layers"; params = Core.sanitize(Object.assign({}, D, { opacity: 40, halation: 50 }));
      await core.executeAsModal(async () => { await selectLayers([textId]); }, { commandName: HIST + " Test" });
      await applyEffect(false);
      const v = await verifyNow(doc, params);
      const g = doc.layers.filter(isLayerGroup)[0], kids = Array.from(g.layers).filter((k) => k.id !== textId);
      return { ok: v.ok && Number(g.opacity) === 100 && kids.every((k) => Math.round(Number(k.opacity)) === 40), v };
    });
    await check("Ebene mit Ebenenmaske: verdeckte Teile leuchten nicht", async () => {
      await core.executeAsModal(async () => {
        await selectLayers([artId]);
        await batchPlay([
          { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _obj: "rectangle", top: { _unit: "pixelsUnit", _value: 0 }, left: { _unit: "pixelsUnit", _value: 0 }, bottom: { _unit: "pixelsUnit", _value: 520 }, right: { _unit: "pixelsUnit", _value: 450 } } },
          { _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } },
          { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } },
        ], {});
      }, { commandName: HIST + " Test Maske" });
      target = "layers"; params = Core.sanitize(Object.assign({}, D, { amount: 100, radius: 10, protect: 0 }));
      await applyEffect(false);
      const v = await verifyNow(doc, params);
      const g = doc.layers.filter(isLayerGroup).find((x) => x.name === LAYER_PREFIX + "Artwork");
      const gl = Array.from(g.layers).find((k) => k.name === "Glow");
      let lit = -1, hidden = -1;
      await core.executeAsModal(async () => {
        const px = await readLayerRGBA(doc, gl.id, { left: 0, top: 0, right: 900, bottom: 520 });
        lit = px[(220 * 900 + 260) * 4 + 1]; hidden = px[(220 * 900 + 680) * 4 + 1];
      }, { commandName: HIST + " Test" });
      return { ok: v.ok && lit > 60 && hidden < 15, lit, hidden, v };
    });
    await layerCase("Zwei Ebenen auf einmal", [artId, textId], { amount: 90, colorMode: "tint", tint: "#9cc4ff" });
    await check("Dokument-Look über Ebenen-Gruppen", async () => {
      target = "document"; params = Core.sanitize(Object.assign({}, D, { diffusion: 40 }));
      await applyEffect(false);
      const v = await verifyNow(doc, params);
      await removeEffect();
      return v;
    });
    await check("Entfernen (Ebenen) stellt die Originale wieder her", async () => {
      target = "layers";
      const gs = doc.layers.filter(isLayerGroup);
      await core.executeAsModal(async () => { await selectLayers(gs.map((g) => g.id)); }, { commandName: HIST + " Test" });
      await removeEffect();
      const ls = allLayers(doc, []);
      const art = ls.find((l) => l.id === artId), txt = ls.find((l) => l.id === textId);
      return { ok: doc.layers.filter(isLayerGroup).length === 0 && !!art && !!txt && art.visible && txt.visible && !isLayerGroup(art.parent) && !isLayerGroup(txt.parent) && doc.layers.length === 3,
        ebenen: doc.layers.map((l) => l.name) };
    });
    await check("Werte prüfen (kaputte Einstellungen)", async () => {
      const s = Core.sanitize({ threshold: "abc", amount: 999, colorMode: "xx", tint: "#fff", starRays: 6, glowBlend: "x" });
      return { ok: s.threshold === Core.DEFAULTS.threshold && s.amount === 200 && s.colorMode === Core.DEFAULTS.colorMode && s.tint === Core.DEFAULTS.tint && s.starRays === 6 && s.glowBlend === Core.DEFAULTS.glowBlend, s };
    });
  } catch (e) {
    results.push({ test: "Abbruch", ok: false, details: String(e && e.stack || e) });
  }
  params = saved; target = savedTarget; saveTarget();
  $("liveCanvas").checked = wasLive;
  syncUI();
  const failed = results.filter((r) => !r.ok);
  log("SELBSTTEST ERGEBNIS", { bestanden: results.length - failed.length, gesamt: results.length, sekunden: Math.round((Date.now() - t0) / 1000) });
  for (const r of results) log((r.ok ? "  ✓ " : "  ✗ ") + r.test, r.ok ? undefined : r.details);
  setStatus(`Selbsttest: ${results.length - failed.length}/${results.length} bestanden` + (failed.length ? ` – fehlgeschlagen: ${failed.map((r) => r.test).join(", ")}` : " ✓"), failed.length > 0);
  selfTestRunning = false;
  previewSrc = null; thumbSrc = null;
  refreshPreviewSource();
}


// ---------------------------------------------------------------- Start
let ignoreEventsUntil = 0;
const onPsEvent = debounce(() => {
  if (busy || selfTestRunning || Date.now() < ignoreEventsUntil) return;
  refreshPreviewSource();
}, 400);

async function init() {
  log("START", { ps: app.version });
  buildSliders();
  buildStatic();
  bindControls();
  syncUI();
  try { action.addNotificationListener(["select", "make", "delete", "open", "close", "set", "move", "transform", "placedLayerEditContents"], onPsEvent); }
  catch (e) { log("Event-Listener nicht verfügbar", String(e)); }
  await refreshPreviewSource();
  // Entwickler-Hook: eine Datei „run-selftest“ im Datenordner startet den Selbsttest (und wird gelöscht)
  setInterval(async () => {
    if (busy || selfTestRunning) return;
    try { const f = await (await lfs.getDataFolder()).getEntry("run-selftest"); await f.delete(); runSelfTest(); } catch (e) { /* kein Auftrag */ }
  }, 3000);
}
init();
