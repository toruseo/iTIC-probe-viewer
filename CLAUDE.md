# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Web GIS for visualizing iTIC Thailand vehicle probe data
(`PROBE-YYYYMM/*.csv.out`, ~1.86M points/day × 31 days/month). Designed for
local "bring-your-own-CSV" use, but also deployed as a public demo on GitHub
Pages with one bundled day of preprocessed data. Two pieces:

1. `webgis/preprocess/preprocess.mjs` — Node CLI, CSV → 20-byte/record packed binary.
2. `webgis/app/` — Vite + deck.gl + MapLibre frontend that fetches those binaries
   over HTTP and views them as typed arrays in-place.

Top-level `run.cmd` / `run.sh` orchestrate install → preprocess → dev-server
for the local workflow.

`README.md` is **user-facing only** (demo URL, UI controls, "use your own data"
overview). All developer/architecture/binary-format/build/deploy detail lives
here in CLAUDE.md (committed to the repo as the dev reference). Keep README
terse — anything that's not a "what-can-I-do-as-a-visitor" detail belongs here.

Source-data spec: `PROBE_DATA_iTIC/README_ITIC.TXT`.

## Common commands

```bash
# Full one-shot launch (Windows: .\run.cmd, bash: ./run.sh)
.\run.cmd                # install + preprocess if needed + dev server + open browser
.\run.cmd --serve        # skip preprocess
.\run.cmd --rebuild      # force re-preprocess
.\run.cmd --limit 1      # preprocess only first day (fast iteration)

# Manual
cd webgis/preprocess && LIMIT=1 node preprocess.mjs
cd webgis/app && npm run dev          # vite dev server
cd webgis/app && npm run build        # production build (also a fast type/import check)
```

There is no test suite. The project's "tests" are smoke checks under `webgis/tmp/`
(see Conventions below).

## Deploying (GitHub Pages)

- Live demo: https://toruseo.github.io/iTIC-probe-viewer/
- `webgis/app/vite.config.js` sets `base: './'` so the build runs at any subdir.
- `.github/workflows/pages.yml` runs `npm install --no-audit --no-fund && npm run build`
  from `webgis/app/` and uploads `webgis/app/dist/` as the Pages artifact on
  push to `main`. Using `npm install` (not `npm ci`) is intentional — the
  lockfile is not strictly maintained in lockstep with `package.json`, and
  `npm ci` failed CI for that reason. If you ever want to switch back to
  `npm ci`, run `npm install` locally first and commit the regenerated
  `package-lock.json`.
- The repo ships **one day** of preprocessed data
  (`webgis/app/public/data/20250101.bin` + `meta.json` + `vehicles.json`, ~36 MB total) so the
  deployed demo has something to render. Adding more days means committing more
  binaries — fine up to a few hundred MB; beyond that, host data elsewhere and
  add a URL-based loader.
- The build output is `webgis/app/dist/` which is gitignored — only the source
  is committed; CI produces the artifact.

## Binary format

Per-day file: 64-byte header + N × 20-byte records, little-endian.

Header:

| off | type    | field                                 |
| ---:|:------- |:------------------------------------- |
| 0   | char[4] | magic `'PROB'`                        |
| 4   | u32     | version (=1)                          |
| 8   | u32     | record count                          |
| 12  | u32     | date YYYYMMDD                         |
| 16  | u32     | t_min (UTC unix sec)                  |
| 20  | u32     | t_max                                 |
| 24  | u32     | global vehicle count                  |
| 28  | f32×4   | bbox (minLon, minLat, maxLon, maxLat) |

Record (20 bytes):

| off | type | field                                                  |
| ---:|:---- |:------------------------------------------------------ |
| 0   | f32  | lon                                                    |
| 4   | f32  | lat                                                    |
| 8   | u32  | t_unix (UTC sec)                                       |
| 12  | u8   | speed (km/h, clamped 0..255)                           |
| 13  | u8   | heading / 2 (0..180)                                   |
| 14  | u8   | flags (bit0 for_hire, bit1 engine_acc, bit2 gps_valid) |
| 15  | u8   | _pad                                                   |
| 16  | u32  | vehicle index (`vehicles.json` の添字)                    |

