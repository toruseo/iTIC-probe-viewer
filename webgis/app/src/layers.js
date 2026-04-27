import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { HeatmapLayer, HexagonLayer } from '@deck.gl/aggregation-layers';
import { DataFilterExtension } from '@deck.gl/extensions';

const RECORD_SIZE = 20;

export function buildLayers(state) {
  const { day, ui, colors, filterValues, selectedVehiclePath } = state;
  const layers = [];
  if (!day) return layers;

  const { count, positionsView, tMin } = day;

  // filterValues = Float32Array(count*2): [time_offset_sec, passFlag(0|1)]
  // filterRange = [[tStart, tEnd], [0.5, 1.5]]
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

  if (ui.layers.heatmap || ui.layers.heatmapAvgSpeed || ui.layers.hexagon) {
    const { positions: visiblePositions, speeds: visibleSpeeds } =
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
        radiusPixels: 30,
        intensity: 1,
        threshold: 0.04,
        aggregation: 'SUM',
        colorRange: HEATMAP_COLORS,
      }));
    }
    if (ui.layers.heatmapAvgSpeed && visiblePositions.length >= 2) {
      // Per-cell color = mean speed (km/h) of contributing points.
      // colorDomain is fixed to [0, speedMax] so the legend stays meaningful
      // regardless of the current max in view.
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
      // HexagonLayer aggregates on JS side; keep the input array bounded.
      const sampled = subsamplePositions(visiblePositions, 200000);
      layers.push(new HexagonLayer({
        id: 'hex',
        data: sampled,
        getPosition: (d) => d,
        radius: 250,
        elevationScale: 8,
        extruded: true,
        coverage: 0.9,
        colorRange: HEX_COLORS,
        opacity: 0.85,
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

// Pack [time_offset, passFlag] for every record. Allocated once; the caller
// provides reusable backing storage when possible.
// `speedMax` is intentionally NOT a filter — it only drives the color scale
// upper bound (see buildColors). Records faster than the slider value still
// render, just clamped to the top color.
export function buildFilterValues(day, opts, out) {
  const { count, u8View, times } = day;
  const onlyGps = !!opts.onlyGps;
  const onlyMoving = !!opts.onlyMoving;
  const arr = out && out.length === count * 2 ? out : new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const off = i * RECORD_SIZE;
    const sp = u8View[off + 12];
    const fl = u8View[off + 14];
    let pass = 1;
    if (onlyGps && !(fl & 4)) pass = 0;
    else if (onlyMoving && sp === 0) pass = 0;
    arr[i * 2] = times[i];
    arr[i * 2 + 1] = pass;
  }
  return arr;
}

// Extract flat typed arrays of [lon,lat,...] and [speed,...] for records that
// satisfy the current time window + filter values. Speed is kept alongside so
// the avg-speed heatmap can use it as `getWeight` without a second pass.
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
  let k = 0, ks = 0;
  for (let i = 0; i < count; i++) {
    const t = filterValues[i * 2];
    const p = filterValues[i * 2 + 1];
    if (!(p > 0.5 && t >= tStart && t <= tEnd)) continue;
    positions[k++] = positionsView[i * 5];
    positions[k++] = positionsView[i * 5 + 1];
    speeds[ks++]   = u8View[i * RECORD_SIZE + 12];
  }
  return { positions, speeds };
}

// Take every Nth record so the array tops out at ~target points.
// HexagonLayer accepts an array of [lon, lat] pairs.
function subsamplePositions(positionsFlat, target) {
  const n = positionsFlat.length / 2;
  if (n === 0) return [];
  const step = Math.max(1, Math.floor(n / target));
  const out = new Array(Math.ceil(n / step));
  let k = 0;
  for (let i = 0; i < n; i += step) {
    out[k++] = [positionsFlat[i * 2], positionsFlat[i * 2 + 1]];
  }
  return out.slice(0, k);
}

const HEATMAP_COLORS = [
  [40, 50, 110, 0],
  [40, 110, 200, 120],
  [50, 200, 220, 200],
  [255, 220, 100, 230],
  [255, 100, 50, 250],
];

// Avg-speed gradient: red (slow / congested) → green → blue (fast / free flow).
// Mirrors the per-point speed palette in binary.js#buildColors so the two
// visualizations read consistently.
const AVG_SPEED_COLORS = [
  [200,  40,  30,   0],
  [230,  60,  40, 200],
  [255, 180,  70, 220],
  [120, 220, 140, 230],
  [ 50, 130, 240, 240],
];

const HEX_COLORS = [
  [50, 90, 200],
  [80, 160, 220],
  [120, 220, 200],
  [200, 240, 120],
  [255, 200, 80],
  [255, 100, 60],
];
