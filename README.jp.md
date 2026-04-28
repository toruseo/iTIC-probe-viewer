# iTIC Probe Viewer

[English](README.md) | 日本語

タイのプローブカーデータ（[iTIC](https://www.iticfoundation.org/) 提供[オープンデータ](https://iticfoundation.org/en/open-data-sharing/)）を、ブラウザ上で軽快に閲覧するWeb GISビューアです．

開発中のプロトタイプです．

## Web版

https://toruseo.jp/iTIC-probe-viewer/

<p float="left">
   <img width="400" alt="dot data" src="https://github.com/user-attachments/assets/f0f9edb3-8a5d-443f-938c-1bd921379c69" />
   <img width="400" alt="average speed heatmap" src="https://github.com/user-attachments/assets/9cb85f72-d91c-4be5-b28d-324647a8b1c8" />
</p>
<p float="left">
   <img width="400" alt="individual trajectory" src="https://github.com/user-attachments/assets/02d09ef3-5a62-4baa-b107-9c0f9b5066f8" />
   <img width="400" alt="area time-series and MFD" src="https://github.com/user-attachments/assets/a4c88c69-9214-48b1-9132-fc960eba0f11" />
</p>

データサイズの都合上，特定の日のみアップロードしています．
他の日のデータを閲覧したい場合，後述するローカル版を各自で使用してください．

## 操作

左パネルから:

| コントロール            | できること                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **Day**           | 表示する日を選ぶ                                                                                    |
| **Time window**   | 時刻ウィンドウを `start–end` または `start + 幅` で指定。下の `10m / 30m / 1h / 3h` ボタンで一発設定                  |
| **▶ Play**        | 時刻ウィンドウをアニメーションで進める。`60x`–`1day/s` から再生速度を選択                                                |
| **Layers**        | Points（点群）/ Heatmap (count) / Heatmap (avg speed) / Hexagon (count) / Hexagon (avg heading) / 選択車両の軌跡 を切替              |
| **Color by**      | 点群を速度（オプションで For-hire ランプ）で着色。速度の色スケール上限（`speed color max`）も同セクションで指定                                                             |
| **Filter**        | only speed > 0 / speed ≤ 60 km/h（≃ 高速道路除外）                                                                      |
| **Polygon stats** | 地図上にポリゴンを描き、その範囲内の点群について count と avg speed の 10 分ビン時系列、および MFD（count vs count×avg speed、点色は時刻 0h→24h）を表示 |

地図上の点をクリックすると、その車両の当日全軌跡が黄色のラインで表示されます。**Polygon stats** の `Draw polygon` を押してから地図上を順にクリックすると頂点が打たれ、`Finish`（≥3 頂点）で確定して左パネル下部に時系列と MFD が描画されます。MFD の点色は時刻（0h → 24h）に対応します。

## ローカルで使用する

iTIC 形式の CSV（`VehicleID,gpsvalid,lat,lon,timestamp,speed,heading,for_hire,engine_acc`）を持っていれば、ローカルでビルドして自分のデータを可視化できます。
データは[iTICの公式サイト](https://iticfoundation.org/en/open-data-sharing/)から自由にダウンロードできます．

1. [Node.js](https://nodejs.org/) をインストール．Windowsの場合7-Zipのインストールも推奨
2. このリポジトリをクローン
3. iTIC アーカイブ（`PROBE-YYYYMM.tar.bz2`）を `PROBE_DATA_iTIC/` の直下に置く（解凍は不要）
4. ワンクリック起動:
   - Windows:  `run.cmd` を起動
   - bash 環境: `./run.sh`

スクリプトが依存関係のインストール、アーカイブからの該当日 CSV のストリーム抽出 → バイナリ変換、Vite dev サーバ起動、ブラウザ表示まで自動で行います。デフォルトでは `webgis/preprocess/preprocess.mjs` の `DEFAULT_DATES` の日付だけを処理します。任意の日付に切り替えるには環境変数で指定:

```bash
cd webgis/preprocess
DATES=20250101,20250115,20250201 node preprocess.mjs
```

## 謝辞

オープンデータを公開していただいた[iTIC](https://www.iticfoundation.org/)に感謝いたします．

また，これはJST/JICAの[SATREPS](https://www.jst.go.jp/global/) [3DTraffic](https://www.3dtraffic.t.u-tokyo.ac.jp/)プロジェクトの一環であり，研究助成に感謝いたします．

## ライセンス

- ソースコード: MIT
- データ: © iTIC Foundation, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — `PROBE_DATA_iTIC/README_ITIC.TXT` 参照
