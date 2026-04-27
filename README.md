# iTIC Probe Viewer

タイの車両プローブデータ（[iTIC](https://www.iticfoundation.org/) 公開．[公式オープンデータページ](https://iticfoundation.org/en/open-data-sharing/)）を、ブラウザ上で軽快に眺めるためのビューアです。1日あたり 180 万点超の GPS ログを 60 fps で描画します。

開発中のプロトタイプです．

## デモ

> **🌐 Live demo**: https://&lt;your-github-username&gt;.github.io/itic-probe-viewer/
> 
> （リポジトリ公開後に GitHub Pages で配信されます）

サンプル日（2025‑01‑01）が同梱されています。日付セレクタからすぐ可視化が始まります。


<p float="left">
<img width="400" alt="image2" src="https://github.com/user-attachments/assets/540b592a-7b4f-4e41-b225-e8a075679730" />
<img width="400" alt="image1" src="https://github.com/user-attachments/assets/2bce0e44-30ef-47f6-ace0-884c124fbb49" />
</p>

## 操作

左パネルから:

| コントロール          | できること                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| **Day**         | 表示する日を選ぶ                                                                   |
| **Time window** | 時刻ウィンドウを `start–end` または `start + 幅` で指定。下の `10m / 30m / 1h / 3h` ボタンで一発設定 |
| **▶ Play**      | 時刻ウィンドウをアニメーションで進める。`60x`–`1day/s` から再生速度を選択                               |
| **Layers**      | Points（点群）/ Heatmap / Hexagon (3D) / 選択車両の軌跡 を切替                           |
| **Color by**    | 速度・進行方向・For-hire ランプ・エンジン状態 で着色                                            |
| **Filter**      | GPS valid / 移動中 / 速度上限                                                     |

地図上の点をクリックすると、その車両の当日全軌跡が黄色のラインで表示されます。

## 自分のデータで使う

iTIC 形式の CSV（`VehicleID,gpsvalid,lat,lon,timestamp,speed,heading,for_hire,engine_acc`）を持っていれば、ローカルでビルドして自分のデータを可視化できます。

1. [Node.js](https://nodejs.org/) 20+ をインストール
2. このリポジトリをクローン
3. iTIC アーカイブを `PROBE_DATA_iTIC/PROBE-YYYYMM.tar.bz2` から `PROBE-YYYYMM/` に展開
4. ワンクリック起動:
   - Windows: エクスプローラから `run.cmd` をダブルクリック
   - bash 環境: `./run.sh`

スクリプトが依存関係のインストール、CSV → バイナリ変換、Vite dev サーバ起動、ブラウザ表示まで自動で行います。

## その他

[SATREPS](https://www.jst.go.jp/global/) [3DTraffic](https://www.3dtraffic.t.u-tokyo.ac.jp/)プロジェクトの一環です．

## ライセンス

- ソースコード: MIT
- データ: © iTIC Foundation, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — `PROBE_DATA_iTIC/README_ITIC.TXT` 参照
