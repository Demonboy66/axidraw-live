'use strict';
// AxiDraw Live - draw with a tablet; plot as you go or later. Talks to server.py over a small JSON API.
// Coordinates: strokes are stored in "drawing" millimetres. The placement (position, scale, rotation) maps drawing mm to
// paper mm, and the paper's position on the plotter maps paper mm to plotter mm (measured from the home corner).

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- Document ----------

let nextId = 1;
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;

function drawLayer(name, props = {}) {
  return Object.assign({
    id: newId('L'), kind: 'draw', name, visible: true, locked: false, plot: true,
    color: '#333333', widthMm: 0.4, usePressure: true, light: 40, heavy: 26, gamma: 1, vary: false,
    speed: null, sharpenCm: 0, strokes: [], brush: defaultBrush(), // speed null: the Speed & Pen setting
  }, props);
}

function imageLayer(name) {
  return { id: newId('L'), kind: 'image', name, visible: true, locked: false, opacity: 0.45, src: null, x: 0, y: 0, w: 100, aspect: 1, confine: true };
}

function newDocument() {
  const layers = [
    drawLayer('Outlines', { color: '#2b2b2b', widthMm: 0.3, light: 40, heavy: 26, gamma: 1 }),
    drawLayer('Shading', { color: '#6a6a6a', widthMm: 0.5, light: 42, heavy: 30, gamma: 1.4, sharpenCm: 40 }),
    imageLayer('Image'),
  ];
  return {
    version: 1,
    paper: { w: 148, h: 210, x: 0, y: 0, margin: 5 },
    placement: { x: 0, y: 0, scale: 100, rotate: 0 },
    settings: { speed_pendown: 20, speed_penup: 60, accel: 50, pen_pos_up: 60, pen_rate_lower: 15, pen_rate_raise: 60, pen_delay_down: 0, model: 1, penlift: 3, height_cap: 100, const_speed: 0 },
    layers,
    selected: layers[0].id,
    smoothing: 0,
    speedFollowsSetting: true,
    eraserWidth: 4,
    eraserMode: 'whole', // 'whole' strokes, or 'part' - only what's under the eraser
  };
}

let doc = newDocument();
const layerById = (id) => doc.layers.find((l) => l.id === id);
const selectedLayer = () => layerById(doc.selected) || doc.layers[0];

// ---------- Geometry ----------

function placementMatrix() {
  const { w, h } = doc.paper;
  const { x, y, scale, rotate } = doc.placement;
  const s = scale / 100, r = (rotate * Math.PI) / 180;
  const a = s * Math.cos(r), b = s * Math.sin(r), c = -b, d = a;
  const cx = w / 2, cy = h / 2;
  return [a, b, c, d, cx + x - a * cx - c * cy, cy + y - b * cx - d * cy];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const placementScale = () => doc.placement.scale / 100;

function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

// Ramer-Douglas-Peucker simplification (keeps each kept point's extra values, e.g. pressure)
function simplify(pts, tolerance) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [x0, y0] = pts[i0], [x1, y1] = pts[i1];
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    let worst = -1, worstD = tolerance;
    for (let i = i0 + 1; i < i1; i++) {
      // Distance from the line between the ends - or, for a closed loop whose ends meet, from that point
      const d = len > 1e-9 ? Math.abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / len : Math.hypot(pts[i][0] - x0, pts[i][1] - y0);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([i0, worst], [worst, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Clips a polyline of [x, y, value] points to a rectangle, returning the pieces inside (values interpolated)
function clipPolyline(pts, r) {
  const pieces = [];
  let current = null;
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    let t0 = 0, t1 = 1;
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const edges = [[-dx, p[0] - r.x0], [dx, r.x1 - p[0]], [-dy, p[1] - r.y0], [dy, r.y1 - p[1]]];
    let inside = true;
    for (const [pe, qe] of edges) {
      if (pe === 0) { if (qe < 0) { inside = false; break; } continue; }
      const t = qe / pe;
      if (pe < 0) { if (t > t1) { inside = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { inside = false; break; } if (t < t1) t1 = t; }
    }
    if (!inside) { current = null; continue; }
    const a = lerp(p, q, t0), b = lerp(p, q, t1);
    if (!current || t0 > 0) { current = [a]; pieces.push(current); }
    current.push(b);
    if (t1 < 1) current = null;
  }
  return pieces.filter((piece) => piece.length > 1 && polylineLength(piece) > 0.05);
}

const marginRect = () => {
  const { w, h, margin } = doc.paper;
  return { x0: margin, y0: margin, x1: w - margin, y1: h - margin };
};

// ---------- Pressure -> pen height ----------

const heightCap = () => (doc.settings.height_cap ?? 100);
function heightFor(layer, p) {
  if (!layer.usePressure) return Math.min(layer.heavy, heightCap());
  const t = Math.pow(clamp(p, 0, 1), layer.gamma);
  return Math.min(layer.light + (layer.heavy - layer.light) * t, heightCap());
}
// 0..1, how hard the pen will press - for drawing the preview darker where it presses harder
function depthFor(layer, p) {
  if (!layer.usePressure || layer.light === layer.heavy) return 1;
  return clamp((layer.light - heightFor(layer, p)) / (layer.light - layer.heavy), 0, 1);
}
const strokePressure = (stroke) => stroke.pts.reduce((sum, pt) => sum + pt[2], 0) / stroke.pts.length;

// Plotter-space points ([x, y, height] mm from home) for a stroke, clipped to the paper margin; may be several pieces
function strokeToPlot(layer, stroke, m = placementMatrix()) {
  const fixedHeight = heightFor(layer, strokePressure(stroke));
  const pts = stroke.pts.map((pt) => {
    const [x, y] = apply(m, pt[0], pt[1]);
    return [x, y, layer.vary ? heightFor(layer, pt[2]) : fixedHeight];
  });
  return clipPolyline(pts, marginRect()).map((piece) => piece.map(([x, y, h]) => [
    +(x + doc.paper.x).toFixed(3), +(y + doc.paper.y).toFixed(3), +h.toFixed(1)]));
}

// ---------- Undo ----------

const undoStack = [], redoStack = [];
function snapshot() {
  return { layers: doc.layers.map((l) => ({ ...l, strokes: l.strokes && l.strokes.slice() })), placement: { ...doc.placement } };
}
function restore(snap) {
  // Strokes, layer order and positions come back; settings like colour stay as they are now
  doc.layers = snap.layers.map((s) => {
    const live = layerById(s.id);
    if (!live) return { ...s, strokes: s.strokes && s.strokes.slice() };
    if (live.kind === 'image') return { ...live, x: s.x, y: s.y, w: s.w, src: s.src, aspect: s.aspect };
    return { ...live, strokes: s.strokes.slice() };
  });
  doc.placement = { ...snap.placement };
  if (!layerById(doc.selected)) doc.selected = doc.layers[0].id;
  changed(true);
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
}
function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); } }

// ---------- Server ----------

let status = { connected: false };
const pending = new Map(); // Send token -> stroke, sent to the plotter but not drawn yet
let sendCount = 0;
const sendToken = (strokeId) => `${strokeId}.${(sendCount++).toString(36)}`; // Unique per send, so a replot isn't mistaken for the last one

async function api(path, body = {}) {
  try {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    onStatus(data);
    return data;
  } catch (error) {
    $('status-error').textContent = 'Lost contact with server.py - is it still running?';
    return null;
  }
}

// Plotting requests go one after another, so the server receives a stroke's pieces in order
let sendChain = Promise.resolve();
function sendInOrder(path, body) {
  sendChain = sendChain.then(() => api(path, body));
  return sendChain;
}

// A message from the app itself, kept up for a few seconds before server errors can replace it
let noticeUntil = 0;
function notice(message) {
  $('status-error').textContent = message;
  noticeUntil = Date.now() + 4000;
}

function sharpenAllowances() {
  const result = {};
  for (const l of doc.layers) if (l.kind === 'draw') result[l.id] = (l.sharpenCm || 0) * 10;
  return result;
}
let settingsTimer = 0;
function sendSettings(delay = 250) {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => api('settings', { settings: doc.settings, heightCap: heightCap(), sharpenEvery: sharpenAllowances() }), delay);
}

function stripPiece(id) { return String(id).split('#')[0]; }

function onStatus(data) {
  if (!data || data.error === 'Unknown route') return;
  status = data;
  for (const id of data.doneIds || []) {
    const stroke = pending.get(stripPiece(id));
    if (stroke) { stroke.plotted = true; pending.delete(stripPiece(id)); sceneDirty = true; }
  }
  const conn = $('connection');
  conn.textContent = data.connected ? (data.simulate ? 'Simulating (the plotter stays still)' : 'Connected to the AxiDraw') : 'Not connected';
  conn.classList.toggle('ok', !!data.connected);
  $('status-queue').textContent = data.connected ? `Queue: ${data.queued}${data.paused ? ' (paused)' : ''}` : '';
  const lag = lagSeconds();
  $('status-lag').textContent = data.connected && lag >= 0.3 ? `Plotter ${lag.toFixed(1)} s behind (${Math.round(data.backlogMm)} mm to draw)` : '';
  $('status-lag').style.color = lag >= 1 ? lagColour(lag) : '';
  $('status-drawn').textContent = data.totalDrawnMm ? `Plotted: ${(data.totalDrawnMm / 1000).toFixed(2)} m` : '';
  const layer = selectedLayer();
  if (layer.kind === 'draw' && data.lengthSinceSharpen) {
    const since = (data.lengthSinceSharpen[layer.id] || 0) / 10;
    $('status-sharpen').textContent = `${layer.name}: ${since.toFixed(1)} cm since sharpening` + (layer.sharpenCm ? ` (every ${layer.sharpenCm} cm)` : '');
  } else $('status-sharpen').textContent = '';
  if (Date.now() > noticeUntil) $('status-error').textContent = data.error || '';

  const banner = $('banner');
  banner.hidden = !data.paused;
  if (data.paused) {
    $('banner-text').textContent = data.pauseReason || 'Paused';
    $('banner-sharpened').hidden = !data.pauseLayer;
  }
  needsFrame = true;
}

async function pollStatus() {
  try {
    const response = await fetch('/api/status');
    onStatus(await response.json());
  } catch (error) {
    $('status-error').textContent = 'Lost contact with server.py - is it still running?';
  }
  setTimeout(pollStatus, status.connected ? 300 : 1500);
}

function requireConnection() {
  if (status.connected) return true;
  notice('Connect (or Simulate) first.');
  return false;
}

// A layer's drawing (pen-down) speed: its own if it has one, otherwise the Speed & Pen setting
const layerSpeed = (layer) => (layer.speed != null ? layer.speed : doc.settings.speed_pendown);

function strokeJobs(layer, stroke, m, token) {
  return strokeToPlot(layer, stroke, m).map((points, i) => ({
    id: `${token}#${i}`, layer: layer.id, layerName: layer.name, points, speed: layerSpeed(layer), vary: layer.vary,
  }));
}

// Greedy nearest-neighbour ordering, reversing strokes where that's shorter, to cut pen-up travel
function orderJobs(jobs, start = [doc.paper.x, doc.paper.y]) {
  const left = jobs.slice(), result = [];
  let [cx, cy] = start;
  while (left.length) {
    let best = 0, bestD = Infinity, reverse = false;
    for (let i = 0; i < left.length; i++) {
      const pts = left[i].points, a = pts[0], b = pts[pts.length - 1];
      const da = (a[0] - cx) ** 2 + (a[1] - cy) ** 2, db = (b[0] - cx) ** 2 + (b[1] - cy) ** 2;
      if (da < bestD) { bestD = da; best = i; reverse = false; }
      if (db < bestD) { bestD = db; best = i; reverse = true; }
    }
    const job = left.splice(best, 1)[0];
    if (reverse) job.points = job.points.slice().reverse();
    result.push(job);
    [cx, cy] = job.points[job.points.length - 1];
  }
  return result;
}

