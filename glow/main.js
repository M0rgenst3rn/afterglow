"use strict";
// MS Glow – Photoshop-UXP-Panel.
// Light effects for the whole document or single layers, non-destructive:
//  • Whole document: a group "MS Glow" on top with real layers (glow, halation, diffusion, streaks,
//    stars) that only brighten the artwork. The artwork below stays untouched.
//  • Selected layers: each layer moves into a group "MS Glow · name"; the original stays visible inside,
//    the effect layers above it (layer masks respected). Remove restores everything.
// The settings live in the XMP of the effect layers – selecting the group loads them back into the panel.

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
// effect layer names, including the German names of earlier versions
const RENDER_NAMES = new Set(Core.LAYERS.map((l) => l.name).concat(["Sterne", "Lichtstreifen", "Dunst"]));


// Only the essentials visible: basic glow sliders, one slider per effect; details below in Fine-tuning.
const SLIDERS = [
  { key: "opacity", label: "Opacity", min: 0, max: 100, step: 1, unit: "%", parent: "secStrengthTop" },
  { key: "amount", label: "Amount", min: 0, max: 200, step: 1, unit: "%", parent: "secGlowMain" },
  { key: "radius", label: "Radius", min: 2, max: 100, step: 1, unit: "%", parent: "secGlowMain", tip: "How far the glow reaches" },
  { key: "threshold", label: "Threshold", min: 0, max: 100, step: 1, unit: "%", parent: "secGlowMain", tip: "How bright something must be to glow" },
  { key: "outer", label: "Outside only", min: 0, max: 100, step: 1, unit: "%", parent: "secGlowMain", tip: "No glow on the object itself – it keeps its colours, the light sits only around it" },
  { key: "halation", label: "Halation", min: 0, max: 100, step: 1, unit: "%", parent: "secHalation", tip: "Red-orange fringe around bright edges, like film" },
  { key: "diffusion", label: "Diffusion", min: 0, max: 100, step: 1, unit: "%", parent: "secDiffusion", tip: "Misty soft focus (Pro-Mist)" },
  { key: "haze", label: "Haze", min: 0, max: 100, step: 1, unit: "%", parent: "secHaze", tip: "Wide veil of light, like fog in the air" },
  { key: "hazeRadius", label: "Haze reach", min: 10, max: 100, step: 1, unit: "%", parent: "secHaze", sub: true, show: (p) => p.haze > 0 },
  { key: "streaks", label: "Streaks", min: 0, max: 100, step: 1, unit: "%", parent: "secStreaks", tip: "Anamorphic horizontal streaks on bright points" },
  { key: "streakLength", label: "Length", min: 5, max: 100, step: 1, unit: "%", parent: "secStreaks", sub: true, show: (p) => p.streaks > 0 },
  { key: "stars", label: "Stars", min: 0, max: 100, step: 1, unit: "%", parent: "secStars", tip: "Star filter on single points of light" },
  { key: "starLength", label: "Length", min: 5, max: 100, step: 1, unit: "%", parent: "secStars", sub: true, show: (p) => p.stars > 0 },
  { key: "falloff", label: "Falloff", min: 0, max: 100, step: 1, unit: "%", parent: "secFine", tip: "Low = wide, flat glow; high = tight around the light" },
  { key: "protect", label: "Protect core", min: 0, max: 100, step: 1, unit: "%", parent: "secFine", tip: "Bright areas keep their detail instead of turning white" },
  { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, unit: "", parent: "secFine" },
  { key: "gamma", label: "Gamma", min: 50, max: 200, step: 1, unit: "%", parent: "secFine", tip: "Below 100 % midtones glow too, above only the brightest spots" },
  { key: "prism", label: "Prism", min: 0, max: 100, step: 1, unit: "%", parent: "secFine", tip: "Colour fringes: red reaches further than blue" },
];

let params = loadParams();
let target = loadTarget();         // "document" | "layers"
let previewSrc = null;
let thumbSrc = null;
let previewMode = "fit";
let busy = false;
let activeLook = null;
const ctl = {};
const lastApplied = new Map();     // target key -> params (for the "not applied yet" hint)
let loadedKey = null;              // group whose settings were last loaded into the panel

// ---------------------------------------------------------------- Persistence
function loadParams() { try { return Core.sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch (e) { return Object.assign({}, Core.DEFAULTS); } }
function saveParams() { try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch (e) { /* egal */ } }
function loadTarget() { try { return localStorage.getItem(TARGET_KEY) === "layers" ? "layers" : "document"; } catch (e) { return "document"; } }
function saveTarget() { try { localStorage.setItem(TARGET_KEY, target); } catch (e) { /* egal */ } }
function loadUserPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || "{}"); } catch (e) { return {}; } }
function saveUserPresets(p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch (e) { /* egal */ } }

// ---------------------------------------------------------------- Helpers
function setStatus(msg, isErr) { const el = $("status"); el.textContent = msg || ""; el.className = isErr ? "status err" : "status"; }
function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hexToRgb(hex) { const n = parseInt(String(hex).slice(1), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
function rgbToHex(r, g, b) { return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); }
function docBounds(doc) { return { left: 0, top: 0, right: Math.round(Number(doc.width)), bottom: Math.round(Number(doc.height)) }; }
function boundsOf(layer) { const b = layer.boundsNoEffects || layer.bounds; return { left: Math.floor(b.left), top: Math.floor(b.top), right: Math.ceil(b.right), bottom: Math.ceil(b.bottom) }; }
// Area of a layer: the whole document – the light reaches far beyond the object
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
  if (buf instanceof Uint8ClampedArray) buf = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);   // Photoshop only takes Uint8/Uint16/Float32
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
  setStatus(HIST + " needs an RGB document – Image › Mode › RGB Color.", true);
  return true;
}

// ---------------------------------------------------------------- Log
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

// ---------------------------------------------------------------- XMP (settings on the effect layers)
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
  if (!source) source = kids.slice().reverse().find((k) => !RENDER_NAMES.has(k.name)) || null;   // older/foreign groups
  return { group, source, signal, saved };
}

// Layer targets: selected layers; an effect group (or a layer inside it) stands for its original
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

