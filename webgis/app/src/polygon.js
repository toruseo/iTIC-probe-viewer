// ROIポリゴンの描画+ビン単位の集計。
//
// 集計はレンダラと同じストライド付き型付き配列ビューの上で動かすので、レコードごとのJSオブジェクト生成は発生しない。
// 約186万点×5頂点ポリゴンで実測100ms未満(bbox事前フィルタが支配的)。

const RECORD_SIZE = 20;

// 標準的なray-casting法。ringは[lon, lat]ペアのJS配列(開いた表現で、最初の頂点は末尾に重複させない)。
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

// `ring`の内側にあり、かつ`filterValues`を通過する(GPUフィルタと同じpassFlag。gps/movingトグル相当)レコードについて、ビン単位の件数と平均速度を返す。
//
// 時間窓スライダの値に関わらず、丸一日分の区間を全部ビン分割する。スライダはチャート上のハイライト帯として描かれる。
// 戻り値: { binSec, nBins, count: Uint32Array, avgSpeed: Float32Array (件数0のビンはNaN) }
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