async function plotStrokes(entries, optimise) {
  if (!requireConnection()) return;
  const m = placementMatrix();
  let jobs = [];
  for (const e of entries) e.token = sendToken(e.stroke.id);
  // Layer by layer, bottom of the list first, so upper layers are drawn over lower ones
  for (const layer of doc.layers.slice().reverse()) {
    let layerJobs = [];
    for (const e of entries) if (e.layer === layer) layerJobs.push(...strokeJobs(layer, e.stroke, m, e.token));
    if (optimise && layerJobs.length > 1) layerJobs = orderJobs(layerJobs, jobs.length ? jobs[jobs.length - 1].points.slice(-1)[0] : undefined);
    jobs.push(...layerJobs);
  }
  for (const e of entries) pending.set(e.token, e.stroke);
  sendSettings(0);
  for (let i = 0; i < jobs.length; i += 200) await sendInOrder('strokes', { strokes: jobs.slice(i, i + 200) });
  needsFrame = true;
}

function plotLayers(layers) {
  const onlyNew = $('only-unplotted').checked;
  const queued = new Set(pending.values());
  const entries = [];
  for (const layer of layers) {
    if (layer.kind !== 'draw') continue;
    for (const stroke of layer.strokes) if (!onlyNew || (!stroke.plotted && !queued.has(stroke))) entries.push({ layer, stroke });
  }
  if (!entries.length) { notice('Nothing to plot.'); return; }
  plotStrokes(entries, $('optimise-order').checked);
}

// ---------- View ----------

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const base = document.createElement('canvas');
const baseCtx = base.getContext('2d');
let view = { scale: 3, ox: 40, oy: 40, rot: 0 }; // rot: the screen's turn, in radians - display only, never plotted
let dpr = 1, sceneDirty = true, needsFrame = true;
const images = new Map(); // src -> HTMLImageElement

function resize() {
  dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = base.width = Math.round(w * dpr);
  canvas.height = base.height = Math.round(h * dpr);
  sceneDirty = true;
}
let viewFitted = true; // Keeps the paper fitted as the window resizes, until you pan or zoom
let fitScale = 1;     // The scale at which the paper fits, so zoom can be shown relative to it

// Zooms by a factor, keeping the given screen point (default: the centre of the view) still
function zoomBy(k, sx = canvas.clientWidth / 2, sy = canvas.clientHeight / 2) {
  const scale = clamp(view.scale * k, fitScale * 0.25, fitScale * 64);
  k = scale / view.scale;
  view.ox = sx - (sx - view.ox) * k;
  view.oy = sy - (sy - view.oy) * k;
  view.scale = scale;
  viewFitted = false;
  sceneDirty = true;
  showZoom();
}
function showZoom() { $('zoom-level').textContent = `${Math.round((view.scale / fitScale) * 100)}%`; }

function fit() {
  const w = canvas.clientWidth, h = canvas.clientHeight, pad = 30;
  if (w < 50 || h < 50) return;
  viewFitted = true;
  // The paper's size on screen at the current turn of the view
  const cos = Math.abs(Math.cos(view.rot)), sin = Math.abs(Math.sin(view.rot));
  const bw = doc.paper.w * cos + doc.paper.h * sin, bh = doc.paper.w * sin + doc.paper.h * cos;
  view.scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  // Centre the paper
  const [cx, cy] = rotated(doc.paper.w / 2 * view.scale, doc.paper.h / 2 * view.scale);
  view.ox = w / 2 - cx;
  view.oy = h / 2 - cy;
  fitScale = view.scale;
  sceneDirty = true;
  showZoom();
}
const rotated = (x, y, a = view.rot) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const screenToPaper = (sx, sy) => rotated((sx - view.ox) / view.scale, (sy - view.oy) / view.scale, -view.rot);
const paperToScreen = (x, y) => { const [rx, ry] = rotated(x * view.scale, y * view.scale); return [rx + view.ox, ry + view.oy]; };
function setPaperTransform(c) {
  const a = dpr * view.scale * Math.cos(view.rot), b = dpr * view.scale * Math.sin(view.rot);
  c.setTransform(a, b, -b, a, dpr * view.ox, dpr * view.oy);
}

// Turns the view about a screen point (default: the middle) - the drawing and the plot don't change
function rotateView(delta, sx = canvas.clientWidth / 2, sy = canvas.clientHeight / 2) {
  const [dx, dy] = rotated(view.ox - sx, view.oy - sy, delta);
  view.ox = sx + dx;
  view.oy = sy + dy;
  view.rot = Math.atan2(Math.sin(view.rot + delta), Math.cos(view.rot + delta));
  if (Math.abs(view.rot) < 1e-9) view.rot = 0;
  sceneDirty = true;
  needsFrame = true;
  showRotation();
}
function setViewRotation(degrees) { rotateView((degrees * Math.PI) / 180 - view.rot); }
function showRotation() {
  const deg = Math.round((view.rot * 180) / Math.PI);
  $('rotation').textContent = `${deg}°`;
  $('rotation').classList.toggle('turned', deg !== 0);
}
function setDrawingTransform(c) { setPaperTransform(c); c.transform(...placementMatrix()); }

function imageFor(src) {
  if (!src) return null;
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => { sceneDirty = true; needsFrame = true; };
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function traceStroke(c, pts) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
}

// Depth view: pale yellow for the lightest touch through orange to deep red for the firmest
let depthView = false;
const depthColour = (depth) => `hsl(${50 - 50 * depth}, ${85 + 10 * depth}%, ${68 - 30 * depth}%)`;

function drawStroke(c, layer, stroke) {
  const pts = stroke.pts;
  if (pts.length < 2) return;
  const unit = 1 / (view.scale * placementScale()); // One screen pixel, in drawing units
  const style = (depth) => {
    if (depthView) {
      // Thickness on screen, so depth stays readable at any zoom
      c.strokeStyle = depthColour(depth);
      c.lineWidth = (1 + 3 * depth) * unit;
      c.globalAlpha = 1;
    } else {
      // The pencil's real width on paper (whatever the drawing's scale), darker where it presses harder
      c.strokeStyle = layer.color;
      c.lineWidth = layer.widthMm / placementScale();
      c.globalAlpha = 0.25 + 0.75 * depth;
    }
  };
  if (layer.vary) {
    for (let i = 1; i < pts.length; i++) {
      style(depthFor(layer, (pts[i - 1][2] + pts[i][2]) / 2));
      c.beginPath(); c.moveTo(pts[i - 1][0], pts[i - 1][1]); c.lineTo(pts[i][0], pts[i][1]); c.stroke();
    }
  } else {
    style(depthFor(layer, strokePressure(stroke)));
    traceStroke(c, pts);
    c.stroke();
  }
  c.globalAlpha = 1;
}

// While smoothing, the string between the stylus and where the line is being pulled to
function drawSmoothingString() {
  if (!drawing || !drawing.cursor || !drawing.lazy || drawing.shape) return;
  setDrawingTransform(ctx);
  ctx.strokeStyle = '#5ea2ff';
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1 / view.scale / placementScale();
  ctx.beginPath(); ctx.moveTo(...drawing.lazy); ctx.lineTo(...drawing.cursor); ctx.stroke();
  ctx.beginPath(); ctx.arc(...drawing.cursor, 2 / view.scale / placementScale(), 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
}

// With a sweep hatch brush, the band's width around the cursor
function drawBrushCursor() {
  const layer = selectedLayer();
  if (tool !== 'pen' || !hover || layer.kind !== 'draw' || !layer.brush || !Brushes.fillsArea(layer.brush) || layer.brush.area === 'outline') return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#5ea2ffaa';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(hover[0], hover[1], (layer.brush.width / 2) * view.scale, 0, Math.PI * 2); ctx.stroke();
}

// Next to the cursor while drawing: a gauge of how hard the pen will press, with the pen height
function drawDepthGauge() {
  const layer = selectedLayer();
  if (!penDown || !hover || layer.kind !== 'draw') return;
  const p = drawing ? (layer.vary ? drawing.pts[drawing.pts.length - 1][2] : strokePressure(drawing)) : lastPressure;
  const depth = depthFor(layer, p);
  const x = hover[0] + 16, y = hover[1] + 12, w = 7, h = 44;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000a';
  ctx.fillRect(x - 3, y - 3, w + 40, h + 6);
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.fillStyle = depthColour(depth);
  ctx.fillRect(x + 1, y + 1 + (h - 1) * (1 - depth), w - 1, (h - 1) * depth);
  ctx.fillStyle = '#fff';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(`H ${heightFor(layer, p).toFixed(1)}`, x + w + 5, y + h - 2);
  ctx.fillStyle = '#ffffffaa';
  ctx.fillText(`${Math.round(depth * 100)}%`, x + w + 5, y + 10);
}

// Depth view key for the selected layer
function drawDepthLegend() {
  const layer = selectedLayer();
  if (!depthView || layer.kind !== 'draw') return;
  const w = 150, h = 10, x = 14, y = canvas.clientHeight - 34;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000b';
  ctx.fillRect(x - 8, y - 20, w + 16, h + 34);
  const gradient = ctx.createLinearGradient(x, 0, x + w, 0);
  for (let i = 0; i <= 10; i++) gradient.addColorStop(i / 10, depthColour(i / 10));
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ddd';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(`${layer.name}: pen depth`, x, y - 6);
  const light = layer.usePressure ? layer.light : layer.heavy;
  ctx.fillText(`light H${light}`, x, y + h + 13);
  const firm = `firm H${layer.heavy}`;
  ctx.fillText(firm, x + w - ctx.measureText(firm).width, y + h + 13);
}

function renderBase() {
  const c = baseCtx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#15171a';
  c.fillRect(0, 0, base.width, base.height);
  setPaperTransform(c);
  c.fillStyle = '#fbfaf6';
  c.shadowColor = '#0009'; c.shadowBlur = 16 * dpr;
  c.fillRect(0, 0, doc.paper.w, doc.paper.h);
  c.shadowBlur = 0;
  // The paper is clipped so nothing appears outside it
  c.save();
  c.beginPath(); c.rect(0, 0, doc.paper.w, doc.paper.h); c.clip();
  setDrawingTransform(c);
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const layer of doc.layers.slice().reverse()) {
    if (!layer.visible) continue;
    if (layer.kind === 'image') {
      const img = imageFor(layer.src);
      if (img) { c.globalAlpha = layer.opacity; c.drawImage(img, layer.x, layer.y, layer.w, layer.w * layer.aspect); c.globalAlpha = 1; }
    } else {
      const shifted = dragging && dragging.kind === 'layer' && dragging.layer === layer;
      if (shifted) { c.save(); c.translate(dragging.dx, dragging.dy); }
      for (const stroke of layer.strokes) drawStroke(c, layer, stroke);
      if (shifted) c.restore();
    }
  }
  c.restore();
  // Margin
  setPaperTransform(c);
  const r = marginRect();
  c.setLineDash([2, 2]);
  c.strokeStyle = '#5ea2ff88';
  c.lineWidth = 1 / view.scale;
  c.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  c.setLineDash([]);
  sceneDirty = false;
}

