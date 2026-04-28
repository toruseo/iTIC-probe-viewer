import { ScatterplotLayer, PathLayer, PolygonLayer } from '@deck.gl/layers';
import { HeatmapLayer, HexagonLayer } from '@deck.gl/aggregation-layers';
import { DataFilterExtension } from '@deck.gl/extensions';

const RECORD_SIZE = 20;

export function buildLayers(state) {
  const { day, ui, colors, filterValues, selectedVehiclePath, polygon } = state;
  const layers = [];
  if (!day) return layers;

  const { count, positionsView, tMin } = day;

  // filterValues = Float32Array(count*2): [time_offset_sec, passFlag(0|1)]
  // filterRange = [[tStart, tEnd], [0.5, 1.5]] でGPU側がインタリーブ判定する。
  const tStart = ui.tStartUnix - tMin;
  const tEnd   = ui.tEndUnix   - tMin;

  if (ui.layers.points) {
    layers.push(new ScatterplotLayer({
      id: 'points',
      data: {
        length: count,
        attributes: {
          getPosition:    { value: positionsView, size: 2, stride: RECORD_SIZE, offset: 0 },
          getFillColor:   { value: colors,        size: 4 },
          getFilterValue: { value: filterValues,  size: 2 },
        },
      },
      pickable: true,
      stroked: false,
      filled: true,
      radiusUnits: 'pixels',
      getRadius: ui.pointSize,
      radiusMinPixels: 0.5,
      radiusMaxPixels: 50,
      filterRange: [[tStart, tEnd], [0.5, 1.5]],
      filterEnabled: true,
      extensions: [new DataFilterExtension({ filterSize: 2 })],
    }));
  }

  if (ui.layers.heatmap || ui.layers.heatmapAvgSpeed || ui.layers.hexagon || ui.layers.headingHex) {
    const { positions: visiblePositions, speeds: visibleSpeeds, headings: visibleHeadings } =
      filterPositionsAndSpeeds(day, filterValues, tStart, tEnd);
    if (ui.layers.heatmap && visiblePositions.length >= 2) {
      layers.push(new HeatmapLayer({
        id: 'heatmap',
        data: {
          length: visiblePositions.length / 2,
          attributes: {
            getPosition: { value: visiblePositions, size: 2 },
          },
        },
        radiusPixels: 60,
        intensity: 5,
        threshold: 0.001,
        aggregation: 'SUM',
        colorRange: HEATMAP_COLORS,
      }));
    }
    if (ui.layers.heatmapAvgSpeed && visiblePositions.length >= 2) {
      // セル色=寄与点の平均速度(km/h)。colorDomainは[0, speedMax]に固定するので、現在の表示範囲にどんな最大速度が出ても凡例の意味が保たれる。
      layers.push(new HeatmapLayer({
        id: 'heatmap-avg-speed',
        data: {
          length: visiblePositions.length / 2,
          attributes: {
            getPosition: { value: visiblePositions, size: 2 },
            getWeight:   { value: visibleSpeeds,    size: 1 },
          },
        },
        radiusPixels: 30,
        intensity: 1,
        threshold: 0.04,
        aggregation: 'MEAN',
        colorDomain: [0, Math.max(1, ui.speedMax)],
        colorRange: AVG_SPEED_COLORS,
      }));
    }
    if (ui.layers.hexagon) {
      // HexagonLayerはJS側で集計するので、入力配列のサイズに上限を設けておく。
      const sampled = subsamplePositions(visiblePositions, 200000);
      layers.push(new HexagonLayer({
        id: 'hex',
        data: sampled,
        getPosition: (d) => d,
        radius: 1500,
        extruded: false,
        coverage: 0.95,
        colorRange: HEX_COLORS,
        opacity: 0.75,
      }));
    }
    if (ui.layers.headingHex && visibleHeadings && visiblePositions.length >= 2) {
      // セル色=方位の循環平均(度、0=北で時計回り)。単純な算術平均だとラップアラウンドで誤る(mean(350°,10°)は0°になるべきで180°ではない)ので、単位ベクトルを平均してatan2する。
      const sampled = subsamplePositionsWithHeading(visiblePositions, visibleHeadings, 200000);
      layers.push(new HexagonLayer({
        id: 'hex-heading',
        data: sampled,
        getPosition: (d) => d,
        getColorValue: (pts) => {
          let sx = 0, sy = 0;
          for (let i = 0; i < pts.length; i++) {
            const r = pts[i][2] * Math.PI / 180;
            sx += Math.cos(r);
            sy += Math.sin(r);
          }
          let deg = Math.atan2(sy, sx) * 180 / Math.PI;
          if (deg < 0) deg += 360;
          return deg;
        },
        radius: 1500,
        extruded: false,
        coverage: 0.95,
        colorDomain: [0, 360],
        colorRange: HEADING_HEX_COLORS,
        opacity: 0.75,
      }));
    }
  }

  if (polygon) {
    if (polygon.ring && polygon.ring.length >= 3) {
      layers.push(new PolygonLayer({
        id: 'roi-polygon',
        data: [{ polygon: polygon.ring }],
        getPolygon: (d) => d.polygon,
        getFillColor: [255, 184, 78, 50],
        getLineColor: [255, 184, 78, 230],
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        filled: true,
        stroked: true,
        pickable: false,
      }));
    }
    if (polygon.mode === 'drawing' && polygon.draftRing.length > 0) {
      if (polygon.draftRing.length >= 2) {
        layers.push(new PathLayer({
          id: 'roi-draft-edge',
          data: [{ path: polygon.draftRing }],
          getPath: (d) => d.path,
          getColor: [255, 184, 78, 220],
          getWidth: 2,
          widthUnits: 'pixels',
          pickable: false,
        }));
      }
      layers.push(new ScatterplotLayer({
        id: 'roi-draft-vert',
        data: polygon.draftRing,
        getPosition: (d) => d,
        getRadius: 5,
        radiusUnits: 'pixels',
        getFillColor: [255, 184, 78, 230],
        stroked: true,
        getLineColor: [10, 12, 18, 230],
        lineWidthMinPixels: 1,
        pickable: false,
      }));
    }
  }

  if (ui.layers.trips && selectedVehiclePath && selectedVehiclePath.length >= 2) {
    layers.push(new PathLayer({
      id: 'trip',
      data: [{ path: selectedVehiclePath.map((p) => [p.lon, p.lat]) }],
      getPath: (d) => d.path,
      getColor: [255, 200, 80, 230],
      getWidth: 4,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    }));
    layers.push(new ScatterplotLayer({
      id: 'trip-points',
      data: selectedVehiclePath,
      getPosition: (d) => [d.lon, d.lat],
      getFillColor: [255, 220, 120, 230],
      getRadius: 3,
      radiusUnits: 'pixels',
      stroked: true,
      getLineColor: [10, 12, 18, 200],
      lineWidthMinPixels: 0.5,
    }));
  }

  return layers;
}