// ---------------------------------------------------------------- Reading pixels
// Document WITHOUT the effect's document group. hide/show: briefly hide/show more layers (history is
// rolled back). inHistory: already runs inside its own history step – then hide/show nothing
// that isn't replaced afterwards anyway.
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
// Pixels of a layer at full resolution over sourceBounds – including the layer mask (cut-out objects).
// A hidden original is shown briefly. inHistory: already runs inside its own history step.
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
    // getPixels only returns the occupied area – place it on the requested region
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
        // outside the returned mask its edge value applies
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
// Downsamples an RGBA image (box average, alpha-weighted) to a grid of ps source pixels per pixel
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

// ---------------------------------------------------------------- Own controls
// Deliberately no Photoshop widgets (sp-slider, native checkboxes/selects, Photoshop colour picker):
// own sliders, switches, segments and a colour popover in the Morgenstern design.

// Slider: name and value on top, a thin track with a glowing fill below.
// Drag, click the track, arrow keys (Shift = ×10), double-click = default, or type the value.
function makeSlider(s) {
  const row = document.createElement("div");
  row.className = "sl";
  if (s.tip) row.title = s.tip;
  row.innerHTML = `<div class="sl-head"><span class="sl-label">${s.label}</span><span class="sl-val"><input class="sl-num" type="text"><span class="sl-unit">${s.unit}</span></span></div>` +
    `<div class="sl-track" tabindex="0"><div class="sl-rail"></div><div class="sl-fill"></div><div class="sl-thumb"></div></div>`;
  $(s.parent).appendChild(row);
  const track = row.querySelector(".sl-track"), fill = row.querySelector(".sl-fill"), thumb = row.querySelector(".sl-thumb"), num = row.querySelector(".sl-num");
  const span = s.max - s.min, zero = Math.max(s.min, Math.min(s.max, 0));
  const snap = (v) => { v = Math.round((v - s.min) / s.step) * s.step + s.min; return Math.max(s.min, Math.min(s.max, +v.toFixed(4))); };
  const show = (v) => {
    const t = (v - s.min) / span, z = (zero - s.min) / span;
    fill.style.left = (Math.min(t, z) * 100) + "%";
    fill.style.width = (Math.abs(t - z) * 100) + "%";
    thumb.style.left = (t * 100) + "%";
    if (document.activeElement !== num) num.value = String(v);
  };
  const commit = (v) => { v = snap(v); if (params[s.key] === v) return; params[s.key] = v; show(v); activeLook = null; changed(); };
  const fromX = (clientX) => { const r = track.getBoundingClientRect(); return s.min + Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * span; };
  let drag = false;
  const move = (e) => { if (drag) commit(fromX(e.clientX)); };
  const up = () => { if (!drag) return; drag = false; row.className = row.className.replace(" dragging", ""); syncUI(); };
  track.addEventListener("mousedown", (e) => { drag = true; row.className += " dragging"; commit(fromX(e.clientX)); });
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
  track.addEventListener("dblclick", () => { commit(Core.DEFAULTS[s.key] !== undefined ? Core.DEFAULTS[s.key] : s.min); syncUI(); });
  track.addEventListener("keydown", (e) => {
    const k = e.key, st = s.step * (e.shiftKey ? 10 : 1);
    if (k === "ArrowRight" || k === "ArrowUp") { commit(params[s.key] + st); syncUI(); e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "ArrowDown") { commit(params[s.key] - st); syncUI(); e.preventDefault(); }
  });
  num.addEventListener("change", () => {
    let v = parseFloat(String(num.value).replace(",", "."));
    if (isNaN(v)) v = params[s.key];
    commit(v); syncUI();
  });
  ctl[s.key] = { row, def: s, set: show };
}
function buildSliders() { for (const s of SLIDERS) makeSlider(s); }

// Switches that drive a (hidden) checkbox – so ".checked" keeps working for the logic
function bindSwitch(id) {
  const input = $(id), sw = document.querySelector(`.switch[data-for="${id}"]`);
  sw.addEventListener("click", () => { input.checked = !input.checked; input.dispatchEvent(new Event("change")); syncSwitches(); });
}
function syncSwitches() {
  document.querySelectorAll(".switch").forEach((sw) => {
    const on = $(sw.dataset.for).checked;
    sw.className = "switch" + (on ? " on" : "") + (sw.dataset.kind ? " " + sw.dataset.kind : "");
  });
}
// Segmented control for a choice (replaces dropdowns)
function buildSeg(id, options, key, toValue) {
  $(id).innerHTML = options.map((o) => `<div class="seg-btn" data-v="${o.id}">${o.name}</div>`).join("");
  $(id).querySelectorAll(".seg-btn").forEach((el) => el.addEventListener("click", () => { params[key] = toValue ? toValue(el.dataset.v) : el.dataset.v; activeLook = null; syncUI(); changed(); }));
}
function syncSeg(id, value) { $(id).querySelectorAll(".seg-btn").forEach((el) => { el.className = el.dataset.v === String(value) ? "seg-btn active" : "seg-btn"; }); }