function render() {
  if (sceneDirty) renderBase();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(base, 0, 0);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // The stroke being drawn - with a brush, the lines it will make
  if (drawing) {
    setDrawingTransform(ctx);
    const brush = usesBrush(drawing) ? drawing.layer.brush : null;
    if (brush) {
      if (Brushes.fillsArea(brush)) {
        // Show the area being filled: the band swept, or the outline closing up
        ctx.strokeStyle = '#5ea2ff';
        ctx.globalAlpha = 0.18;
        if (brush.area === 'outline') {
          ctx.lineWidth = 1 / view.scale / placementScale();
          traceStroke(ctx, drawing.pts); ctx.closePath(); ctx.fillStyle = '#5ea2ff'; ctx.fill();
        } else {
          ctx.lineWidth = brush.width / placementScale();
          traceStroke(ctx, drawing.pts.length > 1 ? drawing.pts : [drawing.pts[0], drawing.pts[0]]); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // Working out a brush's lines can be heavy, so the preview is refreshed at most every ~60 ms (longer if it's slow),
      // keeping the page free to take in the pen's movement and pressure
      const pv = drawing.preview, now = performance.now();
      const stale = !pv || pv.n !== drawing.pts.length || pv.src !== drawing.pts;
      if (stale && (!pv || now - pv.at >= Math.max(60, pv.cost * 3))) {
        const t0 = performance.now();
        const lines = brushLines(drawing.layer, drawing.pts, drawing.id);
        drawing.preview = { n: drawing.pts.length, src: drawing.pts, lines, at: now, cost: performance.now() - t0 };
      } else if (stale) {
        needsFrame = true; // Come back for it shortly
      }
      for (const line of drawing.preview.lines) drawStroke(ctx, drawing.layer, { pts: line });
    } else {
      drawStroke(ctx, drawing.layer, { pts: drawing.pts });
    }
  }

  // Strokes waiting for the plotter
  if (pending.size) {
    setDrawingTransform(ctx);
    ctx.strokeStyle = '#5ea2ff';
    ctx.lineWidth = 1.2 / view.scale / placementScale();
    ctx.setLineDash([3 / view.scale, 3 / view.scale]);
    for (const stroke of pending.values()) if (stroke.pts.length > 1) { traceStroke(ctx, stroke.pts); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  // Image bounds while moving it
  const layer = selectedLayer();
  if (tool === 'move' && layer.kind === 'image' && layer.src) {
    setDrawingTransform(ctx);
    ctx.strokeStyle = '#5ea2ff';
    ctx.lineWidth = 1 / view.scale / placementScale();
    ctx.strokeRect(layer.x, layer.y, layer.w, layer.w * layer.aspect);
  }

  // The plotter's pen position
  if (status.connected && status.position) {
    setPaperTransform(ctx);
    const [x, y] = [status.position[0] - doc.paper.x, status.position[1] - doc.paper.y];
    const s = 6 / view.scale;
    ctx.strokeStyle = status.simulate ? '#f0a03c' : '#e5675f';
    ctx.lineWidth = 1.5 / view.scale;
    ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.moveTo(x, y - s); ctx.lineTo(x, y + s); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, s * 0.55, 0, Math.PI * 2); ctx.stroke();
  }

  drawSmoothingString();
  drawBrushCursor();
  drawPaceRing();
  drawDepthGauge();
  drawDepthLegend();

  // Eraser size
  if (tool === 'eraser' && hover) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#e5675f';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(hover[0], hover[1], Math.max(2, eraserWidth() / 2 * view.scale), 0, Math.PI * 2); ctx.stroke();
  }
}

// The plotter's drawing pace in mm/s: measured while it draws, otherwise estimated from the speed setting
function paceMmS() {
  if (status.connected && status.rateMmS) return status.rateMmS;
  const layer = selectedLayer();
  const speed = layer.kind === 'draw' ? layerSpeed(layer) : doc.settings.speed_pendown;
  return 0.5 * 220.9 * speed / 100;
}
const lagSeconds = () => (status.connected ? (status.backlogMm || 0) / Math.max(paceMmS(), 1) : 0);
const lagColour = (lag) => (lag < 1 ? '#4fbf6a' : lag < 3 ? '#f0a03c' : '#e5675f');

function drawPaceRing() {
  if (!$('show-pace').checked || $('live-mode').value === 'off' || !hover || tool !== 'pen') return;
  const lag = lagSeconds(), colour = lagColour(lag);
  const [cx, cy] = hover;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Line from the plotter's pen to the cursor, while it's catching up
  if (status.connected && status.position && lag > 0.05) {
    const [px, py] = paperToScreen(status.position[0] - doc.paper.x, status.position[1] - doc.paper.y);
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx, cy); ctx.stroke();
    ctx.setLineDash([]);
  }
  // One second of plotting around the cursor
  const r = paceMmS() * view.scale;
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = colour;
  ctx.lineWidth = lag > 1 ? 2 : 1.25;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  if (lag >= 0.3) {
    ctx.fillStyle = colour;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.fillText(`${lag.toFixed(1)} s behind`, cx + r * 0.71 + 4, cy - r * 0.71 - 4);
  }
  ctx.globalAlpha = 1;
}

function frame() {
  if (needsFrame || sceneDirty) { needsFrame = false; render(); }
  requestAnimationFrame(frame);
}

// ---------- Input ----------

let tool = 'pen';
let drawing = null;   // {layer, pts (drawing mm, with smoothed pressure), stream}
let dragging = null;  // Move tool / pan state
let erasing = false;
let penDown = null;
let lastPressure = 0;  // {layer, last screen position} while the pen tool is pressed, inside the paper or not
let hover = null;
let spaceDown = false;
let penSeen = false;
const eraserWidth = () => doc.eraserWidth || 4; // mm on the paper
const STREAM_FLUSH_MS = 40;
const STREAM_STEP_MM = 1.0;

function setTool(name) {
  tool = name;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  canvas.className = name === 'pen' || name === 'shape' ? '' : name;
  $('shape-options').hidden = name !== 'shape';
  $('eraser-options').hidden = name !== 'eraser';
  if (name === 'shape') syncShapeBrushChoice();
  needsFrame = true;
}

function eventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}
const pressureOf = (e) => (e.pointerType === 'mouse' ? 0.5 : e.pressure || 0);
function toDrawing(sx, sy) {
  const [px, py] = screenToPaper(sx, sy);
  return apply(invert(placementMatrix()), px, py);
}

function showPointer(e) {
  const [sx, sy] = eventPos(e);
  const [px, py] = screenToPaper(sx, sy);
  const p = e.buttons ? pressureOf(e) : 0;
  $('pressure-bar').style.width = `${Math.round(p * 100)}%`;
  const layer = selectedLayer();
  const h = layer.kind === 'draw' && e.buttons ? `  height ${heightFor(layer, p).toFixed(1)}` : '';
  // The input type shows in red when it isn't the pen - a mouse (or a pen reported as one) has no pressure
  const kind = e.pointerType || '?';
  $('pointer-info').innerHTML = `${px.toFixed(1)}, ${py.toFixed(1)} mm <span class="input-kind ${kind === 'pen' ? '' : 'no-pressure'}">${kind}</span> pressure ${p.toFixed(2)}${h}`;
  // A mouse has no pressure (it counts as 50%). If the tablet pen starts arriving as a mouse, say so.
  if (penSeen && e.pointerType === 'mouse' && e.buttons && performance.now() - mouseWarned > 10000) {
    mouseWarned = performance.now();
    notice('The browser is reporting your pen as a mouse, so pressure is stuck at 50%. Lift the pen and click a toolbar button to reset it.');
  }
}
let mouseWarned = -1e9;

function canDrawOn(layer) { return layer.kind === 'draw' && layer.visible && !layer.locked; }

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') penSeen = true;
  if (e.pointerType === 'touch' && penSeen) return; // Palm rejection
  e.preventDefault(); // No text selection or dragging while the pen moves over the panels
  try { canvas.setPointerCapture(e.pointerId); } catch (error) { /* Synthetic events have no pointer to capture */ }
  const pos = eventPos(e);
  if ((e.button === 1 || spaceDown) && e.altKey) {
    // Space + Option drag turns the view around the middle of the window
    const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
    dragging = { kind: 'turn', angle: Math.atan2(pos[1] - cy, pos[0] - cx) };
    return;
  }
  if (e.button === 1 || spaceDown) {
    dragging = { kind: 'pan', start: pos, ox: view.ox, oy: view.oy };
    return;
  }
  if (e.button !== 0) return;
  const layer = selectedLayer();
  if (tool === 'pen') {
    if (!canDrawOn(layer)) {
      notice(layer.kind !== 'draw' ? 'Select a drawing layer to draw on.' : 'That layer is hidden or locked.');
      return;
    }
    penDown = { layer, last: pos };
    if (insideArea(pos)) startStroke(layer, pos, pressureOf(e));
  } else if (tool === 'shape') {
    if (!canDrawOn(layer)) {
      notice(layer.kind !== 'draw' ? 'Select a drawing layer to draw on.' : 'That layer is hidden or locked.');
      return;
    }
    const id = newId('s');
    drawing = { layer, pts: [], id, token: sendToken(id), started: performance.now(), stream: null,
      shape: { start: screenToPaper(...pos), pressures: [pressureOf(e)] } };
    updateShape(pos, e);
  } else if (tool === 'eraser') {
    pushUndo();
    erasing = true;
    eraseAt(pos);
  } else if (tool === 'move') {
    // Drags the selected layer; with Shift, the whole drawing (every layer and the image together)
    const kind = e.shiftKey ? 'placement' : layer.kind === 'image' ? 'image' : 'layer';
    if (kind !== 'placement' && layer.locked) { notice('That layer is locked.'); return; }
    pushUndo();
    const m = invert(placementMatrix());
    dragging = { kind, start: screenToPaper(...pos), inv: m, layer, dx: 0, dy: 0,
      x0: kind === 'image' ? layer.x : doc.placement.x, y0: kind === 'image' ? layer.y : doc.placement.y };
  }
  needsFrame = true;
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && penSeen) return;
  showPointer(e);
  lastPressure = e.buttons ? pressureOf(e) : 0;
  const pos = eventPos(e);
  hover = pos;
  if (dragging) {
    if (dragging.kind === 'turn') {
      const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
      const angle = Math.atan2(pos[1] - cy, pos[0] - cx);
      let delta = angle - dragging.angle;
      // Hold Shift to turn in 15° steps
      if (e.shiftKey) {
        const step = Math.PI / 12, target = Math.round((view.rot + delta) / step) * step;
        delta = target - view.rot;
      }
      if (Math.abs(delta) > 1e-9) {
        dragging.angle += delta;
        rotateView(delta);
        viewFitted = false;
      }
    } else if (dragging.kind === 'pan') {
      view.ox = dragging.ox + pos[0] - dragging.start[0];
      view.oy = dragging.oy + pos[1] - dragging.start[1];
      viewFitted = false;
      sceneDirty = true;
    } else {
      const [px, py] = screenToPaper(...pos);
      if (dragging.kind === 'placement') {
        doc.placement.x = +(dragging.x0 + px - dragging.start[0]).toFixed(2);
        doc.placement.y = +(dragging.y0 + py - dragging.start[1]).toFixed(2);
        syncPlacementInputs();
      } else {
        const m = dragging.inv;
        const a = apply(m, ...dragging.start), b = apply(m, px, py);
        if (dragging.kind === 'layer') {
          // Shown shifted while dragging; the strokes themselves move when you let go
          dragging.dx = b[0] - a[0];
          dragging.dy = b[1] - a[1];
        } else {
          dragging.layer.x = +(dragging.x0 + b[0] - a[0]).toFixed(2);
          dragging.layer.y = +(dragging.y0 + b[1] - a[1]).toFixed(2);
          renderLayerProps();
        }
      }
      sceneDirty = true;
    }
  } else if (drawing && drawing.shape) {
    drawing.shape.pressures.push(pressureOf(e));
    updateShape(pos, e);
  } else if (penDown) {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) penMove(eventPos(ev), pressureOf(ev));
    if (drawing && drawing.stream) streamProgress(drawing, false);
  } else if (erasing) {
    eraseAt(pos);
  }
  needsFrame = true;
});

function endPointer(e) {
  if (dragging) {
    if (dragging.kind === 'layer') {
      const { layer, dx, dy } = dragging;
      dragging = null;
      shiftLayer(layer, dx, dy);
      changed(true);
    } else if (dragging.kind !== 'pan' && dragging.kind !== 'turn') changed(false);
    dragging = null;
  }
  if (erasing) { erasing = false; changed(true); }
  if (drawing) finishStroke(true);
  penDown = null;
  $('pressure-bar').style.width = '0';
  needsFrame = true;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { hover = null; needsFrame = true; });

// The pen only draws inside the paper's margin (and on top of the image, if it's set to confine drawing), and only
// within the visible canvas. Leaving it lifts the pen (ending the stroke at the edge); coming back in
// while still pressing starts a new stroke from the edge.
const onCanvas = (pos) => pos[0] >= 0 && pos[1] >= 0 && pos[0] <= canvas.clientWidth && pos[1] <= canvas.clientHeight;

