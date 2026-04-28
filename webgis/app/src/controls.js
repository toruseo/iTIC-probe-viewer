// Wires up the DOM controls in index.html with state mutations + render calls.
//
// Time-window UI has two modes:
//   - 'range'  : slider1 = start offset from tMin, slider2 = end offset
//   - 'window' : slider1 = start offset from tMin, slider2 = window width
// Internally we always keep state.ui.tStartUnix / tEndUnix as absolute UTC
// seconds; the slider DOM is reformatted on mode change via syncSliders().

export function setupControls({ state, render, selectDay, formatBkk, onUiChanged }) {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ----- DOM ↔ state sync at init -----
  // Browsers restore form-control values across reload (bfcache, F5), so a
  // checkbox the user toggled last session can show "checked" while the
  // freshly-initialized state.ui has it false — display and UI disagree.
  // Authoritatively push state defaults into the DOM here.
  $('lyr-points').checked      = state.ui.layers.points;
  $('lyr-heatmap').checked     = state.ui.layers.heatmap;
  $('lyr-heatmap-avg').checked = state.ui.layers.heatmapAvgSpeed;
  $('lyr-hexagon').checked     = state.ui.layers.hexagon;
  $('lyr-trips').checked       = state.ui.layers.trips;
  $('f-gps').checked        = state.ui.onlyGps;
  $('f-moving').checked     = state.ui.onlyMoving;
  $('f-speed-max').value    = String(state.ui.speedMax);
  $('f-speed-max-v').textContent = String(state.ui.speedMax);
  $('point-size').value     = String(state.ui.pointSize);
  $('color-by').value       = state.ui.colorBy;

  // ----- Day selector -----
  const daySelect = $('day-select');
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (const d of state.meta.days) {
    const opt = document.createElement('option');
    opt.value = d.date;
    const yyyy = Math.floor(d.date / 10000);
    const mm   = Math.floor((d.date / 100) % 100);
    const dd   = d.date % 100;
    const dow  = DOW[new Date(Date.UTC(yyyy, mm - 1, dd)).getUTCDay()];
    opt.textContent = `${d.date} ${dow} (${(d.count/1e6).toFixed(2)}M)`;
    daySelect.appendChild(opt);
  }
  daySelect.addEventListener('change', () => {
    const v = +daySelect.value;
    if (Number.isFinite(v)) selectDay(v);
  });

  // ----- Time sliders -----
  const tStart = $('time-start');
  const tEnd   = $('time-end');
  const tLabel = $('time-label');
  const slider2Tag = $('slider2-tag');
  let timeMode = 'range';

  const fmtDur = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2,'0')}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s`;
  };

  const updateTimeLabel = () => {
    if (!state.day) return;
    const w = state.ui.tEndUnix - state.ui.tStartUnix;
    tLabel.textContent =
      `${formatBkk(state.ui.tStartUnix).slice(11)} – ${formatBkk(state.ui.tEndUnix).slice(11)}  (${fmtDur(w)})`;
  };

  // Push current state.ui.tStartUnix/tEndUnix onto the slider DOM.
  const syncSliders = () => {
    if (!state.day) return;
    const s = state.ui.tStartUnix - state.day.tMin;
    const e = state.ui.tEndUnix   - state.day.tMin;
    tStart.value = String(s);
    tEnd.value   = String(timeMode === 'range' ? e : (e - s));
  };

  const setMode = (mode) => {
    if (mode === timeMode) return;
    timeMode = mode;
    slider2Tag.textContent = (mode === 'range') ? 'end' : 'width';
    const radio = document.querySelector(`input[name="time-mode"][value="${mode}"]`);
    if (radio && !radio.checked) radio.checked = true;
    syncSliders();
  };

  // Read sliders → write absolute times into state.
  const onSlider = (ev) => {
    if (!state.day) return;
    const span = state.day.tMax - state.day.tMin;
    const v1 = +tStart.value, v2 = +tEnd.value;
    if (timeMode === 'range') {
      let s = v1, e = v2;
      if (s > e) {
        // crossed sliders: snap the non-moving one to the moving one
        if (ev && ev.target === tStart) { e = s; tEnd.value = String(e); }
        else                            { s = e; tStart.value = String(s); }
      }
      state.ui.tStartUnix = state.day.tMin + s;
      state.ui.tEndUnix   = state.day.tMin + e;
    } else {
      const s = v1, w = v2;
      state.ui.tStartUnix = state.day.tMin + s;
      state.ui.tEndUnix   = state.day.tMin + Math.min(span, s + w);
    }
    updateTimeLabel();
    render();
  };

  document.addEventListener('day-loaded', () => {
    if (!state.day) return;
    const span = state.day.tMax - state.day.tMin;
    tStart.min = 0; tStart.max = span;
    tEnd.min = 0;   tEnd.max = span;
    // Reset to "show the whole day" in whatever mode the user picked.
    state.ui.tStartUnix = state.day.tMin;
    state.ui.tEndUnix   = state.day.tMax;
    daySelect.value = String(state.ui.dateYmd);
    syncSliders();
    updateTimeLabel();
    $('day-hint').textContent =
      `${formatBkk(state.day.tMin)} → ${formatBkk(state.day.tMax)} GMT+7`;
  });

  tStart.addEventListener('input', onSlider);
  tEnd.addEventListener('input', onSlider);

  $$('input[name="time-mode"]').forEach((r) => {
    r.addEventListener('change', () => setMode(r.value));
  });

  // Width preset buttons → switch to window mode + set width
  $$('#width-presets button[data-w]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.day) return;
      const w = +btn.dataset.w;
      const span = state.day.tMax - state.day.tMin;
      const start = state.ui.tStartUnix; // keep current start
      setMode('window');
      state.ui.tStartUnix = start;
      state.ui.tEndUnix   = Math.min(state.day.tMax, start + w);
      // tEnd slider holds the *width* in window mode; clamp to slider max
      tStart.value = String(start - state.day.tMin);
      tEnd.value   = String(Math.min(span, w));
      updateTimeLabel();
      render();
    });
  });

  // ----- Play -----
  const playBtn = $('play');
  const playSpeedSel = $('play-speed');
  let rafId = null, lastFrameMs = 0;

  const stopPlay = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    state.playing = false;
    playBtn.textContent = '▶ Play';
  };

  const tick = (now) => {
    if (!state.playing || !state.day) { stopPlay(); return; }
    const dt = lastFrameMs ? Math.min(0.1, (now - lastFrameMs) / 1000) : 1/60;
    lastFrameMs = now;
    const speedup = +playSpeedSel.value;
    const w = state.playWindow;
    let sUnix = state.ui.tStartUnix + dt * speedup;
    if (sUnix + w > state.day.tMax) sUnix = state.day.tMin; // wrap
    state.ui.tStartUnix = sUnix;
    state.ui.tEndUnix   = sUnix + w;
    syncSliders();
    updateTimeLabel();
    render();
    rafId = requestAnimationFrame(tick);
  };

  playBtn.addEventListener('click', () => {
    if (!state.day) return;
    if (state.playing) { stopPlay(); return; }

    // Snapshot the play window. If the current selection covers (almost) the
    // whole day, fall back to a 1-hour window so the animation is visible.
    const span = state.day.tMax - state.day.tMin;
    let w = state.ui.tEndUnix - state.ui.tStartUnix;
    if (!Number.isFinite(w) || w <= 0 || w >= span * 0.95) {
      w = Math.min(3600, Math.max(60, span * 0.05));
      setMode('window');
      state.ui.tStartUnix = state.day.tMin;
      state.ui.tEndUnix   = state.day.tMin + w;
      tStart.value = '0';
      tEnd.value   = String(w);
      updateTimeLabel();
    }
    state.playWindow = w;
    state.playing = true;
    lastFrameMs = 0;
    playBtn.textContent = '⏸ Pause';
    rafId = requestAnimationFrame(tick);
  });

  // ----- Layer toggles -----
  const bind = (id, fn) => $(id).addEventListener('change', () => { fn(); render(); });
  bind('lyr-points',      () => state.ui.layers.points          = $('lyr-points').checked);
  bind('lyr-heatmap',     () => state.ui.layers.heatmap         = $('lyr-heatmap').checked);
  bind('lyr-heatmap-avg', () => state.ui.layers.heatmapAvgSpeed = $('lyr-heatmap-avg').checked);
  bind('lyr-hexagon',     () => state.ui.layers.hexagon         = $('lyr-hexagon').checked);
  bind('lyr-trips',       () => state.ui.layers.trips           = $('lyr-trips').checked);

  // ----- Color by -----
  $('color-by').addEventListener('change', () => {
    state.ui.colorBy = $('color-by').value;
    onUiChanged('colorBy');
  });

  $('point-size').addEventListener('input', () => {
    state.ui.pointSize = +$('point-size').value;
    render();
  });

  // ----- Filters -----
  const filterChange = () => {
    state.ui.onlyGps    = $('f-gps').checked;
    state.ui.onlyMoving = $('f-moving').checked;
    onUiChanged('filter');
  };
  $('f-gps').addEventListener('change', filterChange);
  $('f-moving').addEventListener('change', filterChange);

  // ----- Speed color-scale max (does NOT filter; only rescales the speed gradient) -----
  $('f-speed-max').addEventListener('input', () => {
    state.ui.speedMax = +$('f-speed-max').value;
    $('f-speed-max-v').textContent = String(state.ui.speedMax);
    onUiChanged('speedMax');
  });
}
