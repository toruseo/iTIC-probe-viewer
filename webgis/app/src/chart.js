// Minimal canvas time-series chart. No deps.
//
// drawTimeSeries(canvas, values, opts):
//   binSec     — seconds per bin (drives x-axis hour ticks)
//   tMin       — unix seconds at bin 0 (only used if highlight is set)
//   yMin/yMax  — explicit y-range, or null for auto
//   color      — '#rrggbb' stroke (and translucent fill if opts.fill)
//   fill       — fill area below the line
//   highlight  — { tStart, tEnd } unix seconds — translucent vertical band
//
// NaN entries break the line into segments (used for avg speed where empty
// bins should leave a gap rather than dive to 0).

export function drawTimeSeries(canvas, values, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 240;
  const cssH = canvas.clientHeight || 70;
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 32, padR = 4, padT = 4, padB = 14;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;

  ctx.fillStyle = 'rgba(20, 24, 33, 0.92)';
  ctx.fillRect(0, 0, cssW, cssH);

  const n = values.length;
  if (n === 0 || w <= 0 || h <= 0) return;

  let yMin = opts.yMin, yMax = opts.yMax;
  if (yMin == null || yMax == null) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    if (yMin == null) yMin = Math.min(0, lo);
    if (yMax == null) yMax = Math.max(yMin + 1, hi * 1.05);
  }
  if (yMax === yMin) yMax = yMin + 1;

  const xToPx = (i) => padL + (i / Math.max(1, n - 1)) * w;
  const yToPx = (v) => padT + h - ((v - yMin) / (yMax - yMin)) * h;

  if (opts.highlight && opts.tMin != null && opts.binSec) {
    const span = (n - 1) * opts.binSec;
    const sFrac = clamp01((opts.highlight.tStart - opts.tMin) / span);
    const eFrac = clamp01((opts.highlight.tEnd   - opts.tMin) / span);
    const x1 = padL + sFrac * w;
    const x2 = padL + eFrac * w;
    if (x2 - x1 > 0.5) {
      ctx.fillStyle = 'rgba(78, 163, 255, 0.18)';
      ctx.fillRect(x1, padT, x2 - x1, h);
    }
  }

  ctx.font = '9px ui-monospace, "SFMono-Regular", Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const frac of [0, 0.5, 1]) {
    const v = yMin + frac * (yMax - yMin);
    const y = yToPx(v);
    ctx.strokeStyle = 'rgba(133, 144, 168, 0.22)';
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + w, y);
    ctx.stroke();
    ctx.fillStyle = '#8590a8';
    const lbl = opts.formatY ? opts.formatY(v) : Math.round(v).toLocaleString();
    ctx.fillText(lbl, padL - 3, y);
  }

  if (opts.binSec) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const span = (n - 1) * opts.binSec;
    for (let hh = 0; hh <= 24; hh += 6) {
      const sec = hh * 3600;
      if (sec > span) break;
      const x = padL + (sec / span) * w;
      ctx.strokeStyle = 'rgba(133, 144, 168, 0.12)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + h);
      ctx.stroke();
      ctx.fillStyle = '#8590a8';
      ctx.fillText(`${hh}h`, x, padT + h + 2);
    }
  }

  const color = opts.color || '#4ea3ff';

  if (opts.fill) {
    ctx.fillStyle = color + '40';
    ctx.beginPath();
    ctx.moveTo(xToPx(0), yToPx(yMin));
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const vv = Number.isFinite(v) ? v : yMin;
      ctx.lineTo(xToPx(i), yToPx(vv));
    }
    ctx.lineTo(xToPx(n - 1), yToPx(yMin));
    ctx.closePath();
    ctx.fill();
  }

  ctx.lineWidth = 1.2;
  ctx.strokeStyle = color;
  ctx.beginPath();
  let drawing = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { drawing = false; continue; }
    if (!drawing) { ctx.moveTo(xToPx(i), yToPx(v)); drawing = true; }
    else          { ctx.lineTo(xToPx(i), yToPx(v)); }
  }
  ctx.stroke();
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Scatter plot for MFD-style diagrams (xs, ys typed arrays of same length).
// NaN entries are skipped. opts:
//   xLabel, yLabel      — axis captions
//   xMin/xMax/yMin/yMax — explicit ranges (else auto, padded)
//   colorFn(i)          — per-point fill color string (e.g. 'hsl(...)')
//                         used to encode time-of-day along the day
//   pointSize           — default 2.5 (CSS px)
//   connect             — true to draw a thin polyline in array order
//                         (useful to read MFD hysteresis)
export function drawScatter(canvas, xs, ys, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 240;
  const cssH = canvas.clientHeight || 130;
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw; canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 38, padR = 6, padT = 6, padB = 22;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;

  ctx.fillStyle = 'rgba(20, 24, 33, 0.92)';
  ctx.fillRect(0, 0, cssW, cssH);

  const n = Math.min(xs.length, ys.length);
  if (n === 0 || w <= 0 || h <= 0) return;

  // auto-range
  let xmin = opts.xMin, xmax = opts.xMax, ymin = opts.yMin, ymax = opts.yMax;
  let lox = Infinity, hix = -Infinity, loy = Infinity, hiy = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < lox) lox = x; if (x > hix) hix = x;
    if (y < loy) loy = y; if (y > hiy) hiy = y;
  }
  if (lox === Infinity) { lox = 0; hix = 1; loy = 0; hiy = 1; }
  if (xmin == null) xmin = Math.min(0, lox);
  if (xmax == null) xmax = Math.max(xmin + 1, hix * 1.05);
  if (ymin == null) ymin = Math.min(0, loy);
  if (ymax == null) ymax = Math.max(ymin + 1, hiy * 1.05);

  const xToPx = (v) => padL + ((v - xmin) / (xmax - xmin)) * w;
  const yToPx = (v) => padT + h - ((v - ymin) / (ymax - ymin)) * h;

  // grid + tick labels
  ctx.font = '9px ui-monospace, "SFMono-Regular", Menlo, monospace';
  ctx.fillStyle = '#8590a8';
  ctx.strokeStyle = 'rgba(133, 144, 168, 0.18)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const frac of [0, 0.5, 1]) {
    const v = ymin + frac * (ymax - ymin);
    const y = yToPx(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.fillText(formatTick(v), padL - 3, y);
  }
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const frac of [0, 0.5, 1]) {
    const v = xmin + frac * (xmax - xmin);
    const x = xToPx(v);
    ctx.strokeStyle = 'rgba(133, 144, 168, 0.12)';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
    ctx.fillStyle = '#8590a8';
    ctx.fillText(formatTick(v), x, padT + h + 2);
  }

  // axis labels
  ctx.fillStyle = '#8590a8';
  if (opts.xLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.xLabel, padL + w / 2, cssH - 1);
  }
  if (opts.yLabel) {
    ctx.save();
    ctx.translate(8, padT + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }

  // optional connecting polyline
  if (opts.connect) {
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = 'rgba(216, 222, 240, 0.25)';
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) { drawing = false; continue; }
      const px = xToPx(x), py = yToPx(y);
      if (!drawing) { ctx.moveTo(px, py); drawing = true; }
      else          { ctx.lineTo(px, py); }
    }
    ctx.stroke();
  }

  // points
  const r = opts.pointSize || 2.5;
  const colorFn = opts.colorFn;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    ctx.fillStyle = colorFn ? colorFn(i) : '#4ea3ff';
    ctx.beginPath();
    ctx.arc(xToPx(x), yToPx(y), r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function formatTick(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  if (a >= 10)  return Math.round(v).toString();
  if (a > 0)    return v.toFixed(1);
  return '0';
}