function insideArea(pos) {
  if (!onCanvas(pos)) return false; // Only where you can see it - not under the panels when zoomed in
  return insideDrawingArea(...toDrawing(...pos));
}
// The same for a point in drawing mm: inside the margin and, if any visible image confines drawing, on an image
function insideDrawingArea(dx, dy, m = placementMatrix(), images = confiningImages()) {
  const [x, y] = apply(m, dx, dy), r = marginRect();
  if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false;
  return !images.length || images.some((l) => dx >= l.x && dx <= l.x + l.w && dy >= l.y && dy <= l.y + l.w * l.aspect);
}
const confiningImages = () => doc.layers.filter((l) => l.kind === 'image' && l.visible && l.src && l.confine);

// Brush lines can reach past the drawing area (a hatch band, rake lines), so they're trimmed to it
function clipToDrawingArea(lines) {
  const m = placementMatrix(), images = confiningImages(), step = 0.2 / placementScale();
  const inside = (pt) => insideDrawingArea(pt[0], pt[1], m, images);
  const out = [];
  for (const line of lines) {
    if (line.every(inside)) { out.push(line); continue; } // Usually all of it - kept exactly as made
    // Otherwise check along it in small steps, keeping every original corner, and split where it leaves the area
    let run = [];
    const flush = () => { if (run.length > 1) out.push(simplify(run, 0.02 / placementScale())); run = []; };
    const visit = (pt) => { if (inside(pt)) run.push(pt); else flush(); };
    for (let i = 0; i < line.length; i++) {
      visit(line[i]);
      const next = line[i + 1];
      if (!next) break;
      const n = Math.floor(Math.hypot(next[0] - line[i][0], next[1] - line[i][1]) / step);
      for (let j = 1; j < n; j++) {
        const t = j / n;
        visit([line[i][0] + (next[0] - line[i][0]) * t, line[i][1] + (next[1] - line[i][1]) * t, line[i][2] + (next[2] - line[i][2]) * t]);
      }
    }
    flush();
  }
  return out;
}

// The lines a gesture makes with its layer's brush
function brushLines(layer, pts, seed) {
  if (!layer.brush || layer.brush.type === 'pen') return [pts];
  const lines = Brushes.generate(layer.brush, pts, { k: 1 / placementScale(), rotate: doc.placement.rotate, seed });
  return clipToDrawingArea(lines);
}
function edgeBetween(inside, outside) {
  let a = inside, b = outside;
  for (let i = 0; i < 14; i++) {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (insideArea(mid)) a = mid; else b = mid;
  }
  return a;
}
function startStroke(layer, pos, pressure) {
  const [x, y] = toDrawing(...pos);
  const id = newId('s');
  drawing = { layer, pts: [[x, y, pressure]], id, token: sendToken(id), started: performance.now(), stream: null, lazy: [x, y] };
  // Following as you draw works for the plain pen; other brushes plot when the stroke is finished
  const plainPen = !layer.brush || layer.brush.type === 'pen';
  if ($('live-mode').value === 'stream' && status.connected && layer.plot && plainPen) drawing.stream = { begun: false, sent: 0, lastFlush: 0 };
}
// Smoothing works like a string: the line is pulled along behind the stylus by a string up to 4 mm long, so small
// wobbles never reach it. 0 = the line follows the stylus exactly.
const smoothingRadius = () => (4 * Math.pow((doc.smoothing || 0) / 100, 1.5)) / placementScale();

function addPoint(pos, pressure) {
  let [x, y] = toDrawing(...pos);
  const r = smoothingRadius();
  if (r > 0) {
    const [lx, ly] = drawing.lazy;
    const d = Math.hypot(x - lx, y - ly);
    drawing.cursor = [x, y];
    if (d <= r) return;
    x = lx + ((x - lx) * (d - r)) / d;
    y = ly + ((y - ly) * (d - r)) / d;
    drawing.lazy = [x, y];
  }
  const last = drawing.pts[drawing.pts.length - 1];
  if (Math.hypot(x - last[0], y - last[1]) < 0.15 / placementScale()) return;
  drawing.pts.push([x, y, last[2] + 0.35 * (pressure - last[2])]); // Smoothed, as raw pen pressure jitters
}
function penMove(pos, pressure) {
  const inside = insideArea(pos), wasInside = insideArea(penDown.last);
  if (drawing && !inside) {
    addPoint(edgeBetween(penDown.last, pos), pressure);
    if (drawing.stream) streamProgress(drawing, false);
    finishStroke(false);
  } else if (!drawing && inside) {
    startStroke(penDown.layer, wasInside ? pos : edgeBetween(pos, penDown.last), pressure);
    if (!wasInside) addPoint(pos, pressure);
  } else if (drawing) {
    addPoint(pos, pressure);
  }
  penDown.last = pos;
}

// Lines and shapes: dragged out on the paper, then drawn with the layer's brush. Shift makes squares, circles and
// regular polygons, and snaps lines to 15° steps; Option (Alt) draws from the centre.
function updateShape(pos, e) {
  const sh = drawing.shape, kind = shapeKind;
  const [x0, y0] = sh.start;
  let [x1, y1] = screenToPaper(...pos);
  const p = sh.pressures.reduce((a, b) => a + b, 0) / sh.pressures.length;
  let pts = [];
  if (kind === 'line') {
    if (e.shiftKey) {
      const len = Math.hypot(x1 - x0, y1 - y0), step = Math.PI / 12;
      const a = Math.round(Math.atan2(y1 - y0, x1 - x0) / step) * step;
      x1 = x0 + len * Math.cos(a); y1 = y0 + len * Math.sin(a);
    }
    pts = [[x0, y0], [x1, y1]];
  } else {
    let w = x1 - x0, h = y1 - y0;
    if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    // From the corner, or (Option) from the centre
    const cx = e.altKey ? x0 : x0 + w / 2, cy = e.altKey ? y0 : y0 + h / 2;
    const rx = e.altKey ? Math.abs(w) : Math.abs(w) / 2, ry = e.altKey ? Math.abs(h) : Math.abs(h) / 2;
    if (kind === 'rect') {
      pts = [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry], [cx - rx, cy - ry]];
    } else if (kind === 'ellipse') {
      const n = Math.max(24, Math.min(720, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / 0.5)));
      for (let i = 0; i <= n; i++) pts.push([cx + rx * Math.cos((i / n) * 2 * Math.PI), cy + ry * Math.sin((i / n) * 2 * Math.PI)]);
    } else {
      const sides = clamp(Math.round(+$('shape-sides').value || 6), 3, 24);
      for (let i = 0; i <= sides; i++) {
        const a = -Math.PI / 2 + (i / sides) * 2 * Math.PI;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
    }
  }
  const inv = invert(placementMatrix());
  drawing.pts = pts.map(([x, y]) => [...apply(inv, x, y), p]);
  needsFrame = true;
}

function finishStroke(allowDot) {
  const d = drawing;
  drawing = null;
  let pts = d.pts;
  if (d.shape && polylineLength(pts) < 0.3 / placementScale()) return; // A click without a drag makes no shape
  // With smoothing, the line trails the stylus on its string - when you lift, it finishes where the stylus was
  if (allowDot && d.cursor && d.lazy && !d.shape && insideDrawingArea(...d.cursor)) {
    const last = pts[pts.length - 1];
    if (Math.hypot(d.cursor[0] - last[0], d.cursor[1] - last[1]) > 0.05 / placementScale()) pts.push([d.cursor[0], d.cursor[1], last[2]]);
  }
  if (pts.length === 1 && !allowDot && !(d.stream && d.stream.begun)) return; // Only touched the edge
  if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.3 / placementScale(), pts[0][1], pts[0][2]]]; // A tap makes a dot
  if (d.stream) {
    d.pts = pts;
    streamProgress(d, true);
  }
  const round = (line) => line.map(([x, y, p]) => [+x.toFixed(3), +y.toFixed(3), +p.toFixed(3)]);
  let strokes;
  if (usesBrush(d)) {
    // A brush's lines are kept as a group, which the eraser removes together
    strokes = brushLines(d.layer, pts, d.id).map((line, i) => ({ id: `${d.id}-${i}`, group: d.id, pts: round(line), plotted: false }));
    if (!strokes.length) return;
  } else if (d.shape) {
    // Shapes can be dragged past the drawing area, so they're trimmed to it like brush lines
    const lines = clipToDrawingArea([simplify(pts, 0.02 / placementScale())]);
    strokes = lines.map((line, i) => ({ id: lines.length > 1 ? `${d.id}-${i}` : d.id, group: lines.length > 1 ? d.id : undefined, pts: round(line), plotted: false }));
    if (!strokes.length) return;
  } else {
    strokes = [{ id: d.id, pts: round(simplify(pts, 0.04 / placementScale())), plotted: false }];
  }
  pushUndo();
  d.layer.strokes.push(...strokes);
  if (d.stream && d.stream.begun) pending.set(d.token, strokes[0]);
  else if ($('live-mode').value !== 'off' && status.connected && d.layer.plot) {
    plotStrokes(strokes.map((stroke) => ({ layer: d.layer, stroke })), strokes.length > 1 && $('optimise-order').checked);
  }
  changed(true); // Also refreshes the layer's line-length figures
}

// "Follow as I draw": the stroke goes to the plotter in pieces while it's drawn. The pen lands once the first ~1.5 mm or
// 80 ms show how hard you're pressing.
function streamProgress(d, final) {
  if (!d) return;
  const s = d.stream, layer = d.layer, now = performance.now();
  const m = placementMatrix(), r = marginRect();
  const toPlot = (pt, h) => {
    const [x, y] = apply(m, pt[0], pt[1]);
    return [+(clamp(x, r.x0, r.x1) + doc.paper.x).toFixed(3), +(clamp(y, r.y0, r.y1) + doc.paper.y).toFixed(3), +h.toFixed(1)];
  };
  if (!s.begun) {
    const enough = final || now - d.started > 80 || polylineLength(d.pts) > 1.5 / placementScale();
    if (!enough) return;
    s.height = heightFor(layer, d.pts.reduce((sum, pt) => sum + pt[2], 0) / d.pts.length);
    s.begun = true;
    s.sent = 1;
    s.lastFlush = now;
    sendInOrder('stream', { phase: 'begin', id: d.token, layer: layer.id, layerName: layer.name, speed: layerSpeed(layer), vary: layer.vary,
      points: [toPlot(d.pts[0], s.height)] });
    pending.set(d.token, { id: d.id, pts: d.pts });
  }
  if (final || now - s.lastFlush > STREAM_FLUSH_MS) {
    // The plotter stops briefly at every point it's sent while following, so only points at least STREAM_STEP_MM
    // apart go - fewer, longer moves keep it closer behind you
    const step = STREAM_STEP_MM / placementScale();
    const fresh = [];
    for (let i = s.sent; i < d.pts.length; i++) {
      const pt = d.pts[i];
      const last = s.lastPt || d.pts[0];
      const isEnd = final && i === d.pts.length - 1;
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= step || (isEnd && pt !== last)) { fresh.push(pt); s.lastPt = pt; }
    }
    s.sent = d.pts.length;
    if (fresh.length) {
      sendInOrder('stream', { phase: 'extend', id: d.token, vary: layer.vary,
        points: fresh.map((pt) => toPlot(pt, layer.vary ? heightFor(layer, pt[2]) : s.height)) });
    }
    s.lastFlush = now;
  }
  if (final) sendInOrder('stream', { phase: 'end', id: d.token });
}

