import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';

import { fetchMeta, loadDay, buildColors, extractVehiclePath } from './binary.js';
import { buildLayers, buildFilterValues } from './layers.js';
import { setupControls } from './controls.js';

const BASEMAP_STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const state = {
  meta: null,
  vehicles: [],
  day: null,           // current loaded day data
  ui: {
    dateYmd: null,
    tStartUnix: 0,
    tEndUnix: 0,
    layers: { points: true, heatmap: false, hexagon: false, trips: true },
    colorBy: 'speed',
    pointSize: 3,
    onlyGps: true,
    onlyMoving: true,
    speedMax: 100,
  },
  colors: null,
  filterValues: null,
  selectedVid: null,
  selectedVehiclePath: null,
  playing: false,
  playSpeed: 300,
};

// ---------- Status helpers ----------
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const setStatus = (s) => { statusEl.textContent = s; };
const setStats = (s) => { statsEl.textContent = s; };

// ---------- Map + Deck overlay ----------
const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP_STYLE_URL,
  center: [100.5, 13.75],
  zoom: 9,
  pitch: 0,
  bearing: 0,
  attributionControl: {
    compact: true,
    customAttribution: [
      'Data © <a href="https://www.iticfoundation.org/" target="_blank" rel="noopener">iTIC</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>',
      '<a href="https://github.com/toruseo/iTIC-probe-viewer" target="_blank" rel="noopener">Source on GitHub</a>',
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const overlay = new MapboxOverlay({
  interleaved: false,
  layers: [],
  onClick: (info) => onPick(info),
  onHover: (info) => onHover(info),
});
map.on('load', () => map.addControl(overlay));

// ---------- Pick / Hover ----------
let hoverPopup = null;
function onHover(info) {
  if (!hoverPopup) {
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'hover-popup' });
  }
  if (info && info.layer && info.layer.id === 'points' && info.index >= 0 && state.day) {
    const i = info.index;
    const u8 = state.day.u8View;
    const u32 = state.day.u32View;
    const sp = u8[i * 20 + 12];
    const hd = u8[i * 20 + 13] * 2;
    const fl = u8[i * 20 + 14];
    const t  = u32[i * 5 + 2];
    const html = `
      <div style="font-size:11px; line-height:1.4">
        <div>${formatBkk(t)} GMT+7</div>
        <div>speed ${sp} km/h · heading ${hd}°</div>
        <div>${(fl & 4) ? 'gps✓' : 'gps✗'} · ${(fl & 2) ? 'engine on' : 'engine off'} · ${(fl & 1) ? 'for-hire' : 'no-hire'}</div>
      </div>`;
    hoverPopup.setLngLat(info.coordinate).setHTML(html).addTo(map);
  } else if (hoverPopup) {
    hoverPopup.remove();
  }
}

function onPick(info) {
  if (!state.day) return;
  if (!(info && info.layer && info.layer.id === 'points' && info.index >= 0)) return;
  const i = info.index;
  const vid = state.day.u32View[i * 5 + 4];
  selectVehicle(vid);
}

function selectVehicle(vid) {
  state.selectedVid = vid;
  setStatus(`extracting trip for vid #${vid}…`);
  // Run async so the UI can update.
  setTimeout(() => {
    const path = extractVehiclePath(state.day, vid);
    state.selectedVehiclePath = path;
    const idStr = state.vehicles[vid] || `#${vid}`;
    document.getElementById('vehicle-info').innerHTML = `
      <div><code>${escapeHtml(idStr)}</code></div>
      <div class="muted">${path.length.toLocaleString()} fixes · ${path[0] ? formatBkk(path[0].t) : '?'} → ${path[path.length-1] ? formatBkk(path[path.length-1].t) : '?'}</div>
      <div class="row"><button id="vehicle-clear">clear</button> <button id="vehicle-fit">fit map</button></div>
    `;
    document.getElementById('vehicle-clear').onclick = () => {
      state.selectedVid = null;
      state.selectedVehiclePath = null;
      document.getElementById('vehicle-info').textContent = 'Click a point to select.';
      render();
    };
    document.getElementById('vehicle-fit').onclick = () => fitToPath(path);
    setStatus('idle');
    render();
  }, 0);
}

function fitToPath(path) {
  if (!path || path.length === 0) return;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of path) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, duration: 600 });
}

// ---------- Render driver ----------
function render() {
  if (!state.day) { overlay.setProps({ layers: [] }); return; }
  const layers = buildLayers({
    day: state.day,
    ui: state.ui,
    colors: state.colors,
    filterValues: state.filterValues,
    selectedVehiclePath: state.selectedVehiclePath,
  });
  overlay.setProps({ layers });
  updateStats();
  updateLegend();
}

