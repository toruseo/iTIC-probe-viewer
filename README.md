# iTIC Probe Viewer

English | [日本語](README.jp.md)

A browser-based Web GIS viewer for Thailand probe vehicle data ([open data](https://iticfoundation.org/en/open-data-sharing/) released by [iTIC](https://www.iticfoundation.org/)).

This is a work-in-progress prototype.

## Web version

https://toruseo.jp/iTIC-probe-viewer/

<p float="left">
   <img width="400" alt="dot data" src="https://github.com/user-attachments/assets/f0f9edb3-8a5d-443f-938c-1bd921379c69" />
   <img width="400" alt="average speed heatmap" src="https://github.com/user-attachments/assets/9cb85f72-d91c-4be5-b28d-324647a8b1c8" />
</p>
<p float="left">
   <img width="400" alt="individual trajectory" src="https://github.com/user-attachments/assets/02d09ef3-5a62-4baa-b107-9c0f9b5066f8" />
   <img width="400" alt="area time-series and MFD" src="https://github.com/user-attachments/assets/a4c88c69-9214-48b1-9132-fc960eba0f11" />
</p>

Only selected days are shipped on the public site, due to data size constraints.
If you would like to view data from other days, please use the local version described later.

## Controls

From the left panel:

| Control           | What it does                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| **Day**           | Pick the day to display                                                                            |
| **Time window**   | Specify the time window as `start–end` or `start + width`. Use the `10m / 30m / 1h / 3h` buttons below for one-click presets |
| **▶ Play**        | Animate the time window forward. Pick playback speed from `60x` to `1day/s`                        |
| **Layers**        | Toggle Points / Heatmap (count) / Heatmap (avg speed) / Hexagon (count) / Hexagon (avg heading) / selected vehicle trip |
| **Color by**      | Color the points by speed (with For-hire light as an option). The upper bound of the speed color scale (`speed color max`) is also set in this section |
| **Filter**        | only speed > 0 / speed ≤ 60 km/h (≃ exclude highways)                                              |
| **Polygon stats** | Draw a polygon on the map; for points inside it, plot 10-minute-bin time series of count and avg speed, plus an MFD (count vs count×avg speed, point color = time of day 0h→24h) |

Click any point on the map to display that vehicle's full trajectory for the day as a yellow line. Under **Polygon stats**, click `Draw polygon` and then click on the map to drop vertices; press `Finish` (≥3 vertices) to commit, and the time-series and MFD charts will be drawn at the bottom of the left panel. MFD point colors encode time of day (0h → 24h).

## Running locally

If you have iTIC-format CSVs (`VehicleID,gpsvalid,lat,lon,timestamp,speed,heading,for_hire,engine_acc`), you can build and visualize your own data locally. The data can be downloaded freely from the [official iTIC site](https://iticfoundation.org/en/open-data-sharing/).

1. Install [Node.js](https://nodejs.org/). On Windows, installing 7-Zip is also recommended.
2. Clone this repository.
3. Place iTIC archives (`PROBE-YYYYMM.tar.bz2`) directly under `PROBE_DATA_iTIC/` (no need to extract).
4. One-click launch:
   - Windows: run `run.cmd`
   - bash environments: `./run.sh`

The script handles dependency install, streamed extraction of the relevant day's CSV from the archive → binary conversion, starts the Vite dev server, and opens the browser. By default only the dates in `DEFAULT_DATES` of `webgis/preprocess/preprocess.mjs` are processed. To use arbitrary dates, set the environment variable:

```bash
cd webgis/preprocess
DATES=20250101,20250115,20250201 node preprocess.mjs
```

## Acknowledgments

We thank [iTIC](https://www.iticfoundation.org/) for making this open data available.

This is also part of the JST/JICA [SATREPS](https://www.jst.go.jp/global/) [3DTraffic](https://www.3dtraffic.t.u-tokyo.ac.jp/) project; we gratefully acknowledge their research funding.

## License

- Developed by [Toru Seo](https://toruseo.jp/), [Institute of Science Tokyo](https://seo.cv.ens.titech.ac.jp/en/index.html)
- Source code: MIT
- Data: © iTIC Foundation, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — see `PROBE_DATA_iTIC/README_ITIC.TXT`