// The parts of a polyline outside a circle, as pieces (pressure carried along), or null if the circle misses it.
// Leaves the original untouched, so undo still has it.
function cutCircle(pts, cx, cy, r) {
  const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const inside = (q) => (q[0] - cx) ** 2 + (q[1] - cy) ** 2 < r * r;
  const pieces = [];
  let current = inside(pts[0]) ? [] : [pts[0]];
  let touched = inside(pts[0]);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - cx, fy = a[1] - cy;
    const qa = dx * dx + dy * dy, qb = 2 * (fx * dx + fy * dy), qc = fx * fx + fy * fy - r * r;
    const disc = qb * qb - 4 * qa * qc;
    if (qa === 0 || disc <= 0) { if (!inside(b)) current.push(b); continue; }
    const t1 = (-qb - Math.sqrt(disc)) / (2 * qa), t2 = (-qb + Math.sqrt(disc)) / (2 * qa);
    if (t2 <= 0 || t1 >= 1) { current.push(b); continue; } // Passes by
    touched = true;
    if (t1 > 0) current.push(at(a, b, t1));               // Runs into the circle: end this piece at its edge
    if (current.length > 1) pieces.push(current);
    current = t2 < 1 ? [at(a, b, t2), b] : [];            // Comes out again: start a new piece at the edge
  }
  if (current.length > 1) pieces.push(current);
  if (!touched) return null;
  const min = 0.05 / placementScale();
  return pieces.filter((piece) => polylineLength(piece) > min).map((piece) => piece.map(([x, y, p]) => [+x.toFixed(3), +y.toFixed(3), p]));
}

function eraseAt(pos) {
  const layer = selectedLayer();
  if (!canDrawOn(layer) || !onCanvas(pos)) return;
  const [x, y] = toDrawing(...pos);
  const r = eraserWidth() / 2 / placementScale();
  const near = (pts) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[i + 1] || a;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      if (Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) <= r) return true;
    }
    return false;
  };
  if (doc.eraserMode === 'part') {
    // Only what's under the eraser: cut it out, splitting strokes where it crosses them
    let changedAny = false;
    const kept = [];
    for (const st of layer.strokes) {
      const pieces = near(st.pts) ? cutCircle(st.pts, x, y, r) : null;
      if (!pieces) { kept.push(st); continue; }
      changedAny = true;
      pieces.forEach((pts, i) => kept.push({ ...st, id: pieces.length > 1 ? `${st.id}~${i}${newId('')}` : `${st.id}~${newId('')}`, pts }));
    }
    if (changedAny) { layer.strokes = kept; sceneDirty = true; renderLayers(); }
    return;
  }
  const before = layer.strokes.length;
  // Touching any line of a brush stroke removes the whole stroke
  const hit = new Set();
  for (const st of layer.strokes) if (near(st.pts)) hit.add(st.group || st.id);
  if (hit.size) layer.strokes = layer.strokes.filter((st) => !hit.has(st.group || st.id));
  if (layer.strokes.length !== before) { sceneDirty = true; renderLayers(); }
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomBy(Math.exp(-e.deltaY * 0.01), ...eventPos(e));
    return;
  } else {
    view.ox -= e.deltaX;
    view.oy -= e.deltaY;
  }
  viewFitted = false;
  sceneDirty = true;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input, select, textarea')) return;
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (cmd && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
  else if (cmd) return;
  else if (e.key === ' ') { spaceDown = true; canvas.className = 'pan'; e.preventDefault(); }
  else if (e.key === 'p') setTool('pen');
  else if (e.key === 'e') setTool('eraser');
  else if (e.key === 'm') setTool('move');
  else if (e.key === 's') setTool('shape');
  else if (e.key === 'r') rotateView(Math.PI / 12);
  else if (e.key === 'R') rotateView(-Math.PI / 12);
  else if (e.key === '5') setViewRotation(0);
  else if (e.key === '[' || e.key === ']') setEraserWidth(eraserWidth() * (e.key === ']' ? 1.25 : 0.8));
  else if (e.key === 'd') toggleDepthView();
  else if (e.key.startsWith('Arrow')) {
    // Nudge the selected layer 0.5 mm (Shift: 5 mm), in paper directions
    const layer = selectedLayer();
    if (layer.locked) return;
    e.preventDefault();
    const step = (e.shiftKey ? 5 : 0.5);
    // Directions as seen on screen, so they still make sense with the view turned
    const [px, py] = rotated(...{ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key], -view.rot);
    const m = invert(placementMatrix());
    const a = apply(m, 0, 0), b = apply(m, px, py);
    pushUndo();
    shiftLayer(layer, b[0] - a[0], b[1] - a[1]);
    changed(true);
  }
  else if (e.key === '0') fit();
  else if (e.key === '=' || e.key === '+') zoomBy(1.5, ...(hover || []));
  else if (e.key === '-') zoomBy(1 / 1.5, ...(hover || []));
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; setTool(tool); } });

// ---------- Panels ----------

function changed(structure) {
  if (structure && tool === 'shape') syncShapeBrushChoice();
  sceneDirty = true;
  needsFrame = true;
  renderLayers();
  if (structure) renderLayerProps();
  syncPlacementInputs();
  scheduleAutosave();
}

function renderLayers() {
  const list = $('layers');
  list.innerHTML = '';
  for (const layer of doc.layers) {
    const li = document.createElement('li');
    li.classList.toggle('selected', layer.id === doc.selected);
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = layer.kind === 'image' ? 'linear-gradient(135deg,#888,#ddd)' : layer.color;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = layer.name;
    name.title = 'Double-click to rename';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = layer.kind === 'draw' ? layer.strokes.length : (layer.src ? '' : 'empty');
    li.append(swatch, name, count);
    const toggle = (label, key, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.classList.toggle('off', !layer[key]);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        layer[key] = !layer[key];
        changed(true);
        if (key === 'plot') sendSettings();
      });
      li.append(b);
    };
    toggle('👁', 'visible', 'Show or hide');
    if (layer.kind === 'draw') toggle('⎙', 'plot', 'Plot this layer (live, and with Plot Layers)');
    const lock = document.createElement('button');
    lock.textContent = layer.locked ? '🔒' : '🔓';
    lock.title = 'Lock against drawing, erasing and moving';
    lock.classList.toggle('off', !layer.locked);
    lock.addEventListener('click', (e) => { e.stopPropagation(); layer.locked = !layer.locked; changed(true); });
    li.append(lock);
    li.addEventListener('click', () => { doc.selected = layer.id; changed(true); });
    name.addEventListener('dblclick', () => {
      // Rename in the layer's Name box (pop-up prompts can be blocked)
      doc.selected = layer.id;
      changed(true);
      const box = document.querySelector('#layer-props input[type=text]');
      if (box) { box.focus(); box.select(); }
    });
    list.append(li);
  }
}

function field(container, label, input, hint) {
  const l = document.createElement('label');
  l.append(label, ' ', input);
  if (hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = ` ${hint}`; l.append(h); }
  container.append(l);
  return input;
}
function numberInput(value, min, max, step, onChange) {
  const input = document.createElement('input');
  Object.assign(input, { type: 'number', value, min, max, step });
  input.addEventListener('change', () => { const v = parseFloat(input.value); if (!isNaN(v)) onChange(clamp(v, min, max)); });
  return input;
}
function rangeInput(value, min, max, step, onInput, format) {
  const wrap = document.createElement('span');
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', value, min, max, step });
  const out = document.createElement('span');
  out.className = 'value';
  out.textContent = format(value);
  input.addEventListener('input', () => { out.textContent = format(+input.value); onInput(+input.value); });
  wrap.append(out, input);
  return wrap;
}

function renderLayerProps() {
  const panel = $('layer-props');
  panel.innerHTML = '';
  const layer = selectedLayer();
  const h2 = document.createElement('h2');
  h2.textContent = `${layer.name} - ${layer.kind === 'image' ? 'image (never plotted)' : 'drawing layer'}`;
  panel.append(h2);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = layer.name;
  nameInput.addEventListener('change', () => { layer.name = nameInput.value.trim() || layer.name; changed(true); });
  field(panel, 'Name', nameInput);

  if (layer.kind === 'image') {
    const row = document.createElement('div');
    row.className = 'row';
    const importButton = document.createElement('button');
    importButton.textContent = layer.src ? 'Replace Image…' : 'Import Image…';
    importButton.addEventListener('click', () => $('image-file').click());
    row.append(importButton);
    if (layer.src) {
      const fitButton = document.createElement('button');
      fitButton.textContent = 'Fit to Paper';
      fitButton.addEventListener('click', () => { pushUndo(); fitImage(layer); changed(true); });
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.className = 'danger';
      remove.addEventListener('click', () => { pushUndo(); layer.src = null; changed(true); });
      row.append(fitButton, remove);
    }
    panel.append(row);
    const confineBox = document.createElement('input');
    confineBox.type = 'checkbox';
    confineBox.checked = layer.confine;
    confineBox.addEventListener('change', () => { layer.confine = confineBox.checked; scheduleAutosave(); });
    const cl = document.createElement('label');
    cl.className = 'check';
    cl.title = 'The pen lifts at the edge of the image, as it does at the paper margin. Hidden images don\'t limit drawing.';
    cl.append(confineBox, ' Only draw on top of this image');
    panel.append(cl);
    field(panel, 'Opacity', rangeInput(layer.opacity, 0.05, 1, 0.05, (v) => { layer.opacity = v; sceneDirty = true; needsFrame = true; }, (v) => `${Math.round(v * 100)}%`));
    const row2 = document.createElement('div');
    row2.className = 'row';
    field(row2, 'X', numberInput(layer.x, -2000, 2000, 0.5, (v) => { layer.x = v; changed(false); }));
    field(row2, 'Y', numberInput(layer.y, -2000, 2000, 0.5, (v) => { layer.y = v; changed(false); }));
    panel.append(row2);
    field(panel, 'Width', numberInput(layer.w, 1, 3000, 1, (v) => { layer.w = v; changed(false); }), 'mm');
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Use the Move tool with this layer selected to drag the image. It moves with the drawing when you position it.';
    panel.append(hint);
    return;
  }

  const color = document.createElement('input');
  color.type = 'color';
  color.value = layer.color;
  color.addEventListener('input', () => { layer.color = color.value; changed(false); });
  field(panel, 'Colour', color);
  field(panel, 'Pencil width', numberInput(layer.widthMm, 0.1, 3, 0.05, (v) => { layer.widthMm = v; changed(false); }), 'mm - the line it plots, shown at true size');

  const pressureBox = document.createElement('input');
  pressureBox.type = 'checkbox';
  pressureBox.checked = layer.usePressure;
  pressureBox.addEventListener('change', () => { layer.usePressure = pressureBox.checked; changed(true); });
  const pl = document.createElement('label');
  pl.className = 'check';
  pl.append(pressureBox, ' Pressure sets the pen height');
  panel.append(pl);

  if (layer.usePressure) {
    const row = document.createElement('div');
    row.className = 'row';
    field(row, 'Light', numberInput(layer.light, 0, 100, 0.5, (v) => { layer.light = v; changed(true); }));
    field(row, 'Firm', numberInput(layer.heavy, 0, 100, 0.5, (v) => { layer.heavy = v; changed(true); }));
    panel.append(row);
    if (Math.max(layer.light, layer.heavy) > heightCap()) {
      const capHint = document.createElement('p');
      capHint.className = 'hint error';
      capHint.textContent = `Heights above ${heightCap()} (the highest safe height) are capped at ${heightCap()}.`;
      panel.append(capHint);
    }
    field(panel, 'Response', rangeInput(layer.gamma, 0.3, 3, 0.05, (v) => { layer.gamma = v; sceneDirty = true; needsFrame = true; },
      (v) => (v < 0.95 ? `${v.toFixed(2)} (presses sooner)` : v > 1.05 ? `${v.toFixed(2)} (needs a firmer hand)` : 'even')));
    const varyBox = document.createElement('input');
    varyBox.type = 'checkbox';
    varyBox.checked = layer.vary;
    varyBox.addEventListener('change', () => { layer.vary = varyBox.checked; changed(false); });
    const vl = document.createElement('label');
    vl.className = 'check';
    vl.append(varyBox, ' Change pressure during a stroke (experimental)');
    panel.append(vl);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = layer.vary
      ? 'The pen moves up and down as you press harder or lighter while drawing. Its servo reacts a little behind the line.'
      : 'Each stroke plots at one height, from how hard you pressed on average.';
    panel.append(hint);
  } else {
    field(panel, 'Pen height', numberInput(layer.heavy, 0, 100, 0.5, (v) => { layer.heavy = v; changed(true); }));
  }

  renderBrushProps(panel, layer);
  // Drawing speed: the Speed & Pen setting, unless this layer has its own
  const ownBox = document.createElement('input');
  ownBox.type = 'checkbox';
  ownBox.checked = layer.speed != null;
  ownBox.addEventListener('change', () => { layer.speed = ownBox.checked ? doc.settings.speed_pendown : null; changed(true); });
  const ol = document.createElement('label');
  ol.className = 'check';
  ol.append(ownBox, layer.speed != null ? ' Own drawing speed' : ` Own drawing speed (now following Speed & Pen: ${doc.settings.speed_pendown}%)`);
  panel.append(ol);
  if (layer.speed != null) field(panel, 'Drawing speed', rangeInput(layer.speed, 1, 100, 1, (v) => { layer.speed = v; scheduleAutosave(); }, (v) => `${v}%`));
  field(panel, 'Sharpen every', numberInput(layer.sharpenCm, 0, 10000, 1, (v) => { layer.sharpenCm = v; sendSettings(); changed(true); }), 'cm of line (0 = never)');

  const total = layer.strokes.reduce((sum, s) => sum + polylineLength(s.pts), 0) * placementScale();
  const unplotted = layer.strokes.filter((s) => !s.plotted).reduce((sum, s) => sum + polylineLength(s.pts), 0) * placementScale();
  const stats = document.createElement('p');
  stats.className = 'hint';
  stats.textContent = `${layer.strokes.length} strokes, ${(total / 10).toFixed(1)} cm of line (${(unplotted / 10).toFixed(1)} cm not plotted yet)` +
    (layer.sharpenCm ? ` - about ${Math.floor(unplotted / 10 / layer.sharpenCm)} sharpenings to plot the rest.` : '.');
  panel.append(stats);
  const reset = document.createElement('button');
  reset.textContent = 'Just Sharpened';
  reset.title = 'Restart the sharpening count for this layer';
  reset.addEventListener('click', () => api('reset_sharpen', { layer: layer.id }));
  panel.append(reset);
}