function buildStatic() {
  buildSeg("blendSeg", Core.BLENDS.map((b) => ({ id: b.id, name: b.id === "screen" ? "Soft" : "Strong" })), "glowBlend");
  buildSeg("raysSeg", Core.RAYS.map((n) => ({ id: String(n), name: String(n) })), "starRays", Number);
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
// own presets as a list: click loads, × deletes
function rebuildPresetSelect() {
  const user = loadUserPresets(), names = Object.keys(user), box = $("presetList");
  box.innerHTML = names.length ? names.map((n) => `<div class="preset" data-n="${esc(n)}"><span class="preset-name">${esc(n)}</span><span class="preset-del" title="Delete">×</span></div>`).join("")
    : `<div class="empty">No presets yet – set up a look and save it.</div>`;
  box.querySelectorAll(".preset").forEach((el) => {
    const n = el.dataset.n;
    el.querySelector(".preset-name").addEventListener("click", () => { params = Core.sanitize(loadUserPresets()[n]); activeLook = null; syncUI(); changed(); setStatus(`Preset "${n}" loaded.`); });
    el.querySelector(".preset-del").addEventListener("click", () => { const u = loadUserPresets(); delete u[n]; saveUserPresets(u); rebuildPresetSelect(); setStatus(`Preset "${n}" deleted.`); });
  });
}
function applyLook(id) {
  const pr = Core.presetParams(id);
  if (!pr) return;
  params = Object.assign(pr, { opacity: params.opacity });
  activeLook = id;
  syncUI(); changed();
  setStatus(`Look "${Core.PRESETS.find((x) => x.id === id).name}" – every slider stays adjustable.`);
}

// Colours: own popover with curated colours and hex input; Photoshop's colour picker only on request
const COLOR_FIELDS = [["tint", "tint"], ["streakColor", "streakColor"], ["hazeColor", "hazeColor"]];
const PALETTE = ["#ffffff", "#ffe9c7", "#ffcf9a", "#ffb060", "#ff8a3d", "#ff5a2a", "#ff3f6e", "#ff3fa4",
  "#d24dff", "#9a5cff", "#6a5cff", "#3d6bff", "#2a8cff", "#3fd4ff", "#2fe0c8", "#2fb8b0",
  "#39ff7a", "#a6ff4d", "#ffe14d", "#9cc4ff", "#c8d8ff", "#7a86a3"];
let popKey = null;
function openColorPop(key, anchor) {
  const pop = $("colorPop");
  if (popKey === key && pop.className.indexOf("hidden") < 0) return closeColorPop();
  popKey = key;
  pop.innerHTML = `<div class="pal">${PALETTE.map((c) => `<div class="pal-c${c === params[key] ? " on" : ""}" data-c="${c}" style="background-color:${c}"></div>`).join("")}</div>` +
    `<div class="pop-row"><input type="text" class="hex" id="popHex" maxlength="7" value="${params[key]}"><div class="btn small ghost" id="popExact">Pick exactly…</div><div class="btn small" id="popDone">Done</div></div>`;
  anchor.parentNode.insertBefore(pop, anchor.nextSibling);
  pop.className = "color-pop";
  const set = (c) => { params[key] = c; activeLook = null; syncUI(); changed(); pop.querySelectorAll(".pal-c").forEach((el) => { el.className = el.dataset.c === c ? "pal-c on" : "pal-c"; }); $("popHex").value = c; };
  pop.querySelectorAll(".pal-c").forEach((el) => el.addEventListener("click", () => set(el.dataset.c)));
  $("popHex").addEventListener("change", (e) => { let v = String(e.target.value).trim(); if (v[0] !== "#") v = "#" + v; if (/^#[0-9a-f]{6}$/i.test(v)) set(v.toLowerCase()); });
  $("popExact").addEventListener("click", () => pickColor(key));
  $("popDone").addEventListener("click", closeColorPop);
}
// The popover opens below the swatch's whole row, not inside it
function popAnchor(id) {
  let el = $("swatch-" + id);
  while (el && !/\b(field|row)\b/.test(el.className)) el = el.parentNode;
  return el;
}
function closeColorPop() { popKey = null; $("colorPop").className = "color-pop hidden"; }

function syncUI() {
  for (const key of Object.keys(ctl)) {
    const c = ctl[key];
    c.set(params[key]);
    c.row.className = "sl" + (c.def.sub ? " sub" : "") + (c.def.show && !c.def.show(params) ? " hidden" : "");
  }
  document.querySelectorAll("#colorSeg .seg-btn").forEach((el) => { el.className = el.dataset.color === params.colorMode ? "seg-btn active" : "seg-btn"; });
  document.querySelectorAll("#targetSeg .seg-btn").forEach((el) => { el.className = el.dataset.target === target ? "seg-btn active" : "seg-btn"; });
  document.querySelectorAll("#previewModeSeg .seg-btn").forEach((el) => { el.className = el.dataset.mode === previewMode ? "seg-btn active" : "seg-btn"; });
  document.querySelectorAll(".look").forEach((el) => { el.className = el.dataset.id === activeLook ? "look active" : "look"; });
  $("lookName").textContent = activeLook ? Core.PRESETS.find((x) => x.id === activeLook).name : "";
  $("tintRow").className = params.colorMode === "tint" ? "swatch-wrap" : "swatch-wrap hidden";
  $("streakColorRow").className = params.streaks > 0 ? "row sub" : "row sub hidden";
  $("starRaysRow").className = params.stars > 0 ? "row sub" : "row sub hidden";
  $("hazeColorRow").className = params.haze > 0 ? "row sub" : "row sub hidden";
  for (const [id, key] of COLOR_FIELDS) { $("swatch-" + id).style.backgroundColor = params[key]; $("hexl-" + id).textContent = params[key]; }
  syncSeg("blendSeg", params.glowBlend);
  syncSeg("raysSeg", params.starRays);
  syncSwitches();
  $("apply").textContent = target === "document" ? "Apply" : "Apply to layer";
}

// Collapsible sections; the panel remembers what was open
const SEC_KEY = "msglow.sections.v1";
const SEC_DEFAULT = { looks: true, glow: true, effects: true, fine: false, more: false };
function buildSections() {
  let open = {};
  try { open = Object.assign({}, SEC_DEFAULT, JSON.parse(localStorage.getItem(SEC_KEY) || "{}")); } catch (e) { open = Object.assign({}, SEC_DEFAULT); }
  document.querySelectorAll(".sec").forEach((sec) => {
    const name = sec.dataset.sec, head = sec.querySelector(".sec-head");
    const apply = () => { sec.className = open[name] ? "sec open" : "sec"; };
    head.addEventListener("click", () => { open[name] = !open[name]; apply(); try { localStorage.setItem(SEC_KEY, JSON.stringify(open)); } catch (e) { /* egal */ } });
    apply();
  });
}
function bindControls() {
  bindSwitch("liveCanvas");
  bindSwitch("previewOriginal");
  document.querySelectorAll("#colorSeg .seg-btn").forEach((el) => el.addEventListener("click", () => { params.colorMode = el.dataset.color; activeLook = null; syncUI(); changed(); }));
  document.querySelectorAll("#targetSeg .seg-btn").forEach((el) => el.addEventListener("click", () => {
    target = el.dataset.target; saveTarget(); loadedKey = null; previewSrc = null; thumbSrc = null; syncUI(); refreshPreviewSource();
  }));
  document.querySelectorAll("#previewModeSeg .seg-btn").forEach((el) => el.addEventListener("click", () => { previewMode = el.dataset.mode; syncUI(); refreshPreviewSource(); }));
  for (const [id, key] of COLOR_FIELDS) $("swatch-" + id).addEventListener("click", () => openColorPop(key, popAnchor(id)));
  $("previewOriginal").addEventListener("change", () => renderPreview());
  $("refreshPreview").addEventListener("click", () => { previewSrc = null; refreshPreviewSource(); });
  $("presetSave").addEventListener("click", () => {
    const name = String($("presetName").value || "").trim();
    if (!name) return setStatus("Give the preset a name first.", true);
    const user = loadUserPresets(); user[name] = Object.assign({}, params); saveUserPresets(user);
    rebuildPresetSelect(); $("presetName").value = "";
    setStatus(`Preset "${name}" saved.`);
  });
  $("resetAll").addEventListener("click", () => { params = Object.assign({}, Core.DEFAULTS); activeLook = Core.PRESETS[0].id; syncUI(); changed(); });
  $("liveCanvas").addEventListener("change", (e) => {
    liveLast = null;
    if (e.target.checked) applyEffect(true);
    else setStatus("Live off – the current state stays in the document.");
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
    }, { commandName: "Pick colour" });
    const c = res && res[0] && (res[0].RGBFloatColor || res[0].color);
    if (c && c.red !== undefined) { params[key] = rgbToHex(c.red, c.grain !== undefined ? c.grain : c.green, c.blue); activeLook = null; syncUI(); changed(); if (popKey === key) { popKey = null; openColorPop(key, popAnchor(key)); } }
  } catch (e) { setStatus("Colour picker not available – type a hex value.", true); }
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
  if (diff.length) setStatus(`● Not in the document yet – click "${$("apply").textContent}" or turn on Live.`);
  else setStatus("Document matches the settings.");
}

// ---------------------------------------------------------------- Preview
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
  if (!doc) { previewSrc = null; showTarget(null); return renderPreview("No document open."); }
  const dB = docBounds(doc), dw = dB.right, dh = dB.bottom;
  let info = null;
  if (target === "document") {
    const g = docGroups(doc)[0];
    if (g) info = await groupInfo(g);
    showTarget(doc.name || "Document");
  } else {
    const r = await resolveTargets(doc);
    if (!r.targets.length) {
      previewSrc = null; showTarget(null);
      return renderPreview(r.skipped.length ? "Edit groups and the background with \"Whole document\"." : "Select a layer in the Layers panel (image, text, shape)…");
    }
    info = r.targets[0];
    showTarget(info.source.name + (r.targets.length > 1 ? ` (+${r.targets.length - 1} weitere)` : ""));
  }
  // Take over the settings of an existing group (only when the group changes – open edits stay)
  if (info && info.group && info.saved) {
    if (loadedKey !== info.group.id) {
      loadedKey = info.group.id;
      params = Core.sanitize(info.saved.params); activeLook = null;
      lastApplied.set(targetKey(doc, info), Object.assign({}, params));
      saveParams(); syncUI();
      setStatus(`Settings loaded from "${info.group.name}".`);
    }
  } else loadedKey = null;
  // Target area: document or the layer; the preview always shows the document
  const lb = dB;   // light reaches beyond the object: always the whole document
  const fw = lb.right - lb.left, fh = lb.bottom - lb.top;
  const ob = target === "document" ? dB : boundsOf(info.source);
  if (fw <= 0 || fh <= 0 || ob.right <= ob.left || ob.bottom <= ob.top) { previewSrc = null; return renderPreview("The layer is empty."); }
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
      // in layer mode: document with the original, but without this object's old effect layers
      const opt = target === "layers" && info.group ? { hide: Array.from(info.group.layers).filter((k) => k.id !== info.source.id), show: [info.source] } : {};
      pv = await readComposite(ctx, doc, view, ts, opt);
      th = await readComposite(ctx, doc, dB, tts, opt);
      if (target === "layers") lay = await readLayer(ctx, doc, info.source, lb, false);
    }, { commandName: HIST + " preview" });
    ignoreEventsUntil = Date.now() + 600;
    const mk = (c, v, ps) => {
      const n = c.w * c.h, original = rgbOf(c.rgba, n, null);
      const s = { w: c.w, h: c.h, pxScale: ps, sizeBase: dh, original, layerMode: target === "layers" };
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
    renderPreview("Preview not possible: " + (e.message || e));
  }
}
// shows below the preview what is being edited
function showTarget(name) {
  $("targetName").textContent = name ? (target === "document" ? "Whole document" : "Layer: " + name) : "–";
  $("targetInfo").innerHTML = target === "document"
    ? `Editing: <b>the whole document</b>${name ? " · " + esc(name) : ""}`
    : name ? `Editing only: <b>${esc(name)}</b>` : `Editing only: <b>the selected layer</b> – please select one`;
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function targetKey(doc, info) { return target === "document" ? "doc:" + doc.id : "layer:" + doc.id + ":" + (info && info.source ? info.source.id : "?"); }
function checksum(a) { let h = 0; for (let i = 0; i < a.length; i += 7) h = (h * 31 + a[i]) | 0; return h; }

function renderOn(s, p) {
  const res = Core.render({ rgba: s.rgba, w: s.w, h: s.h, pxScale: s.pxScale, sizeBase: s.sizeBase, layerMode: s.layerMode, params: p });
  return Core.composite(res, s.w, s.h, s.original);
}
let previewToken = 0;
async function renderPreview(msg) {
  const img = $("preview"), m = $("previewMsg");
  if (msg || !previewSrc) { img.className = "hidden"; m.className = "preview-msg"; m.textContent = msg || "Open a document…"; return; }
  const token = ++previewToken, s = previewSrc;
  const rgb = $("previewOriginal").checked ? s.original : renderOn(s, params);
  try {
    const url = await encodeRGB(rgb, s.w, s.h);
    if (token !== previewToken) return;
    img.src = url; img.className = ""; m.className = "hidden";
  } catch (e) { img.className = "hidden"; m.className = "preview-msg"; m.textContent = "The preview needs Photoshop 24.2 or newer."; }
}
async function encodeRGB(rgb, w, h) {
  const d = await imaging.createImageDataFromBuffer(rgb, { width: w, height: h, components: 3, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
  try { return "data:image/jpeg;base64," + await imaging.encodeImageData({ imageData: d, base64: true }); } finally { d.dispose(); }
}
// Look gallery with your own image
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
    } catch (e) { log("thumb error", String(e.message || e)); return; }
    await sleep(0);
  }
}

