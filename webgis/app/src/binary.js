// Loads per-day .bin files (see webgis/preprocess/preprocess.mjs for layout)
// and exposes typed-array views suitable for deck.gl binary attributes.

const HEADER_SIZE = 64;
const RECORD_SIZE = 20;
const MAGIC = 0x424f5250; // 'PROB' as u32 LE

export async function fetchMeta() {
  const [meta, vehicles] = await Promise.all([
    fetch('data/meta.json').then((r) => {
      if (!r.ok) throw new Error('meta.json not found — run the preprocessor first.');
      return r.json();
    }),
    fetch('data/vehicles.json').then((r) => r.ok ? r.json() : []),
  ]);
  return { meta, vehicles };
}

export async function loadDay(date, onProgress) {
  const url = `data/${date}.bin`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch ${url}: ${resp.status}`);

  // Stream with progress when content-length is known
  const total = +resp.headers.get('content-length') || 0;
  let received = 0;
  const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  let arrayBuffer;
  if (reader) {
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress && onProgress(received, total);
    }
    const combined = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { combined.set(c, off); off += c.byteLength; }
    arrayBuffer = combined.buffer;
  } else {
    arrayBuffer = await resp.arrayBuffer();
  }

  const dv = new DataView(arrayBuffer);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) throw new Error('bad magic in ' + url);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error('unsupported version ' + version);
  const count = dv.getUint32(8, true);
  const dateYmd = dv.getUint32(12, true);
  // Header tMin/tMax span the *records actually present* (which can leak a day
  // or two on either side of the file date due to cache/stale-probe outliers).
  // We deliberately ignore them for display: the slider should expose just the
  // file date in GMT+7, since outside that window there's effectively no data.
  // Off-day records still live in the binary but become unreachable because
  // their `times[]` offset falls outside [0, 86399].
  const _tMinHdr = dv.getUint32(16, true);
  const _tMaxHdr = dv.getUint32(20, true);
  const yyyy = Math.floor(dateYmd / 10000);
  const mm   = Math.floor((dateYmd / 100) % 100);
  const dd   = dateYmd % 100;
  const tMin = Date.UTC(yyyy, mm - 1, dd) / 1000 - 7 * 3600; // 00:00:00 GMT+7
  const tMax = tMin + 86400 - 1;                              // 23:59:59 GMT+7
  const vehicleCount = dv.getUint32(24, true);
  const minLon = dv.getFloat32(28, true);
  const minLat = dv.getFloat32(32, true);
  const maxLon = dv.getFloat32(36, true);
  const maxLat = dv.getFloat32(40, true);

  // Records section: zero-copy strided views over the same ArrayBuffer.
  const recordsBuffer = arrayBuffer; // we keep header offset for stride math
  // For ScatterplotLayer's binary getPosition, we want a Float32Array view that
  // covers the records section. The record stride is 20 bytes; lon/lat occupy
  // bytes 0..7 of each record (Float32 * 2). Browsers require the typed-array
  // byteOffset to be 4-byte aligned; HEADER_SIZE=64 is.
  const recordsBytes = count * RECORD_SIZE;
  const positionsView = new Float32Array(arrayBuffer, HEADER_SIZE, recordsBytes / 4);
  // Bytes 12..15 of each record (speed, heading_div2, flags, _pad).
  const u8View = new Uint8Array(arrayBuffer, HEADER_SIZE, recordsBytes);
  // Bytes 8..11 of each record = u32 timestamp; bytes 16..19 = u32 vid.
  const u32View = new Uint32Array(arrayBuffer, HEADER_SIZE, recordsBytes / 4);

  // Time as Float32 offset from tMin (so ranges fit precisely in fp32).
  const times = new Float32Array(count);
  for (let i = 0; i < count; i++) times[i] = u32View[i * 5 + 2] - tMin;

  return {
    arrayBuffer,
    date: dateYmd,
    count,
    tMin,
    tMax,
    bbox: [minLon, minLat, maxLon, maxLat],
    vehicleCount,
    // Strided views for direct GPU attribute use
    positionsView,
    u8View,
    u32View,
    // Pre-computed
    times,
  };
}

// Build per-record color array for the active "color by" mode.
// `speedMax` (km/h) sets the upper bound of the speed gradient (driven by the
// "speed ≤" UI slider). Records faster than that just clamp to the top color.
// Returns a freshly allocated Uint8Array of length count*4 (RGBA).
export function buildColors(day, mode, speedMax = 120) {
  const { count, u8View } = day;
  const out = new Uint8Array(count * 4);
  if (mode === 'speed') {
    const denom = Math.max(1, speedMax);
    for (let i = 0; i < count; i++) {
      const sp = u8View[i * RECORD_SIZE + 12]; // 0..255
      // Red (slow / congested) → blue (fast / free flow), up to `speedMax` km/h.
      // Conventional traffic-engineering palette.
      const t = Math.min(1, sp / denom);
      const r = ((1 - t) * 230) | 0;
      const g = (Math.max(0, 1 - Math.abs(t - 0.5) * 2) * 180 + 40) | 0;
      const b = (t * 240) | 0;
      const o = i * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 220;
    }
  } else if (mode === 'heading') {
    for (let i = 0; i < count; i++) {
      const h2 = u8View[i * RECORD_SIZE + 13]; // 0..180 = heading/2
      const ang = (h2 * 2) % 360;
      // hsv hue
      const c = hsvToRgb(ang / 360, 0.85, 1.0);
      const o = i * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 220;
    }
  } else if (mode === 'forhire') {
    // bit0 of flags
    for (let i = 0; i < count; i++) {
      const f = u8View[i * RECORD_SIZE + 14];
      const on = f & 1;
      const o = i * 4;
      if (on) { out[o] = 255; out[o + 1] = 184; out[o + 2] = 78; out[o + 3] = 230; }
      else    { out[o] =  78; out[o + 1] = 163; out[o + 2] = 255; out[o + 3] = 200; }
    }
  } else if (mode === 'engine') {
    // bit1 of flags
    for (let i = 0; i < count; i++) {
      const f = u8View[i * RECORD_SIZE + 14];
      const on = f & 2;
      const o = i * 4;
      if (on) { out[o] = 110; out[o + 1] = 255; out[o + 2] = 140; out[o + 3] = 220; }
      else    { out[o] = 200; out[o + 1] =  80; out[o + 2] =  80; out[o + 3] = 200; }
    }
  }
  return out;
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [(r * 255) | 0, (g * 255) | 0, (b * 255) | 0];
}

// Extract a single vehicle's path, sorted by time ascending. Used by TripsLayer.
export function extractVehiclePath(day, vid) {
  const { count, u8View, u32View, positionsView } = day;
  const points = [];
  for (let i = 0; i < count; i++) {
    if (u32View[i * 5 + 4] !== vid) continue;
    points.push({
      lon: positionsView[i * 5],
      lat: positionsView[i * 5 + 1],
      t:   u32View[i * 5 + 2],
      sp:  u8View[i * RECORD_SIZE + 12],
    });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

export const RECORD_SIZE_EXPORT = RECORD_SIZE;