// The brush settings for a drawing layer: which brush, and the settings that brush uses
function renderBrushProps(panel, layer) {
  const b = layer.brush;
  const h = document.createElement('h2');
  h.textContent = 'Brush';
  h.style.marginTop = '14px';
  panel.append(h);
  // Buttons rather than a drop-down: a Mac's pop-up menus can leave the browser treating the tablet pen as a mouse
  panel.append(choiceButtons(Object.entries(BRUSH_TYPES).map(([value, label]) => [value, label.split(' - ')[0].replace(/ \(.*\)/, '')]),
    b.type, (value) => { b.type = value; changed(true); }, 'brush-choices'));

  const mm = (label, key, min, max, step, hint) =>
    field(panel, label, numberInput(b[key], min, max, step, (v) => { b[key] = v; scheduleAutosave(); }), hint || 'mm');
  const count = (label, key, min, max) =>
    field(panel, label, numberInput(b[key], min, max, 1, (v) => { b[key] = Math.round(v); scheduleAutosave(); }));
  const note = (text) => { const p = document.createElement('p'); p.className = 'hint'; p.textContent = text; panel.append(p); };

  if (b.type === 'hatch' || b.type === 'crosshatch') {
    const area = choiceButtons([['sweep', 'Sweep a band'], ['outline', 'Fill an outline']], b.area === 'outline' ? 'outline' : 'sweep',
      (value) => { b.area = value; changed(true); });
    area.title = 'Sweep paints a band of the set width; Outline fills the shape you draw around';
    field(panel, 'Area', area);
    if (b.area !== 'outline') mm('Band width', 'width', 0.5, 100, 0.5);
    field(panel, 'Angle', numberInput(b.angle, -180, 180, 5, (v) => { b.angle = v; scheduleAutosave(); }), '°');
    if (b.type === 'hatch') {
      mm('Spacing, light', 'spacingLight', 0.1, 20, 0.1);
      mm('Spacing, firm', 'spacingFirm', 0.1, 20, 0.1);
      note('Pressing harder packs the lines closer.');
    } else {
      mm('Spacing', 'crossSpacing', 0.1, 20, 0.1);
      count('Up to directions', 'maxDirections', 2, 4);
      note('Pressing harder adds directions: one, then across at 90°, then the diagonals.');
    }
    const joinBox = document.createElement('input');
    joinBox.type = 'checkbox';
    joinBox.checked = b.join;
    joinBox.addEventListener('change', () => { b.join = joinBox.checked; scheduleAutosave(); });
    const jl = document.createElement('label');
    jl.className = 'check';
    jl.title = 'Neighbouring lines join at their ends into back-and-forth strokes - far fewer pen lifts, with short turns at the edges';
    jl.append(joinBox, ' Join lines (fewer pen lifts)');
    panel.append(jl);
  } else if (b.type === 'scribble') {
    mm('Width', 'scribbleWidth', 0.2, 50, 0.2, 'mm at full pressure');
    mm('Pitch', 'pitch', 0.1, 10, 0.1);
  } else if (b.type === 'circles') {
    mm('Circle size', 'circleSize', 0.2, 20, 0.1);
    mm('Step, light', 'circlePitchLight', 0.05, 20, 0.05);
    mm('Step, firm', 'circlePitchFirm', 0.05, 20, 0.05);
    note('How far each loop moves on - pressing harder overlaps them more.');
  } else if (b.type === 'rake') {
    count('Lines', 'tines', 2, 12);
    mm('Spacing', 'tineSpacing', 0.1, 20, 0.1, 'mm (doubles at full pressure)');
  } else if (b.type === 'sketchy') {
    count('Lines', 'sketchLines', 1, 5);
    mm('Wobble', 'wobble', 0, 5, 0.1);
   } else if (b.type === 'stars') {
    mm('Star size', 'starSize', 0.5, 100, 0.5, 'mm at full pressure');
    mm('Spacing', 'starSpacing', 0.5, 200, 0.5, 'mm between stars');
    field(panel, 'Style', choiceButtons([['outline', 'Outline'], ['pentagram', 'Pentagram']], b.starStyle === 'pentagram' ? 'pentagram' : 'outline',
      (value) => { b.starStyle = value; scheduleAutosave(); }));
    const tumble = document.createElement('input');
    tumble.type = 'checkbox';
    tumble.checked = b.starTumble;
    tumble.addEventListener('change', () => { b.starTumble = tumble.checked; scheduleAutosave(); });
    const tl = document.createElement('label');
    tl.className = 'check';
    tl.append(tumble, ' Upright, with a little random turn (off: point along the stroke)');
    panel.append(tl);
    note('Pressing harder makes bigger stars. A tap makes a single star.');
  }
  if (b.type !== 'pen' && $('live-mode').value === 'stream') note('Follow-as-I-draw uses the plain pen; brush strokes plot when you lift the stylus.');
}

function fitImage(layer) {
  const r = marginRect();
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  layer.w = Math.min(w, h / layer.aspect);
  // In drawing coordinates, so it lands centred on the paper with the current placement
  const inv = invert(placementMatrix());
  const [cx, cy] = apply(inv, doc.paper.w / 2, doc.paper.h / 2);
  layer.w /= placementScale();
  layer.x = +(cx - layer.w / 2).toFixed(2);
  layer.y = +(cy - (layer.w * layer.aspect) / 2).toFixed(2);
}