// ---------------------------------------------------------------- Apply
async function makePixelLayer(doc, name, buf, w, h, off, mode, opacity) {
  await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name } }], {});
  const layer = doc.activeLayers[0];
  const d = await imaging.createImageDataFromBuffer(fromBuf8(buf, doc), { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
  try { await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: d, targetBounds: { left: off.left, top: off.top } }); }
  finally { d.dispose(); }
  await batchPlay([{ _obj: "set", _target: TARGET, to: { _obj: "layer", mode: { _enum: "blendMode", _value: mode }, opacity: { _unit: "percentUnit", _value: opacity } } }], {});
  return layer.id;
}
// Opacity of an effect layer. Whole document: the overall opacity sits on the group. Layer: the original lies
// in the group – the overall opacity sits on every effect layer, the original stays fully visible.
function layerOpacity(p, layerMode) { return layerMode ? p.opacity : 100; }
// Creates the effect layers bottom to top above the active layer; each is computed on its own (little memory)
async function makeEffectLayers(doc, o, off, layerMode) {
  o.layerMode = layerMode;
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
  if (b.right * b.bottom > MAX_PIXELS) throw new Error(`Document too large (${Math.round(b.right * b.bottom / 1e6)} MP, maximum ${MAX_PIXELS / 1e6} MP).`);
  const c = await readComposite(ctx, doc, b, null);
  if (doc.layers[0]) await selectLayer(doc.layers[0].id);
  const made = await makeEffectLayers(doc, { rgba: c.rgba, w: c.w, h: c.h, params: p, sizeBase: b.bottom }, { left: 0, top: 0 }, false);
  if (!made.length) throw new Error("All effects are at 0 – turn up at least one effect.");
  await selectLayers(made.map((m) => m.id));
  await batchPlay([{ _obj: "make", _target: [{ _ref: "layerSection" }], from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, name: GROUP_DOC }], {});
  await batchPlay([{ _obj: "set", _target: TARGET, to: { _obj: "layer", name: GROUP_DOC } }], {});
  // if an (expanded) group was selected on top, the new group lands inside it – move it to the very top
  const made0 = doc.activeLayers[0];
  if (made0 && made0.parent && doc.layers[0] && doc.layers[0].id !== made0.id) await made0.move(doc.layers[0], constants.ElementPlacement.PLACEBEFORE);
  const g = docGroups(doc)[0];
  if (g) { g.opacity = p.opacity; loadedKey = g.id; }   // opacity via batchPlay on a fresh group would be ignored
  for (const m of made) await writeXmp(m.id, p, null);
  lastApplied.set("doc:" + doc.id, Object.assign({}, p));
  log("  document", { layers: made.map((m) => m.def.name), w: c.w, h: c.h });
}

