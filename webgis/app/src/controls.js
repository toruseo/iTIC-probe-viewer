// index.htmlのDOMコントロールを、stateの更新とrender呼び出しに繋ぐ層。
//
// 時間窓UIには2モードある:
//   - 'range'  : slider1=tMinからの開始オフセット、slider2=終了オフセット
//   - 'window' : slider1=tMinからの開始オフセット、slider2=窓の幅
// 内部的にはstate.ui.tStartUnix/tEndUnixを常に絶対UTC秒で保持し、モード切替時にsyncSliders()でスライダDOM側を整形し直す。

export function setupControls({ state, render, selectDay, formatBkk, onUiChanged }) {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ----- 初期化時のDOM↔state同期 -----
  // ブラウザはリロード(bfcacheやF5)を跨いでフォーム要素の値を復元するので、前セッションでユーザがチェックを入れたチェックボックスが"checked"のまま見える一方、初期化直後のstate.ui側はfalseのまま、ということが起きる。
  // ここではstate側のデフォルトを正としてDOMに上書きする。
  $('lyr-points').checked      = state.ui.layers.points;
  $('lyr-heatmap').checked     = state.ui.layers.heatmap;
  $('lyr-heatmap-avg').checked = state.ui.layers.heatmapAvgSpeed;
  $('lyr-hexagon').checked     = state.ui.layers.hexagon;
  $('lyr-heading-hex').checked = state.ui.layers.headingHex;
  $('lyr-trips').checked       = state.ui.layers.trips;
  $('f-gps').checked        = state.ui.onlyGps;
  $('f-moving').checked     = state.ui.onlyMoving;
  $('f-speed-max').value    = String(state.ui.speedMax);
  $('f-speed-max-v').textContent = String(state.ui.speedMax);
  $('point-size').value     = String(state.ui.pointSize);
  $('color-by').value       = state.ui.colorBy;

  // ----- 日付セレクタ -----
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

  // ----- 時間スライダ -----
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

  // 現在のstate.ui.tStartUnix/tEndUnixをスライダDOMに反映する。
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

  // スライダ値を読んで絶対時刻としてstateに書き戻す。
  const onSlider = (ev) => {
    if (!state.day) return;
    const span = state.day.tMax - state.day.tMin;
    const v1 = +tStart.value, v2 = +tEnd.value;
    if (timeMode === 'range') {
      let s = v1, e = v2;
      if (s > e) {
        // スライダが交差したら、動いていない側を動かしている側に揃える
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
    // 現在のモードのまま「丸一日を表示」状態にリセットする。
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

  // 幅プリセットボタン: windowモードに切替えて幅を設定する
  $$('#width-presets button[data-w]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.day) return;
      const w = +btn.dataset.w;
      const span = state.day.tMax - state.day.tMin;
      const start = state.ui.tStartUnix; // 現在の開始時刻は維持
      setMode('window');
      state.ui.tStartUnix = start;
      state.ui.tEndUnix   = Math.min(state.day.tMax, start + w);
      // windowモードではtEndスライダは「幅」を持つ。スライダ最大値でクランプする。
      tStart.value = String(start - state.day.tMin);
      tEnd.value   = String(Math.min(span, w));
      updateTimeLabel();
      render();
    });
  });

  // ----- 再生 -----
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
    if (sUnix + w > state.day.tMax) sUnix = state.day.tMin; // 端まで来たら巻き戻す
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

    // 再生用の窓幅を確定させる。現在の選択が丸一日(に近い)範囲を覆っている場合はアニメーションが見えないので1時間の窓にフォールバックする。
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

  // ----- レイヤ切替 -----
  const bind = (id, fn) => $(id).addEventListener('change', () => { fn(); render(); });
  bind('lyr-points',      () => state.ui.layers.points          = $('lyr-points').checked);
  bind('lyr-heatmap',     () => state.ui.layers.heatmap         = $('lyr-heatmap').checked);
  bind('lyr-heatmap-avg', () => state.ui.layers.heatmapAvgSpeed = $('lyr-heatmap-avg').checked);
  bind('lyr-hexagon',     () => state.ui.layers.hexagon         = $('lyr-hexagon').checked);
  bind('lyr-heading-hex', () => state.ui.layers.headingHex      = $('lyr-heading-hex').checked);
  bind('lyr-trips',       () => state.ui.layers.trips           = $('lyr-trips').checked);

  // ----- 色分けモード -----
  $('color-by').addEventListener('change', () => {
    state.ui.colorBy = $('color-by').value;
    onUiChanged('colorBy');
  });

  $('point-size').addEventListener('input', () => {
    state.ui.pointSize = +$('point-size').value;
    render();
  });

  // ----- フィルタ -----
  const filterChange = () => {
    state.ui.onlyGps    = $('f-gps').checked;
    state.ui.onlyMoving = $('f-moving').checked;
    onUiChanged('filter');
  };
  $('f-gps').addEventListener('change', filterChange);
  $('f-moving').addEventListener('change', filterChange);

  // ----- 速度色スケールの上限(フィルタではなく、速度グラデーションの再スケールのみ) -----
  $('f-speed-max').addEventListener('input', () => {
    state.ui.speedMax = +$('f-speed-max').value;
    $('f-speed-max-v').textContent = String(state.ui.speedMax);
    onUiChanged('speedMax');
  });
}