$('image-file').addEventListener('change', () => {
  const file = $('image-file').files[0];
  $('image-file').value = '';
  if (!file) return;
  let layer = selectedLayer();
  if (layer.kind !== 'image') {
    layer = doc.layers.find((l) => l.kind === 'image') || addLayer(imageLayer('Image'), true);
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      pushUndo();
      layer.src = reader.result;
      layer.aspect = img.naturalHeight / img.naturalWidth;
      images.set(layer.src, img);
      fitImage(layer);
      doc.selected = layer.id;
      changed(true);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// ---------- SVG import ----------
// Reads the lines out of an SVG (paths, lines, polylines, polygons, rectangles, circles, ellipses - with their
// transforms), in millimetres. Curves are followed in 0.2 mm steps. Text must be turned into paths first (Inkscape:
// Path > Object to Path); images and <use> copies are left out.
function readSVG(text) {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = parsed.documentElement;
  if (parsed.querySelector('parsererror') || root.nodeName.toLowerCase() !== 'svg') throw new Error("that isn't an SVG file");

  const unitMm = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };
  const length = (v) => {
    const m = /^\s*([\d.eE+-]+)\s*(mm|cm|in|pt|pc|px)?\s*$/.exec(v || '');
    return m ? parseFloat(m[1]) * unitMm[m[2] || ''] : null;
  };
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasViewBox = vb.length === 4 && vb.every(isFinite) && vb[2] > 0;
  const widthMm = length(root.getAttribute('width'));
  // Millimetres per user unit: from the width and viewBox if both are given, otherwise CSS pixels
  const mmPerUnit = hasViewBox && widthMm ? widthMm / vb[2] : 25.4 / 96;

  // Laid out off-screen, so the browser can measure the shapes and work out their transforms
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-20000px;top:0;width:10px;height:10px;overflow:hidden;opacity:0;pointer-events:none';
  const live = document.importNode(root, true);
  holder.append(live);
  document.body.append(holder);
  try {
    const toRoot = live.getScreenCTM().inverse();
    const ox = hasViewBox ? vb[0] : 0, oy = hasViewBox ? vb[1] : 0;
    const step = 0.2; // mm
    const paths = [];
    let skipped = 0, group = 0; // Lines from one element share a group, so they're erased together
    for (const el of live.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')) {
      if (el.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      let total = 0;
      try { total = el.getTotalLength(); } catch (error) { skipped++; continue; }
      if (!(total > 0)) continue;
      const m = toRoot.multiply(el.getScreenCTM());
      const toMm = (pt) => {
        const q = new DOMPoint(pt.x, pt.y).matrixTransform(m);
        return [(q.x - ox) * mmPerUnit, (q.y - oy) * mmPerUnit];
      };
      const unitsPerMm = 1 / (mmPerUnit * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1);
      const n = Math.min(50000, Math.max(2, Math.ceil(total / (step * unitsPerMm))));
      // Follow the shape, starting a new line wherever it jumps (a "move to" inside a path)
      let line = [];
      for (let i = 0; i <= n; i++) {
        const pt = toMm(el.getPointAtLength((total * i) / n));
        const last = line[line.length - 1];
        if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) > step * 4) { if (line.length > 1) paths.push({ group, pts: line }); line = []; }
        line.push(pt);
      }
      if (line.length > 1) paths.push({ group, pts: line });
      group++;
    }
    if (!paths.length) throw new Error(skipped ? 'none of its shapes could be read' : 'it has no lines or shapes (text needs converting to paths first)');
    const xs = paths.flatMap((p) => p.pts.map((q) => q[0])), ys = paths.flatMap((p) => p.pts.map((q) => q[1]));
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    for (const p of paths) p.pts = simplify(p.pts.map(([x, y]) => [x - x0, y - y0, 0]), 0.02);
    return { paths, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
  } finally {
    holder.remove();
  }
}

let pendingImport = null; // {name, svg, template} while the import panel is open

function templateLayer() {
  const layer = selectedLayer();
  return layer.kind === 'draw' ? layer : doc.layers.find((l) => l.kind === 'draw') || drawLayer('Drawing');
}

function openImportPanel(name, svg) {
  const template = templateLayer();
  const r = marginRect();
  const fitWidth = Math.min(r.x1 - r.x0, ((r.y1 - r.y0) * svg.width) / Math.max(svg.height, 1e-6));
  pendingImport = { name, svg, template, fitWidth };
  $('import-title').textContent = `Import ${name}`;
  $('import-summary').textContent = `${svg.paths.length} line${svg.paths.length === 1 ? '' : 's'}, ${svg.width.toFixed(1)} × ${svg.height.toFixed(1)} mm as saved.`;
  setImportWidth(svg.width > fitWidth ? fitWidth : svg.width);
  const brush = template.brush && template.brush.type !== 'pen';
  $('import-brush-label').hidden = !brush;
  $('import-brush').checked = false;
  if (brush) $('import-brush-text').textContent = `Draw it with the ${template.name} layer's brush (${BRUSH_TYPES[template.brush.type]})`;
  $('import-panel').hidden = false;
}
function setImportWidth(w) {
  const { svg } = pendingImport;
  w = clamp(w || svg.width, 1, 2000);
  $('import-width').value = +w.toFixed(1);
  $('import-height').textContent = svg.width > 0 ? `× ${((w * svg.height) / svg.width).toFixed(1)} mm` : '';
}

function placeImport() {
  const { name, svg, template } = pendingImport;
  const scale = (+$('import-width').value || svg.width) / (svg.width || 1);
  const pressure = +$('import-pressure').value / 100;
  const useBrush = !$('import-brush-label').hidden && $('import-brush').checked;
  // A layer of its own, with the template layer's pen settings, centred on the paper
  const layer = drawLayer(name.replace(/\.svg$/i, ''), {
    color: template.color, widthMm: template.widthMm, usePressure: template.usePressure, light: template.light, heavy: template.heavy,
    gamma: template.gamma, vary: false, speed: template.speed ?? null, sharpenCm: template.sharpenCm,
    brush: useBrush ? { ...template.brush } : defaultBrush(),
  });
  const inv = invert(placementMatrix());
  const cx = doc.paper.w / 2 - (svg.width * scale) / 2, cy = doc.paper.h / 2 - (svg.height * scale) / 2;
  const groups = new Map();
  for (const p of svg.paths) {
    const pts = p.pts.map(([x, y]) => [...apply(inv, cx + x * scale, cy + y * scale), pressure]);
    if (!groups.has(p.group)) groups.set(p.group, newId('g'));
    const group = groups.get(p.group);
    const lines = useBrush ? brushLines(layer, pts, group) : clipToDrawingArea([pts]);
    for (const line of lines) {
      layer.strokes.push({ id: newId('s'), group, plotted: false, pts: line.map(([x, y, q]) => [+x.toFixed(3), +y.toFixed(3), +q.toFixed(3)]) });
    }
  }
  closeImportPanel();
  if (!layer.strokes.length) { notice('Nothing of it lands inside the drawing area.'); return; }
  addLayer(layer);
  setTool('move');
  notice(`Placed "${layer.name}" on its own layer - drag it into place (arrow keys nudge), Duplicate for more copies.`);
}
function closeImportPanel() { pendingImport = null; $('import-panel').hidden = true; }

$('import-svg').addEventListener('click', () => $('svg-file').click());
$('svg-file').addEventListener('change', async () => {
  const file = $('svg-file').files[0];
  $('svg-file').value = '';
  if (!file) return;
  try { openImportPanel(file.name, readSVG(await file.text())); }
  catch (error) { notice(`Couldn't import ${file.name}: ${error.message}.`); }
});
$('import-width').addEventListener('change', () => setImportWidth(parseFloat($('import-width').value)));
$('import-natural').addEventListener('click', () => setImportWidth(pendingImport.svg.width));
$('import-fit').addEventListener('click', () => setImportWidth(pendingImport.fitWidth));
$('import-pressure').addEventListener('input', () => { $('import-pressure-value').textContent = `${$('import-pressure').value}%`; });
$('import-place').addEventListener('click', placeImport);
$('import-cancel').addEventListener('click', closeImportPanel);

function addLayer(layer, atBottom) {
  pushUndo();
  const index = atBottom ? doc.layers.length : Math.max(0, doc.layers.indexOf(selectedLayer()));
  doc.layers.splice(index, 0, layer);
  doc.selected = layer.id;
  changed(true);
  sendSettings();
  return layer;
}

// Moves a layer's contents by dx, dy drawing mm. Strokes are replaced rather than changed, so undo keeps the old ones,
// and moved strokes count as not plotted, since they're somewhere new.
// A copy of a stroke with fresh ids (brush strokes keep sharing a group), counted as not plotted
function withNewIds(st, groups, pts) {
  const copy = { id: newId('s'), plotted: false, pts };
  if (st.group) {
    if (!groups.has(st.group)) groups.set(st.group, newId('g'));
    copy.group = groups.get(st.group);
  }
  return copy;
}

function shiftLayer(layer, dx, dy) {
  if (!dx && !dy) return;
  if (layer.kind === 'image') { layer.x = +(layer.x + dx).toFixed(2); layer.y = +(layer.y + dy).toFixed(2); return; }
  const groups = new Map();
  layer.strokes = layer.strokes.map((st) => withNewIds(st, groups, st.pts.map(([x, y, p]) => [+(x + dx).toFixed(3), +(y + dy).toFixed(3), p])));
}

function duplicateLayer() {
  const layer = selectedLayer();
  const copy = layer.kind === 'image'
    ? { ...layer, id: newId('L'), name: `${layer.name} copy` }
    : { ...layer, id: newId('L'), name: `${layer.name} copy`, locked: false,
        brush: { ...layer.brush }, strokes: (() => { const groups = new Map(); return layer.strokes.map((st) => withNewIds(st, groups, st.pts.map((pt) => pt.slice()))); })() };
  addLayer(copy);
  setTool('move');
  notice(`Made "${copy.name}" - drag it with Move, or nudge it with the arrow keys.`);
}
$('layer-duplicate').addEventListener('click', duplicateLayer);

$('add-layer').addEventListener('click', () => addLayer(drawLayer(`Layer ${doc.layers.length + 1}`)));
$('add-image-layer').addEventListener('click', () => { addLayer(imageLayer('Image'), true); $('image-file').click(); });
$('layer-up').addEventListener('click', () => moveLayer(-1));
$('layer-down').addEventListener('click', () => moveLayer(1));
function moveLayer(step) {
  const i = doc.layers.indexOf(selectedLayer()), j = i + step;
  if (j < 0 || j >= doc.layers.length) return;
  pushUndo();
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
  changed(true);
}
$('layer-delete').addEventListener('click', () => {
  if (doc.layers.length < 2) return;
  const layer = selectedLayer();
  pushUndo();
  const i = doc.layers.indexOf(layer);
  doc.layers.splice(i, 1);
  doc.selected = doc.layers[Math.min(i, doc.layers.length - 1)].id;
  changed(true);
  notice(`Deleted "${layer.name}" - Undo (⌘Z) brings it back.`);
});
$('layer-clear').addEventListener('click', () => {
  const layer = selectedLayer();
  if (layer.kind !== 'draw' || !layer.strokes.length) return;
  pushUndo();
  layer.strokes = [];
  changed(true);
});

// Plotter settings sliders
const SETTING_KEYS = ['speed_pendown', 'speed_penup', 'accel', 'pen_rate_lower', 'pen_rate_raise', 'pen_delay_down', 'pen_pos_up'];
function syncSettingInputs() {
  for (const key of SETTING_KEYS) {
    $(key).value = doc.settings[key];
    document.querySelector(`.value[data-for="${key}"]`).textContent = key === 'pen_delay_down' ? `${doc.settings[key]} ms` : key === 'pen_pos_up' ? doc.settings[key] : `${doc.settings[key]}%`;
  }
  $('model').value = doc.settings.model;
  $('penlift').value = doc.settings.penlift;
  $('const-speed').checked = !!doc.settings.const_speed;
  $('height-cap').value = heightCap();
  $('test-height').max = heightCap();
  $('cap-warning').hidden = doc.settings.pen_pos_up < heightCap() || heightCap() >= 100;
}
for (const key of SETTING_KEYS) {
  $(key).addEventListener('input', () => {
    doc.settings[key] = key === 'pen_pos_up' ? Math.min(+$(key).value, heightCap()) : +$(key).value;
    syncSettingInputs(); sendSettings(); scheduleAutosave();
    if (key === 'speed_pendown') renderLayerProps();
  });
}
$('height-cap').addEventListener('change', () => {
  const v = parseFloat($('height-cap').value);
  if (!isNaN(v)) doc.settings.height_cap = clamp(Math.round(v), 0, 100);
  doc.settings.pen_pos_up = Math.min(doc.settings.pen_pos_up, heightCap());
  syncSettingInputs(); sendSettings(0); scheduleAutosave(); changed(true);
});
$('model').addEventListener('change', () => { doc.settings.model = +$('model').value; sendSettings(); scheduleAutosave(); });
$('const-speed').addEventListener('change', () => { doc.settings.const_speed = $('const-speed').checked ? 1 : 0; sendSettings(0); scheduleAutosave(); });
$('penlift').addEventListener('change', () => { doc.settings.penlift = +$('penlift').value; sendSettings(0); scheduleAutosave(); });

// Paper
function syncPaperInputs() {
  const p = doc.paper;
  $('paper-w').value = p.w; $('paper-h').value = p.h; $('paper-x').value = p.x; $('paper-y').value = p.y; $('paper-margin').value = p.margin;
  const preset = `${p.w}x${p.h}`;
  $('paper-preset').value = [...$('paper-preset').options].some((o) => o.value === preset) ? preset : 'custom';
}
$('paper-preset').addEventListener('change', () => {
  const v = $('paper-preset').value;
  if (v === 'custom') return;
  const [w, h] = v.split('x').map(Number);
  doc.paper.w = w; doc.paper.h = h;
  syncPaperInputs(); fit(); changed(false);
});
for (const [id, key, min, max] of [['paper-w', 'w', 10, 900], ['paper-h', 'h', 10, 900], ['paper-x', 'x', -100, 900], ['paper-y', 'y', -100, 900], ['paper-margin', 'margin', 0, 50]]) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    if (!isNaN(v)) doc.paper[key] = clamp(v, min, max);
    syncPaperInputs();
    if (key === 'w' || key === 'h') fit();
    changed(false);
  });
}

// Placement
function syncPlacementInputs() {
  const p = doc.placement;
  $('place-x').value = p.x; $('place-y').value = p.y; $('place-scale').value = p.scale; $('place-rotate').value = p.rotate;
}
for (const [id, key] of [['place-x', 'x'], ['place-y', 'y'], ['place-scale', 'scale'], ['place-rotate', 'rotate']]) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    if (isNaN(v)) return syncPlacementInputs();
    pushUndo();
    doc.placement[key] = key === 'scale' ? clamp(v, 1, 1000) : v;
    changed(true);
  });
}
$('place-reset').addEventListener('click', () => { pushUndo(); doc.placement = { x: 0, y: 0, scale: 100, rotate: 0 }; changed(true); });
$('place-centre').addEventListener('click', () => {
  // Centre the bounding box of everything drawn on the paper
  const m = placementMatrix();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of doc.layers) if (l.kind === 'draw') for (const s of l.strokes) for (const pt of s.pts) {
    const [x, y] = apply(m, pt[0], pt[1]);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x0 === Infinity) return;
  pushUndo();
  doc.placement.x = +(doc.placement.x + doc.paper.w / 2 - (x0 + x1) / 2).toFixed(2);
  doc.placement.y = +(doc.placement.y + doc.paper.h / 2 - (y0 + y1) / 2).toFixed(2);
  changed(true);
});