function updateStats() {
  const d = state.day;
  if (!d) return;
  const f = state.filterValues;
  const tStart = state.ui.tStartUnix - d.tMin;
  const tEnd   = state.ui.tEndUnix   - d.tMin;
  let visible = 0;
  for (let i = 0; i < d.count; i++) {
    const t = f[i * 2];
    const p = f[i * 2 + 1];
    if (p > 0.5 && t >= tStart && t <= tEnd) visible++;
  }
  setStats(
    `${d.count.toLocaleString()} pts loaded\n` +
    `${visible.toLocaleString()} visible (${(visible/Math.max(1,d.count)*100).toFixed(1)}%)\n` +
    `${d.vehicleCount.toLocaleString()} unique vehicles\n` +
    `bbox lon ${d.bbox[0].toFixed(2)}..${d.bbox[2].toFixed(2)}\n` +
    `bbox lat ${d.bbox[1].toFixed(2)}..${d.bbox[3].toFixed(2)}`
  );
}

function updateLegend() {
  const el = document.getElementById('legend');
  const mode = state.ui.colorBy;
  let html = `<div class="muted">Color: ${mode}</div>`;
  if (mode === 'speed') {
    // Red (slow) → mid → blue (fast). Mirrors buildColors() in binary.js.
    html += `<div class="legend-bar" style="background:linear-gradient(90deg,#e62800,#73dc78,#0028f0)"></div>
             <div class="legend-row"><span>0</span><span>${state.ui.speedMax} km/h</span></div>`;
  } else if (mode === 'heading') {
    html += `<div class="legend-bar" style="background:conic-gradient(from 0deg,#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)"></div>
             <div class="legend-row"><span>N</span><span>E·S·W</span></div>`;
  } else if (mode === 'forhire') {
    html += `<div class="legend-row"><span style="color:#ffb84e">● for-hire on</span><span style="color:#4ea3ff">● off</span></div>`;
  } else if (mode === 'engine') {
    html += `<div class="legend-row"><span style="color:#6eff8c">● engine on</span><span style="color:#c85050">● off</span></div>`;
  }
  el.innerHTML = html;
}

// ---------- Day loading ----------
async function selectDay(dateYmd) {
  setStatus(`loading ${dateYmd}…`);
  try {
    const day = await loadDay(dateYmd, (rcv, total) => {
      if (total) setStatus(`loading ${dateYmd}… ${(rcv/1e6).toFixed(1)}/${(total/1e6).toFixed(1)} MB`);
      else setStatus(`loading ${dateYmd}… ${(rcv/1e6).toFixed(1)} MB`);
    });
    state.day = day;
    state.ui.dateYmd = dateYmd;
    state.ui.tStartUnix = day.tMin;
    state.ui.tEndUnix = day.tMax;
    state.colors = buildColors(day, state.ui.colorBy, state.ui.speedMax);
    state.filterValues = buildFilterValues(day, state.ui);
    state.selectedVid = null;
    state.selectedVehiclePath = null;
    document.getElementById('vehicle-info').textContent = 'Click a point to select.';
    // Update time slider bounds in the UI (controls module reads state directly)
    document.dispatchEvent(new CustomEvent('day-loaded', { detail: { day } }));
    setStatus('rendering…');
    render();
    // Frame the bbox for first load
    map.fitBounds([[day.bbox[0], day.bbox[1]], [day.bbox[2], day.bbox[3]]], { padding: 60, duration: 0 });
    setStatus('idle');
  } catch (e) {
    console.error(e);
    setStatus(`error: ${e.message}`);
  }
}

// ---------- Format helpers ----------
function formatBkk(unixSec) {
  const d = new Date((unixSec + 7 * 3600) * 1000);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Init ----------
async function init() {
  setStatus('fetching meta…');
  let pkg;
  try {
    pkg = await fetchMeta();
  } catch (e) {
    setStatus(e.message);
    return;
  }
  state.meta = pkg.meta;
  state.vehicles = pkg.vehicles;
  setupControls({ state, render, selectDay, formatBkk,
    onUiChanged: (kind) => {
      const d = state.day;
      if (!d) return;
      if (kind === 'colorBy' || kind === 'speedMax') {
        state.colors = buildColors(d, state.ui.colorBy, state.ui.speedMax);
      }
      if (kind === 'filter')  state.filterValues = buildFilterValues(d, state.ui, state.filterValues);
      render();
    },
  });
  if (!state.meta.days || state.meta.days.length === 0) {
    setStatus('no days in meta.json');
    return;
  }
  await selectDay(state.meta.days[0].date);
}

init();