Sidecar files: `meta.json` (per-day count/bbox/t_min/t_max) and `vehicles.json`
(global vehicle-ID dictionary, indexed by the record's vehicle index).

## Architecture

**Pipeline is one-way and zero-copy where it matters.** Mental model:

```
.csv.out  ─►  preprocess.mjs  ─►  YYYYMMDD.bin  ─►  binary.js  ─►  layers.js  ─►  deck.gl
            (Node, ~1.6s/day)     (~36MB/day)    (typed views)   (binary attrs)
```

The 20-byte record layout (`webgis/preprocess/preprocess.mjs` header comment) is
the **load-bearing contract**. Both sides must agree byte-for-byte:

- Producer: `preprocess.mjs` writes a 64-byte header + N × 20-byte records.
- Consumer: `webgis/app/src/binary.js` parses the header, then exposes the
  records section as **strided typed-array views** (`positionsView`, `u8View`,
  `u32View`) — no per-record JS objects are ever materialized. `layers.js`
  feeds those views to deck.gl as `{value, size, stride: 20, offset}` binary
  attributes (`getPosition`, `getFillColor`, `getFilterValue`).

If you change record size, change record offsets, or change the header in
`preprocess.mjs`, you **must** update `binary.js` (`HEADER_SIZE`, `RECORD_SIZE`,
the offset numbers in `extractVehiclePath` and `buildColors`) **and** `layers.js`
(stride values). Mismatches compile fine and silently render garbage.

**Time + filter is two-channel `DataFilterExtension`.** `layers.js` packs
`filterValues` as a `Float32Array(count*2)` of `[time_offset_sec, passFlag]`.
The points layer uses `filterRange: [[tStart,tEnd],[0.5,1.5]]` so the GPU drops
records that fail either dimension. CPU never iterates 1.86M records during
slider drags — only when filter inputs (gps/moving/speedMax/colorBy) change.

**Heatmap/Hexagon take a different path.** They aggregate on the JS side, so
they can't use the GPU filter. `layers.js` runs `filterPositions(...)` once to
extract a flat `Float32Array` of visible `[lon,lat]` pairs, then feeds that to
the aggregation layer. Hexagon further sub-samples to 200K via
`subsamplePositions(...)`.

**No bundler-side state.** `state` is a plain object in `main.js`; UI changes
mutate it and call `render()` which builds fresh layers. There's no Redux/etc.
Re-creating layers each render is fine because deck.gl diffs them.

**Time-window UI has two modes** wired in `controls.js`:

- `range` — slider1 = start offset from t_min, slider2 = end offset
- `window` — slider1 = start offset, slider2 = window width

`setMode()` repaints slider2 from absolute state.ui.tStart/tEndUnix, so the two
modes are interchangeable mid-session. **Play snapshots the window width once**
on press (`state.playWindow`) — it does *not* re-read the slider every frame
(that was the original "play does nothing" bug: full-day window made
`s + window > span` always true, triggering wrap-to-zero every tick). Play
falls back to a 1-hour window if the current selection covers ≥95% of the day.

Slider step is `1` (second). Larger steps quantize the visual sweep at high
play speeds.

## Known issues (worth knowing before debugging)

- **HeatmapLayer / HexagonLayer in deck.gl 9.3 + luma.gl 9.3** silently fail to
  render in software-rendered (headless / `swiftshader`) environments
  (`Binding weightsTexture not set`). Untested on real GPUs. Pinning deck.gl
  to 9.1 breaks because luma.gl 9.3 dropped exports (`gouraudLighting`,
  `getTypedArrayFromDataType`); a clean downgrade requires pinning every
  `@luma.gl/*` to 9.1.x via `overrides`. The Points layer is unaffected.

- **Stale-data filtering.** The CSVs contain old GPS-cache rows (year 2022,
  `(0,0)` coords, `1970-01-01 07:00:00`). `preprocess.mjs` rejects records
  outside `[fileDate-2d, fileDate+3d]` GMT+7, year < 2000, and `(0,0)`
  coordinates. Don't relax this without a reason — the resulting bbox /
  t_min went bad in early prototypes.

- **GMT+7 timestamps.** Source is GMT+7. The preprocessor stores **UTC unix
  seconds** in records (`tUtc/1000 - 7*3600`). The frontend's `formatBkk()`
  re-adds 7h for display. Don't double-adjust.

## Conventions

- **`webgis/tmp/`** is a sandbox for one-off scripts (header inspectors,
  Playwright smoke tests, etc.). Anything ad-hoc lives there as a named
  `*.mjs`/`*.sh` rather than as a long inline `node -e "..."` — those trigger
  per-command permission prompts and slow iteration.
- **`.cmd` files must use CRLF.** `cmd.exe` parses LF-only files as one giant
  line and emits "X is not recognized" for every other token. After any edit,
  verify with `head -c 100 run.cmd | od -c | head -3`.
- **Don't name a Windows batch file `start.cmd`** — it collides with cmd.exe's
  `start` builtin. `run.cmd` is the project's name.
- **Headless verification:** `webgis/tmp/browser_smoke.mjs` exists as a
  Playwright-against-running-dev-server smoke test. Real Chromium beats
  `chrome-headless-shell` for anything touching deck.gl aggregation layers
  (executable paths are hardcoded for the user's machine). 50s screenshots in
  headless software-rendering are normal for HeatmapLayer; that does not mean
  it's stuck.
