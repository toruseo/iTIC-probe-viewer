// 日次の.binファイルを読み込み、deck.glのバイナリ属性に直接渡せる型付き配列ビューを公開する。バイナリ仕様はwebgis/preprocess/preprocess.mjsを参照。

const HEADER_SIZE = 64;
const RECORD_SIZE = 20;
const MAGIC = 0x424f5250; // 'PROB'をu32 LEで表したもの

// データ取得元のベースURL。空ならVite dev serverやローカルプレビューのために `data/` 相対へフォールバックする。
// GitHub Pagesビルドではpages.ymlがGitHub ReleasesのアセットURL(末尾スラッシュ付き)を注入する。
// VITE_DATA_VERSIONはCDNキャッシュバスティング用のクエリ文字列(例: コミットSHA)。
const DATA_BASE = (import.meta.env.VITE_DATA_BASE || 'data/');
const DATA_VERSION = import.meta.env.VITE_DATA_VERSION || '';
const VQ = DATA_VERSION ? `?v=${encodeURIComponent(DATA_VERSION)}` : '';

export async function fetchMeta() {
  const [meta, vehicles] = await Promise.all([
    fetch(`${DATA_BASE}meta.json${VQ}`).then((r) => {
      if (!r.ok) throw new Error('meta.json not found — run the preprocessor first.');
      return r.json();
    }),
    fetch(`${DATA_BASE}vehicles.json${VQ}`).then((r) => r.ok ? r.json() : []),
  ]);
  return { meta, vehicles };
}

export async function loadDay(date, onProgress) {
  const url = `${DATA_BASE}${date}.bin${VQ}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch ${url}: ${resp.status}`);

  // content-lengthが分かっていれば進捗を出しつつストリーム読み込みする
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
  // ヘッダのtMin/tMaxは「実際に存在するレコード」の範囲だが、キャッシュや古いprobeの混入でファイル日付の前後に数日漏れていることがある。
  // 表示用には採用せず、スライダはあくまでGMT+7のファイル日付の24時間枠だけを露出する(それ以外の時間帯には実用的にデータがほぼ無いため)。
  // 日付外のレコードはバイナリには残るが、`times[]`のオフセットが[0, 86399]の外に落ちるのでフィルタを通って画面には出てこない。
  const _tMinHdr = dv.getUint32(16, true);
  const _tMaxHdr = dv.getUint32(20, true);
  const yyyy = Math.floor(dateYmd / 10000);
  const mm   = Math.floor((dateYmd / 100) % 100);
  const dd   = dateYmd % 100;
  const tMin = Date.UTC(yyyy, mm - 1, dd) / 1000 - 7 * 3600; // GMT+7で00:00:00
  const tMax = tMin + 86400 - 1;                              // GMT+7で23:59:59
  const vehicleCount = dv.getUint32(24, true);
  const minLon = dv.getFloat32(28, true);
  const minLat = dv.getFloat32(32, true);
  const maxLon = dv.getFloat32(36, true);
  const maxLat = dv.getFloat32(40, true);

  // レコード部はゼロコピーで同じArrayBuffer上にストライド付きビューを張る。
  const recordsBuffer = arrayBuffer; // ストライド計算のためにヘッダのオフセットを保持
  // ScatterplotLayerのbinary getPositionには、レコード部全体をカバーするFloat32Arrayビューを渡す。
  // レコード長は20バイトで、各レコード先頭の0..7バイトにlon/lat (Float32×2)が入る。ブラウザは型付き配列のbyteOffsetが4バイト境界に揃っていることを要求するが、HEADER_SIZE=64は条件を満たす。
  const recordsBytes = count * RECORD_SIZE;
  const positionsView = new Float32Array(arrayBuffer, HEADER_SIZE, recordsBytes / 4);
  // 各レコードの12..15バイト(speed, heading_div2, flags, _pad)。
  const u8View = new Uint8Array(arrayBuffer, HEADER_SIZE, recordsBytes);
  // 各レコードの8..11バイト=u32 timestamp、16..19バイト=u32 vid。
  const u32View = new Uint32Array(arrayBuffer, HEADER_SIZE, recordsBytes / 4);

  // 時刻はtMinからのオフセットをFloat32で持つ(こうすればfp32で精度ロスなく範囲が収まる)。
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
    // GPU属性に直接渡せるストライド付きビュー
    positionsView,
    u8View,
    u32View,
    // 事前計算済みの時刻配列
    times,
  };
}

// 現在の"color by"モードに対応するレコード単位の色配列を作る。
// `speedMax` (km/h)は速度グラデーションの上限("speed ≤"UIスライダで制御)で、これを超える速度のレコードは上端色にクランプされる。
// 戻り値はcount*4バイト(RGBA)のUint8Array。
export function buildColors(day, mode, speedMax = 120) {
  const { count, u8View } = day;
  const out = new Uint8Array(count * 4);
  if (mode === 'speed') {
    const denom = Math.max(1, speedMax);
    for (let i = 0; i < count; i++) {
      const sp = u8View[i * RECORD_SIZE + 12]; // 0..255
      // 赤(低速・混雑)→青(高速・自由流)のグラデーション。上限は`speedMax` km/h。交通工学で慣用されるパレット。
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
      // HSVの色相
      const c = hsvToRgb(ang / 360, 0.85, 1.0);
      const o = i * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 220;
    }
  } else if (mode === 'forhire') {
    // flagsのbit0
    for (let i = 0; i < count; i++) {
      const f = u8View[i * RECORD_SIZE + 14];
      const on = f & 1;
      const o = i * 4;
      if (on) { out[o] = 255; out[o + 1] = 184; out[o + 2] = 78; out[o + 3] = 230; }
      else    { out[o] =  78; out[o + 1] = 163; out[o + 2] = 255; out[o + 3] = 200; }
    }
  } else if (mode === 'engine') {
    // flagsのbit1
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

// 単一車両の軌跡を時刻昇順で抽出する。TripsLayerで使用。
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