// 全レコードに対する[time_offset, passFlag]をパックする。可能なら呼び出し側が再利用可能なバッファを渡してくる前提で、その場合は確保し直さない。
// `speedMax`は意図的にフィルタにしていない。色スケールの上限を決めるだけ(buildColors参照)で、スライダ値より速いレコードも描画はされ、上端色にクランプされる。
export function buildFilterValues(day, opts, out) {
  const { count, u8View, times } = day;
  const onlyGps = !!opts.onlyGps;
  const onlyMoving = !!opts.onlyMoving;
  const excludeHighway = !!opts.excludeHighway;
  const arr = out && out.length === count * 2 ? out : new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const off = i * RECORD_SIZE;
    const sp = u8View[off + 12];
    const fl = u8View[off + 14];
    let pass = 1;
    if (onlyGps && !(fl & 4)) pass = 0;
    else if (onlyMoving && sp === 0) pass = 0;
    else if (excludeHighway && sp > 60) pass = 0;
    arr[i * 2] = times[i];
    arr[i * 2 + 1] = pass;
  }
  return arr;
}

// 現在の時間窓+フィルタ値を満たすレコードについて、[lon,lat,...]・[speed,...]・[heading,...]のフラットな型付き配列を抽出する。
// 速度と方位を一緒に持っておくのは、セル単位の集計レイヤが`getWeight`や循環平均に2度目のパス無しで使えるようにするため。
function filterPositionsAndSpeeds(day, filterValues, tStart, tEnd) {
  const { count, positionsView, u8View } = day;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const t = filterValues[i * 2];
    const p = filterValues[i * 2 + 1];
    if (p > 0.5 && t >= tStart && t <= tEnd) n++;
  }
  const positions = new Float32Array(n * 2);
  const speeds    = new Float32Array(n);
  const headings  = new Float32Array(n);
  let k = 0, ks = 0, kh = 0;
  for (let i = 0; i < count; i++) {
    const t = filterValues[i * 2];
    const p = filterValues[i * 2 + 1];
    if (!(p > 0.5 && t >= tStart && t <= tEnd)) continue;
    positions[k++] = positionsView[i * 5];
    positions[k++] = positionsView[i * 5 + 1];
    speeds[ks++]   = u8View[i * RECORD_SIZE + 12];
    headings[kh++] = u8View[i * RECORD_SIZE + 13] * 2; // 格納形式はdeg/2なので2倍してdegに戻す
  }
  return { positions, speeds, headings };
}