async function applyLayer(ctx, doc, t, p) {
  const src = t.source;
  if (t.group) for (const k of Array.from(t.group.layers)) if (k.id !== src.id) await deleteDeep(k);
  const sb0 = boundsOf(src);
  if (sb0.right <= sb0.left || sb0.bottom <= sb0.top) throw new Error(`"${src.name}" is empty.`);
  const b = layerRegion(doc, src);
  const w = b.right - b.left, h = b.bottom - b.top;
  if (w * h > MAX_PIXELS) throw new Error(`"${src.name}" is too large.`);
  if (!src.visible) src.visible = true;
  const px = await readLayer(ctx, doc, src, b, true);
  await selectLayer(src.id);
  const made = await makeEffectLayers(doc, { rgba: px.rgba, w, h, params: p, sizeBase: docBounds(doc).bottom }, b, true);
  if (!made.length) throw new Error("All effects are at 0 – turn up at least one effect.");
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
  log("  layer", { source: src.name, layers: made.map((m) => m.def.name), w, h });
  return group;
}


let liveLast = null, livePending = false;
function historyStateId(doc) { try { return doc.activeHistoryState ? doc.activeHistoryState.id : null; } catch (e) { return null; } }
async function idleWithin(ms) { const end = Date.now() + ms; while (busy && Date.now() < end) await sleep(50); return !busy; }

async function applyEffect(live) {
  live = live === true;
  if (busy) {
    if (live) { livePending = true; return; }
    if (!(await idleWithin(6000))) return setStatus("Photoshop is still busy – try again in a moment.", true);
  }
  const doc = app.activeDocument;
  if (!doc) return setStatus("No document open.", true);
  if (needsRGB(doc)) return;
  let targets = null;
  if (target === "layers") {
    const r = await resolveTargets(doc);
    targets = r.targets;
    if (!targets.length) return setStatus(r.skipped.length ? "Edit groups and the background with \"Whole document\"." : "Select one or more layers first.", true);
  }
  busy = true;
  setStatus(live ? "Live-Update…" : "Erzeuge Look…");
  const t0 = Date.now();
  let error = null;
  const key = target === "document" ? "doc" : targets.map((t) => t.source.id).join(",");
  const replaceLast = live && liveLast && liveLast.docId === doc.id && liveLast.key === key && liveLast.stateId !== null && liveLast.stateId === historyStateId(doc);
  const p = Core.sanitize(params);
  log(live ? "LIVE" : "APPLY", { target: target, replaced: !!replaceLast, params: p });
  try {
    await core.executeAsModal(async (ctx) => {
      if (replaceLast) await batchPlay([{ _obj: "select", _target: [{ _ref: "historyState", _enum: "ordinal", _value: "previous" }] }], {});
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: live ? HIST + " Live" : HIST });
      try {
        if (target === "document") await applyDocument(ctx, doc, p);
        else {
          // after a Live undo the layer objects are new – resolve the targets again
          const list = replaceLast ? (await resolveTargets(doc)).targets : targets;
          const groups = [];
          for (const t of list) groups.push(await applyLayer(ctx, doc, t, p));
          if (groups.length > 1) await selectLayers(groups.map((g) => g.id));
        }
      } catch (e) {
        await ctx.hostControl.resumeHistory(hid, false);   // error: roll everything back, nothing half-done stays behind
        throw e;
      }
      await ctx.hostControl.resumeHistory(hid);
    }, { commandName: HIST + " apply" });
  } catch (e) { error = e.message || String(e); }
  liveLast = live && !error ? { docId: doc.id, key, stateId: historyStateId(doc) } : null;
  log("  result", { error, ms: Date.now() - t0 });
  ignoreEventsUntil = Date.now() + 700;
  busy = false;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (error) setStatus("Error: " + error, true);
  else if (!live) setStatus(target === "document" ? `Done in ${secs}s – group "${GROUP_DOC}" is on top. Undo with ⌘Z.` : `Done in ${secs}s – ${targets.length} layer(s) in ${HIST} groups. Remove restores the originals.`);
  else setStatus(`Live updated (${secs}s).`);
  if (livePending && $("liveCanvas").checked) { livePending = false; applyEffect(true); }
}
const debouncedLive = debounce(() => applyEffect(true), 250);

