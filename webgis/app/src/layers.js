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
        radius: 750,
        extruded: false,
        coverage: 0.95,
        colorRange: HEX_COLORS,
        opacity: 0.75,
      }));
    }
    if (ui.layers.headingHex && visibleHeadings && visiblePositions.length >= 2) {
      // Per-cell color = circular mean of headings (degrees, 0=N CW). Plain
      // arithmetic mean would be wrong at the wrap-around (mean(350°,10°)
      // should be 0°, not 180°), so we average unit vectors and atan2.
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
        radius: 750,
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

// Extract flat typed arrays of [lon,lat,...], [speed,...] and [heading,...]
// for records that satisfy the current time window + filter values. Speed and
// heading are kept alongside so per-cell aggregation layers can use them as
// `getWeight` / for circular mean without a second pass.
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
    headings[kh++] = u8View[i * RECORD_SIZE + 13] * 2; // stored as deg/2, restore deg
  }
  return { positions, speeds, headings };
}

// Take every Nth record so the array tops out at ~target points.
// HexagonLayer accepts an array of [lon, lat] pairs. Two off-screen anchors
// pin the auto-derived grid origin so cells don't drift across renders (see
// subsamplePositionsWithHeading for the motivation).
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

// Same idea but keeps the heading as the third element so the heading-hex
// layer's getColorValue can compute a per-cell circular mean. Two corner
// anchors are appended so the HexagonLayer's auto-derived grid origin
// stays put even as the time-window filter changes the input extent —
// otherwise every cell visibly shifts when scrubbing the slider. Anchors
// are placed well outside Thailand so the two stray cells stay off-screen.
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

// Cyclic hue wheel for the heading-hex layer. 12 stops × 30° each. First and
// last colors are intentionally close so the wrap-around at 360°/0° doesn't
// flash a discordant color.
const HEADING_HEX_COLORS = [
  [255,  64,  64],   //   0° N    red
  [255, 144,  64],   //  30°      orange
  [255, 224,  64],   //  60°      yellow
  [192, 240,  64],   //  90° E    yellow-green
  [ 64, 240,  64],   // 120°      green
  [ 64, 240, 144],   // 150°      cyan-green
  [ 64, 224, 240],   // 180° S    cyan
  [ 64, 144, 240],   // 210°      azure
  [ 64,  64, 240],   // 240°      blue
  [144,  64, 240],   // 270° W    violet
  [240,  64, 240],   // 300°      magenta
  [240,  64, 144],   // 330°      pink
];