// Plotter buttons
async function connect(simulate) {
  $('connection').textContent = simulate ? 'Starting simulation…' : 'Connecting…';
  clearTimeout(settingsTimer);
  await api('settings', { settings: doc.settings, heightCap: heightCap(), sharpenEvery: sharpenAllowances() }); // So it connects with them
  await api('connect', { simulate });
  setTimeout(async () => onStatus(await (await fetch('/api/status')).json()), 300);
}
$('connect').addEventListener('click', () => connect(false));
$('simulate').addEventListener('click', () => connect(true));
$('disconnect').addEventListener('click', () => { pending.clear(); api('disconnect'); });
$('plot-layers').addEventListener('click', () => plotLayers(doc.layers.filter((l) => l.kind === 'draw' && l.plot)));
$('plot-current').addEventListener('click', () => plotLayers([selectedLayer()]));
$('pause').addEventListener('click', () => api('pause'));
$('resume').addEventListener('click', () => api('resume'));
$('stop').addEventListener('click', () => { pending.clear(); api('stop'); needsFrame = true; });
$('home').addEventListener('click', () => api('home'));
$('pen-down').addEventListener('click', () => {
  if (+$('test-height').value > heightCap()) { $('test-height').value = heightCap(); notice(`Test height capped at ${heightCap()}, the highest safe height.`); }
  if (requireConnection()) api('pen', { down: true, height: +$('test-height').value });
});
$('pen-up').addEventListener('click', () => api('pen', { down: false }));
$('use-test-height').addEventListener('click', () => {
  const layer = selectedLayer();
  if (layer.kind !== 'draw') { notice('Select a drawing layer first.'); return; }
  const h = Math.min(Math.round(+$('test-height').value * 10) / 10, heightCap());
  layer.heavy = h;
  changed(true);
  notice(layer.usePressure
    ? `${layer.name}: Firm is now ${h}. Light is ${layer.light}` + (layer.light - h > 8 ? ' - set it just above, where the tip first touches (Use as Light).' : '.')
    : `${layer.name} now draws at height ${h}.`);
});
$('use-test-light').addEventListener('click', () => {
  const layer = selectedLayer();
  if (layer.kind !== 'draw') { notice('Select a drawing layer first.'); return; }
  const h = Math.min(Math.round(+$('test-height').value * 10) / 10, heightCap());
  layer.light = h;
  layer.usePressure = true;
  changed(true);
  notice(`${layer.name}: Light is now ${h}, Firm ${layer.heavy}. Pressure sets the height between them.`);
});
$('banner-sharpened').addEventListener('click', () => api('resume', { sharpenedLayer: status.pauseLayer }));
$('banner-resume').addEventListener('click', () => api('resume'));
// Plotting mode buttons (a hidden input keeps the value where the rest of the app reads it)
document.querySelectorAll('#live-mode-choices button').forEach((b) => b.addEventListener('click', () => {
  $('live-mode').value = b.dataset.value;
  document.querySelectorAll('#live-mode-choices button').forEach((x) => x.classList.toggle('active', x === b));
  needsFrame = true;
  renderLayerProps();
}));
$('show-pace').addEventListener('change', () => { needsFrame = true; });
$('mark-unplotted').addEventListener('click', () => {
  for (const l of doc.layers) if (l.kind === 'draw') for (const s of l.strokes) s.plotted = false;
  changed(true);
});
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('fit').addEventListener('click', fit);
$('zoom-in').addEventListener('click', () => zoomBy(1.5));
$('rotate-left').addEventListener('click', () => rotateView(-Math.PI / 12));
$('rotate-right').addEventListener('click', () => rotateView(Math.PI / 12));
$('rotation').addEventListener('click', () => setViewRotation(0));
function toggleDepthView() {
  depthView = !depthView;
  $('depth-view').classList.toggle('active', depthView);
  sceneDirty = true;
}
$('depth-view').addEventListener('click', toggleDepthView);
function setEraserWidth(mm) {
  doc.eraserWidth = Math.round(clamp(mm, 0.5, 50) * 10) / 10;
  $('eraser-width').value = doc.eraserWidth;
  needsFrame = true;
  scheduleAutosave();
}
// A row of buttons to pick one of several values (instead of a drop-down)
function choiceButtons(options, current, onPick, className = '') {
  const row = document.createElement('div');
  row.className = `choices ${className}`;
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.value = value;
    b.classList.toggle('active', value === current);
    b.addEventListener('click', () => {
      row.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      onPick(value);
    });
    row.append(b);
  }
  return row;
}
let shapeKind = 'line';
// Whether a stroke is drawn with its layer's brush: always for freehand; for shapes only if asked for
function usesBrush(d) {
  const b = d.layer.brush;
  return !!b && b.type !== 'pen' && (!d.shape || doc.shapeUsesBrush);
}
function syncShapeBrushChoice() {
  const layer = selectedLayer();
  const brush = layer.kind === 'draw' && layer.brush && layer.brush.type !== 'pen' ? BRUSH_TYPES[layer.brush.type].split(' - ')[0].replace(/ \(.*\)/, '') : null;
  const holder = $('shape-brush');
  holder.innerHTML = '';
  if (!brush) { holder.textContent = 'Plain outline'; holder.title = "The selected layer's brush is the plain pen"; return; }
  holder.title = '';
  holder.append(choiceButtons([['plain', 'Plain outline'], ['brush', `With layer brush (${brush})`]], doc.shapeUsesBrush ? 'brush' : 'plain',
    (value) => { doc.shapeUsesBrush = value === 'brush'; scheduleAutosave(); }));
}
$('shape-kind').replaceWith(choiceButtons([['line', 'Line'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['polygon', 'Polygon']], shapeKind,
  (value) => { shapeKind = value; $('shape-sides-label').hidden = value !== 'polygon'; }));
function eraserModeButtons() {
  const row = choiceButtons([['whole', 'Whole strokes'], ['part', 'Only what it touches']], doc.eraserMode || 'whole',
    (value) => { doc.eraserMode = value; scheduleAutosave(); });
  row.id = 'eraser-mode';
  row.title = 'Whole strokes: anything it touches goes (a brush stroke as a group). Only what it touches: cuts out just the part under the eraser.';
  return row;
}
$('eraser-mode').replaceWith(eraserModeButtons());
$('eraser-width').addEventListener('change', () => { const v = parseFloat($('eraser-width').value); setEraserWidth(isNaN(v) ? eraserWidth() : v); });

function syncSmoothing() {
  $('eraser-width').value = eraserWidth();
  $('eraser-mode').replaceWith(eraserModeButtons());
  $('smoothing').value = doc.smoothing || 0;
  $('smoothing-value').textContent = doc.smoothing ? `${doc.smoothing}%` : 'off';
}
$('smoothing').addEventListener('input', () => { doc.smoothing = +$('smoothing').value; syncSmoothing(); scheduleAutosave(); });

$('zoom-out').addEventListener('click', () => zoomBy(1 / 1.5));

// ---------- Files ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

function saveFile() { download(`drawing-${stamp()}.axlive.json`, JSON.stringify(doc), 'application/json'); }
$('save').addEventListener('click', saveFile);
$('load').addEventListener('click', () => $('load-file').click());
$('load-file').addEventListener('change', async () => {
  const file = $('load-file').files[0];
  $('load-file').value = '';
  if (!file) return;
  try {
    loadDocument(JSON.parse(await file.text()));
    undoStack.length = redoStack.length = 0;
  } catch (error) {
    notice(`Couldn't open that file: ${error.message}`);
  }
});

function loadDocument(data) {
  if (!data || !Array.isArray(data.layers) || !data.paper) throw new Error('not an AxiDraw Live drawing');
  const fresh = newDocument();
  doc = { ...fresh, ...data, paper: { ...fresh.paper, ...data.paper }, placement: { ...fresh.placement, ...data.placement }, settings: { ...fresh.settings, ...data.settings } };
  doc.layers = data.layers.map((l) => (l.kind === 'image' ? { ...imageLayer(l.name), ...l } : { ...drawLayer(l.name), ...l, strokes: l.strokes || [], brush: { ...defaultBrush(), ...(l.brush || {}) } }));
  // Drawings from before layers could follow the Speed & Pen setting: their layers now follow it
  if (!data.speedFollowsSetting) for (const l of doc.layers) if (l.kind === 'draw') l.speed = null;
  doc.speedFollowsSetting = true;
  if (!layerById(doc.selected)) doc.selected = doc.layers[0].id;
  pending.clear();
  syncSettingInputs(); syncPaperInputs(); syncSmoothing(); fit(); changed(true); sendSettings();
}

// AxiDraw SVG: one Inkscape layer per drawing layer and pen height (layer names like "3+H32+S15 Shading"), with a
// pause ("!") wherever the layer's pencil needs sharpening. Paper coordinates, in millimetres.
function exportSVG() {
  const m = placementMatrix();
  const out = [];
  let number = 1, layerCount = 0;
  for (const layer of doc.layers.slice().reverse()) {
    if (layer.kind !== 'draw' || !layer.plot || !layer.strokes.length) continue;
    const byHeight = new Map();
    for (const stroke of layer.strokes) {
      const h = Math.round(heightFor(layer, strokePressure(stroke)));
      for (const piece of strokeToPlot(layer, stroke, m)) {
        if (!byHeight.has(h)) byHeight.set(h, []);
        byHeight.get(h).push(piece.map(([x, y]) => [x - doc.paper.x, y - doc.paper.y]));
      }
    }
    const allowance = (layer.sharpenCm || 0) * 10;
    let used = 0;
    for (const h of [...byHeight.keys()].sort((a, b) => b - a)) { // Lightest first
      let part = [], pause = false;
      const flush = () => {
        if (!part.length) return;
        const label = `${pause ? '!' : ''}${number++}+H${h}+S${layerSpeed(layer)} ${layer.name} H${h}`;
        const paths = part.map((pts) => `<path d="M${pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join(' L')}"/>`).join('\n');
        out.push(`<g inkscape:groupmode="layer" inkscape:label="${escapeXml(label)}" id="layer${number}" fill="none" stroke="${layer.color}" stroke-width="${layer.widthMm}" stroke-linecap="round" stroke-linejoin="round">\n${paths}\n</g>`);
        layerCount++;
        part = [];
      };
      for (const pts of byHeight.get(h)) {
        const len = polylineLength(pts);
        if (allowance > 0 && used > 0 && used + len > allowance) { flush(); pause = true; used = 0; }
        part.push(pts);
        used += len;
      }
      flush();
      pause = false;
    }
  }
  if (!layerCount) { notice('Nothing to export - no drawing layers with Plot ticked have strokes.'); return; }
  const { w, h } = doc.paper;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
${out.join('\n')}
</svg>
`;
  download(`drawing-${stamp()}.svg`, svg, 'image/svg+xml');
}
const escapeXml = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
$('export-svg').addEventListener('click', exportSVG);

// Autosave, so a closed tab doesn't lose a drawing. It goes into the browser's database storage (IndexedDB), which
// has room for imported images; the small localStorage area (about 5 MB) gets a copy without them, as a fallback.
let autosaveTimer = 0;
let startupDone = false; // Nothing is saved until the saved drawing has been loaded, so it can't be overwritten
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    if (!startupDone) return;
    const text = JSON.stringify(doc);
    try { await storeSet('doc', text); }
    catch (error) { notice("Couldn't autosave the drawing in the browser - use Save to keep a copy."); }
    try { localStorage.setItem('axidraw-live', JSON.stringify({ ...doc, layers: doc.layers.map((l) => (l.kind === 'image' ? { ...l, src: null } : l)) })); }
    catch (ignored) { /* Storage unavailable */ }
  }, 1500);
}

function openStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('axidraw-live', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storeSet(key, value) {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function storeGet(key) {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction('kv').objectStore('kv').get(key);
    request.onsuccess = () => { db.close(); resolve(request.result); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}

// ---------- Start ----------

new ResizeObserver(() => { resize(); if (viewFitted) fit(); needsFrame = true; }).observe($('stage'));
window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); needsFrame = true; });
resize();
(async () => {
  // The full autosave (with images) if there is one, otherwise the older, image-less copy
  let saved = null;
  try { saved = await storeGet('doc'); } catch (error) { /* No database storage */ }
  try { saved = saved || localStorage.getItem('axidraw-live'); } catch (error) { /* No storage */ }
  try { if (saved) loadDocument(JSON.parse(saved)); } catch (error) { notice("Couldn't restore the last drawing."); }
  startupDone = true;
  syncSettingInputs(); syncPaperInputs(); syncPlacementInputs(); syncSmoothing();
  fit();
  changed(true);
  pollStatus();
  requestAnimationFrame(frame);
})();