async function removeEffect() {
  if (busy && !(await idleWithin(6000))) return setStatus("Photoshop is still busy – try again in a moment.", true);
  const doc = app.activeDocument;
  if (!doc) return setStatus("No document open.", true);
  let list = [];
  if (target === "layers") {
    list = (await resolveTargets(doc)).targets.filter((t) => t.group);
    if (!list.length) return setStatus(`Select a ${HIST} group (or a layer inside it).`, true);
  } else if (!docGroups(doc).length) return setStatus(`No group "${GROUP_DOC}" in the document.`, true);
  busy = true;
  try {
    await core.executeAsModal(async (ctx) => {
      const hid = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: HIST + " remove" });
      try {
        if (target === "document") await deleteDocGroups(doc);
        else for (const t of list) await unwrap(t);
      } catch (e) { await ctx.hostControl.resumeHistory(hid, false); throw e; }
      await ctx.hostControl.resumeHistory(hid);
    }, { commandName: HIST + " remove" });
    for (const t of list) lastApplied.delete("layer:" + doc.id + ":" + t.source.id);
    if (target === "document") lastApplied.delete("doc:" + doc.id);
    loadedKey = null;
    log("REMOVE", { target: target, groups: list.length });
    setStatus(target === "document" ? `Group "${GROUP_DOC}" removed.` : `${list.length} original(s) restored.`);
  } catch (e) { setStatus("Error while removing: " + (e.message || e), true); }
  ignoreEventsUntil = Date.now() + 700;
  busy = false;
}
// Dissolve the group: delete the effect layers, original visible in the same place
async function unwrap(t) {
  for (const k of Array.from(t.group.layers)) if (k.id !== t.source.id) await deleteDeep(k);
  await selectLayer(t.group.id);
  await batchPlay([{ _obj: "ungroupLayersEvent", _target: TARGET }], {});
  t.source.visible = true;
  await selectLayer(t.source.id);
}

// ---------------------------------------------------------------- Verify
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
// Share (in %) of pixels that differ clearly (only where the effect is visible)
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
  if (JSON.stringify(names) !== JSON.stringify(want)) fail.push(`layers ${names.join("/")} instead of ${want.join("/")}`);
  const gOp = sourceId ? 100 : p.opacity;
  if (Math.abs(Number(g.opacity) - gOp) > 1) fail.push(`group opacity ${g.opacity} instead of ${gOp}`);
  const ls = Core.lightSources(o, Core.geometry(o));
  const diffs = {};
  for (const d of defs) {
    const l = kids.find((k) => k.name === d.name);
    if (!l) continue;
    const mode = String(l.blendMode || "").replace(/^BlendMode\./, "").toLowerCase();
    if (mode !== d.mode(p).toLowerCase()) fail.push(`${d.name}: blend mode ${mode} instead of ${d.mode(p)}`);
    const op = layerOpacity(p, !!sourceId);
    if (Math.abs(Number(l.opacity) - op) > 1) fail.push(`${d.name}: opacity ${l.opacity} instead of ${op}`);
    const diff = pixelDiff(Core.renderLayer(d.key, o, ls), await readLayerRGBA(doc, l.id, b));
    diffs[d.name] = diff;
    if (diff > 1.5) fail.push(`${d.name}: ${diff}% Pixel anders`);
    const saved = await readXmp(l.id);
    if (!saved || JSON.stringify(saved.params) !== JSON.stringify(p)) fail.push(`${d.name}: settings in XMP missing/different`);
    if (sourceId && (!saved || saved.sourceId !== sourceId)) fail.push(`${d.name}: original ID in XMP wrong`);
  }
  return { fail, diff: diffs };
}
async function verifyDocument(ctx, doc, p) {
  const r = { errors: [] }, groups = docGroups(doc);
  if (groups.length !== 1) { r.errors.push(groups.length ? "several groups" : "group missing"); r.ok = false; return r; }
  if (doc.layers[0].id !== groups[0].id) r.errors.push("group not on top");
  const b = docBounds(doc), c = await readComposite(ctx, doc, b, null);
  const cg = await checkGroup(doc, groups[0], { rgba: c.rgba, w: c.w, h: c.h, params: p, sizeBase: b.bottom }, b, null);
  r.errors = r.errors.concat(cg.fail); r.deviation = cg.diff; r.ok = !r.errors.length;
  return r;
}
async function verifyLayerTarget(ctx, doc, t, p) {
  const r = { errors: [] };
  if (!t.group) { r.errors.push(`"${t.source.name}" belongs to no ${HIST} group`); r.ok = false; return r; }
  if (!t.source.visible) r.errors.push("original is hidden");
  if (t.group.name !== LAYER_PREFIX + t.source.name) r.errors.push(`group name "${t.group.name}"`);
  const kids = Array.from(t.group.layers);
  if (kids[kids.length - 1].id !== t.source.id) r.errors.push("original is not at the bottom");
  const b = layerRegion(doc, t.source);
  const px = await readLayer(ctx, doc, t.source, b, false);
  const cg = await checkGroup(doc, t.group, { rgba: px.rgba, w: px.w, h: px.h, params: p, sizeBase: docBounds(doc).bottom, layerMode: true }, b, t.source.id);
  r.errors = r.errors.concat(cg.fail); r.deviation = cg.diff; r.ok = !r.errors.length;
  return r;
}

