// ROI polygon drawing + per-bin aggregation.
//
// Aggregation runs on the same strided typed-array views the renderer uses,
// so there is no per-record JS object churn. ~1.86M points × 5-vertex polygon
// is sub-100ms in practice (bbox prefilter dominates).

const RECORD_SIZE = 20;

// Standard ray-casting; ring is a JS array of [lon, lat] pairs (open — first
// vertex not duplicated at the end).
export function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function ringBbox(ring) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const lo = ring[i][0], la = ring[i][1];
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
  }
  return [minLon, minLat, maxLon, maxLat];
}

// Per-bin count + mean speed for records inside `ring` that pass `filterValues`
// (the same passFlag used by the GPU filter — gps/moving toggles).
//
// The full day span is binned regardless of the time-window slider; the slider
// is rendered as a highlight band on the chart instead. Returns:
//   { binSec, nBins, count: Uint32Array, avgSpeed: Float32Array (NaN where count=0) }
export function aggregateInPolygon(day, ring, filterValues, binSec = 60) {
  const { count, positionsView, u8View, times, tMin, tMax } = day;
  const span = tMax - tMin;
  const nBins = Math.floor(span / binSec) + 1;
  const cnt = new Uint32Array(nBins);
  const sumSp = new Float64Array(nBins);
  if (!ring || ring.length < 3) {
    const avg = new Float32Array(nBins);
    for (let b = 0; b < nBins; b++) avg[b] = NaN;
    return { binSec, nBins, count: cnt, avgSpeed: avg };
  }

  const [minLon, minLat, maxLon, maxLat] = ringBbox(ring);

  for (let i = 0; i < count; i++) {
    const p = filterValues[i * 2 + 1];
    if (p < 0.5) continue;
    const lon = positionsView[i * 5];
    const lat = positionsView[i * 5 + 1];
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (!pointInPolygon(lon, lat, ring)) continue;
    const t = times[i];
    if (t < 0 || t >= span) continue;
    const b = (t / binSec) | 0;
    if (b >= nBins) continue;
    cnt[b]++;
    sumSp[b] += u8View[i * RECORD_SIZE + 12];
  }
  const avg = new Float32Array(nBins);
  for (let b = 0; b < nBins; b++) avg[b] = cnt[b] > 0 ? sumSp[b] / cnt[b] : NaN;
  return { binSec, nBins, count: cnt, avgSpeed: avg };
}