// 配列長がおおよそtarget点で収まるよう、N点ごとに間引く。HexagonLayerは[lon, lat]ペアの配列を受け取る。
// 画面外の2点をアンカーとして追加し、自動推定されるグリッド原点を固定して、描画ごとにセルがずれないようにする(動機はsubsamplePositionsWithHeading側のコメント参照)。
const POS_HEX_ANCHORS = [
  [88.0,  -8.0],
  [118.0, 32.0],
];
function subsamplePositions(positionsFlat, target) {
  const n = positionsFlat.length / 2;
  const out = [];
  if (n > 0) {
    const step = Math.max(1, Math.floor(n / target));
    for (let i = 0; i < n; i += step) {
      out.push([positionsFlat[i * 2], positionsFlat[i * 2 + 1]]);
    }
  }
  out.push(POS_HEX_ANCHORS[0], POS_HEX_ANCHORS[1]);
  return out;
}

// 同じ仕組みだが、3要素目に方位を入れておき、heading-hexレイヤのgetColorValueがセル単位の循環平均を計算できるようにする。
// 2つの隅アンカーを末尾に足すのは、時間窓フィルタで入力範囲が変わってもHexagonLayerが自動推定するグリッド原点を固定するため。これがないとスライダ操作のたびに全セルが目に見えてずれる。
// アンカーはタイから十分外に置いて、2つの余分なセルが画面外に留まるようにしている。
const HEADING_HEX_ANCHORS = [
  [88.0,  -8.0, 0],
  [118.0, 32.0, 0],
];
function subsamplePositionsWithHeading(positionsFlat, headings, target) {
  const n = positionsFlat.length / 2;
  const out = [];
  if (n > 0) {
    const step = Math.max(1, Math.floor(n / target));
    for (let i = 0; i < n; i += step) {
      out.push([positionsFlat[i * 2], positionsFlat[i * 2 + 1], headings[i]]);
    }
  }
  out.push(HEADING_HEX_ANCHORS[0], HEADING_HEX_ANCHORS[1]);
  return out;
}

// Inferno-inspired sequential palette for the count heatmap. Dark end is
// transparent so it dissolves into the dark basemap; bright end is pale
// yellow for high counts. The hex count layer reuses the same palette
// (alpha-stripped) below so density visualizations read consistently.
const HEATMAP_COLORS = [
  [ 20,  11,  52,   0],
  [ 80,  18, 123, 140],
  [182,  54, 121, 200],
  [241,  96,  93, 225],
  [252, 174,  33, 240],
  [252, 255, 164, 250],
];

// 平均速度のグラデーション: 赤(低速・混雑)→緑→青(高速・自由流)。
// binary.js#buildColorsの点単位パレットと一致させ、2つの可視化が整合的に読めるようにしている。
const AVG_SPEED_COLORS = [
  [200,  40,  30,   0],
  [230,  60,  40, 200],
  [255, 180,  70, 220],
  [120, 220, 140, 230],
  [ 50, 130, 240, 240],
];

// Same Inferno palette as HEATMAP_COLORS minus alpha (HexagonLayer drives
// transparency through the layer's `opacity` prop, not per-stop alpha).
const HEX_COLORS = [
  [ 20,  11,  52],
  [ 80,  18, 123],
  [182,  54, 121],
  [241,  96,  93],
  [252, 174,  33],
  [252, 255, 164],
];

// heading-hexレイヤ用の循環色相環。12段階×30°ずつ。最初と最後の色は意図的に近づけてあり、360°/0°のラップアラウンドで違和感のある色変化が出ないようにしている。
const HEADING_HEX_COLORS = [
  [255,  64,  64],   //   0° N    赤
  [255, 144,  64],   //  30°      橙
  [255, 224,  64],   //  60°      黄
  [192, 240,  64],   //  90° E    黄緑
  [ 64, 240,  64],   // 120°      緑
  [ 64, 240, 144],   // 150°      シアン緑
  [ 64, 224, 240],   // 180° S    シアン
  [ 64, 144, 240],   // 210°      空色
  [ 64,  64, 240],   // 240°      青
  [144,  64, 240],   // 270° W    紫
  [240,  64, 240],   // 300°      マゼンタ
  [240,  64, 144],   // 330°      ピンク
];