async function verifyNow(doc, p) {
  let r;
  await core.executeAsModal(async (ctx) => {
    if (target === "document") r = await verifyDocument(ctx, doc, p);
    else {
      const list = (await resolveTargets(doc)).targets;
      r = { ok: list.length > 0, errors: list.length ? [] : ["no layer selected"], layers: [] };
      for (const t of list) { const x = await verifyLayerTarget(ctx, doc, t, p); r.layers.push(x); if (!x.ok) { r.ok = false; r.errors = r.errors.concat(x.errors); } }
    }
  }, { commandName: HIST + " verify" });
  return r;
}
async function verifyNowUI() {
  if (busy) return;
  const doc = app.activeDocument;
  if (!doc) return setStatus("No document open.", true);
  busy = true;
  let r;
  try { r = await verifyNow(doc, Core.sanitize(params)); } catch (e) { r = { ok: false, errors: [e.message || String(e)] }; }
  busy = false;
  ignoreEventsUntil = Date.now() + 600;
  log("VERIFY", r);
  if (r.ok) setStatus("✓ The document matches the current settings.");
  else setStatus("✗ " + r.errors.join(", ") + " (details in the log)", true);
}

// ---------------------------------------------------------------- Self-test
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
    setStatus(`Self-test: ${results.length} – ${name}`);
  };
  log("SELFTEST START");
  setStatus("Self-test running… (1–2 minutes, please don't click)");
  try {
    await core.executeAsModal(async () => {
      doc = await app.documents.add({ width: 900, height: 520, resolution: 72, mode: "RGBColorMode", fill: "black", name: HIST + " self-test" });
      await batchPlay([{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: "Artwork" } }], {});
      const al = doc.activeLayers[0]; artId = al.id;
      const id = await imaging.createImageDataFromBuffer(testArtwork(900, 520), { width: 900, height: 520, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
      await imaging.putPixels({ documentID: doc.id, layerID: al.id, imageData: id, targetBounds: { left: 0, top: 0 } });
      id.dispose();
      await batchPlay([{ _obj: "make", _target: [{ _ref: "textLayer" }], using: { _obj: "textLayer", textKey: "GLOW",
        textClickPoint: { _obj: "paint", horizontal: { _unit: "percentUnit", _value: 55 }, vertical: { _unit: "percentUnit", _value: 75 } },
        textStyleRange: [{ _obj: "textStyleRange", from: 0, to: 4, textStyle: { _obj: "textStyle", size: { _unit: "pointsUnit", _value: 110 }, color: { _obj: "RGBColor", red: 255, grain: 120, blue: 230 } } }] } }], {});
      textId = doc.activeLayers[0].id;
    }, { commandName: HIST + " prepare self-test" });
    const D = Object.assign({}, Core.DEFAULTS);
    const docCase = async (name, over) => check(name, async () => {
      target = "document"; params = Core.sanitize(Object.assign({}, D, over));
      await applyEffect(false);
      if ($("status").className.indexOf("err") >= 0) return { ok: false, status: $("status").textContent };
      return verifyNow(doc, params);
    });
    for (const pr of Core.PRESETS) await docCase(`Look ${pr.name}`, pr.p);
    const only = { amount: 0, halation: 0, diffusion: 0, streaks: 0, stars: 0 };
    await docCase("Glow only", Object.assign({}, only, { amount: 100 }));
    await docCase("Halation only", Object.assign({}, only, { halation: 90 }));
    await docCase("Diffusion only", Object.assign({}, only, { diffusion: 90 }));
    await docCase("Streaks only", Object.assign({}, only, { streaks: 90 }));
    await docCase("Stars only, 6 rays", Object.assign({}, only, { stars: 90, starRays: 6 }));
    await docCase("Stars, 8 rays rotated", { stars: 70, starRays: 8, starAngle: 30 });
    await docCase("Glow \"Linear Dodge\"", { glowBlend: "linearDodge", amount: 120 });
    await docCase("Own colour + prism", { colorMode: "tint", tint: "#5ab0ff", prism: 90 });
    await docCase("One colour range only", { rangeColor: "#ffd250", rangeWidth: 40, threshold: 20 });
    await docCase("Glow outside only", { outer: 100, colorMode: "tint", tint: "#6a5cff", amount: 150 });
    await docCase("Haze only", Object.assign({}, only, { haze: 90, hazeRadius: 80, hazeTint: 70 }));
    await docCase("Limits: everything at max", { amount: 200, radius: 100, falloff: 0, protect: 100, gamma: 200, saturation: 100, prism: 100, halation: 100, halationRadius: 100, diffusion: 100, diffusionRadius: 100, streaks: 100, streakLength: 100, stars: 100, starLength: 100, outer: 100, haze: 100, hazeRadius: 100, hazeTint: 100 });
    await docCase("Limits: threshold 100, small radius", { threshold: 100, radius: 2, falloff: 100, gamma: 50 });
    await docCase("Overall opacity 30", { opacity: 30 });
    await check("All effects off: clear message, no group", async () => {
      target = "document"; params = Core.sanitize(Object.assign({}, D, only));
      const before = docGroups(doc).length;
      await applyEffect(false);
      const st = $("status").textContent;
      return { ok: st.indexOf("at least one effect") >= 0 && docGroups(doc).length === before, st };
    });
    await check("Applying again replaces the group", async () => {
      params = Core.sanitize(Object.assign({}, D));
      await applyEffect(false); await applyEffect(false);
      return { ok: docGroups(doc).length === 1, groups: docGroups(doc).length };
    });
    await check("Live: several updates = one history step", async () => {
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
    await check("Selecting the group loads its settings", async () => {
      const want = Object.assign({}, params);
      params = Object.assign({}, D, { radius: 99 }); loadedKey = null;
      await refreshPreviewSource();
      return { ok: JSON.stringify(params) === JSON.stringify(want), radius: params.radius };
    });
    await check("Remove (document) leaves nothing", async () => {
      await removeEffect();
      return { ok: docGroups(doc).length === 0 && doc.layers.length === 3, layers: doc.layers.map((l) => l.name) };
    });
    // ---- layers
    const layerCase = async (name, ids, over) => check(name, async () => {
      target = "layers"; params = Core.sanitize(Object.assign({}, D, over));
      await core.executeAsModal(async () => { await selectLayers(ids); }, { commandName: HIST + " test" });
      await applyEffect(false);
      if ($("status").className.indexOf("err") >= 0) return { ok: false, status: $("status").textContent };
      return verifyNow(doc, params);
    });
    await layerCase("Layer: text", [textId], { amount: 120, halation: 40 });
    await layerCase("Layer: text again (via the group)", [textId], { amount: 80, stars: 50, streaks: 40 });
    await check("Layer: exactly one group, original visible inside", async () => {
      const gs = doc.layers.filter(isLayerGroup);
      const t = gs[0] && await groupInfo(gs[0]);
      return { ok: gs.length === 1 && !!t && t.source.id === textId && t.source.visible, groups: gs.length };
    });
    await check("Layer: overall opacity sits on the effect layers", async () => {
      target = "layers"; params = Core.sanitize(Object.assign({}, D, { opacity: 40, halation: 50 }));
      await core.executeAsModal(async () => { await selectLayers([textId]); }, { commandName: HIST + " test" });
      await applyEffect(false);
      const v = await verifyNow(doc, params);
      const g = doc.layers.filter(isLayerGroup)[0], kids = Array.from(g.layers).filter((k) => k.id !== textId);
      return { ok: v.ok && Number(g.opacity) === 100 && kids.every((k) => Math.round(Number(k.opacity)) === 40), v };
    });
    await check("Layer with mask: hidden parts don't glow", async () => {
      await core.executeAsModal(async () => {
        await selectLayers([artId]);
        await batchPlay([
          { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _obj: "rectangle", top: { _unit: "pixelsUnit", _value: 0 }, left: { _unit: "pixelsUnit", _value: 0 }, bottom: { _unit: "pixelsUnit", _value: 520 }, right: { _unit: "pixelsUnit", _value: 450 } } },
          { _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } },
          { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } },
        ], {});
      }, { commandName: HIST + " test mask" });
      target = "layers"; params = Core.sanitize(Object.assign({}, D, { amount: 100, radius: 10, protect: 0 }));
      await applyEffect(false);
      const v = await verifyNow(doc, params);
      const g = doc.layers.filter(isLayerGroup).find((x) => x.name === LAYER_PREFIX + "Artwork");
      const gl = Array.from(g.layers).find((k) => k.name === "Glow");
      let lit = -1, hidden = -1;
      await core.executeAsModal(async () => {
        const px = await readLayerRGBA(doc, gl.id, { left: 0, top: 0, right: 900, bottom: 520 });
        lit = px[(220 * 900 + 260) * 4 + 1]; hidden = px[(220 * 900 + 680) * 4 + 1];
      }, { commandName: HIST + " test" });
      return { ok: v.ok && lit > 60 && hidden < 15, lit, hidden, v };
    });
    await check("Layer \"outside only\": no glow on the object, glow next to it", async () => {
      target = "layers"; params = Core.sanitize(Object.assign({}, D, only, { amount: 150, outer: 100, threshold: 10, protect: 0 }));
      await core.executeAsModal(async () => { await selectLayers([textId]); }, { commandName: HIST + " test" });
      await applyEffect(false);
      const v = await verifyNow(doc, params);
      const t = (await resolveTargets(doc)).targets[0];
      const gl = Array.from(t.group.layers).find((k) => k.name === "Glow"), tb = boundsOf(t.source);
      let inside = 0, outside = 0, n = 0;
      await core.executeAsModal(async () => {
        const px = await readLayerRGBA(doc, gl.id, docBounds(doc)), al = await readLayer(null, doc, t.source, docBounds(doc), true);
        for (let y = tb.top; y < tb.bottom; y++) for (let x = tb.left; x < tb.right; x++) {
          const i = (y * 900 + x) * 4;
          if (al.rgba[i + 3] > 250) { inside = Math.max(inside, px[i]); n++; }
        }
        const oy = Math.max(0, tb.top - 6), ox = Math.round((tb.left + tb.right) / 2);
        outside = px[(oy * 900 + ox) * 4];
      }, { commandName: HIST + " test" });
      return { ok: v.ok && n > 100 && inside < 40 && outside > 25, inside, outside, n, v };
    });
    await layerCase("Two layers at once", [artId, textId], { amount: 90, colorMode: "tint", tint: "#9cc4ff" });
    await check("Document look above layer groups", async () => {
      target = "document"; params = Core.sanitize(Object.assign({}, D, { diffusion: 40 }));
      await applyEffect(false);
      const v = await verifyNow(doc, params);
      await removeEffect();
      return v;
    });
    await check("Remove (layers) restores the originals", async () => {
      target = "layers";
      const gs = doc.layers.filter(isLayerGroup);
      await core.executeAsModal(async () => { await selectLayers(gs.map((g) => g.id)); }, { commandName: HIST + " test" });
      await removeEffect();
      const ls = allLayers(doc, []);
      const art = ls.find((l) => l.id === artId), txt = ls.find((l) => l.id === textId);
      return { ok: doc.layers.filter(isLayerGroup).length === 0 && !!art && !!txt && art.visible && txt.visible && !isLayerGroup(art.parent) && !isLayerGroup(txt.parent) && doc.layers.length === 3,
        layers: doc.layers.map((l) => l.name) };
    });
    await check("Check values (broken settings)", async () => {
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
  log("SELFTEST RESULT", { passed: results.length - failed.length, total: results.length, seconds: Math.round((Date.now() - t0) / 1000) });
  for (const r of results) log((r.ok ? "  ✓ " : "  ✗ ") + r.test, r.ok ? undefined : r.details);
  setStatus(`Self-test: ${results.length - failed.length}/${results.length} passed` + (failed.length ? ` – failed: ${failed.map((r) => r.test).join(", ")}` : " ✓"), failed.length > 0);
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
  for (const [name, fn] of [["sliders", buildSliders], ["sections", buildSections], ["controls", buildStatic], ["events", bindControls], ["display", syncUI]]) {
    try { fn(); } catch (e) { log("ERROR while building: " + name, String(e && e.stack || e)); }
  }
  try { action.addNotificationListener(["select", "make", "delete", "open", "close", "set", "move", "transform", "placedLayerEditContents"], onPsEvent); }
  catch (e) { log("event listener not available", String(e)); }
  // developer hook: a file "run-selftest" in the data folder starts the self-test (and is deleted)
  setInterval(async () => {
    if (busy || selfTestRunning) return;
    try { const f = await (await lfs.getDataFolder()).getEntry("run-selftest"); await f.delete(); runSelfTest(); } catch (e) { /* no request */ }
  }, 3000);
  try { await refreshPreviewSource(); } catch (e) { log("ERROR preview", String(e && e.stack || e)); }
}
init();
