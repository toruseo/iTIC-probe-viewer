// CSV(iTIC probeデータ)からdeck.glフロントエンド用の日次パック済みバイナリを作る。
//
// レコードレイアウト(20バイト、リトルエンディアン):
//   off 0  f32 lon
//   off 4  f32 lat
//   off 8  u32 t_unix         (UTC秒。元データのタイムスタンプはGMT+7)
//   off 12 u8  speed_kmh      (0..255にクランプ)
//   off 13 u8  heading_div2   (heading_deg/2、0..180)
//   off 14 u8  flags          (bit0 for_hire、bit1 engine_acc、bit2 gps_valid)
//   off 15 u8  _pad
//   off 16 u32 vid            (vehicles.jsonへのインデックス)
//
// ヘッダ(64バイト、リトルエンディアン):
//   off 0  char[4] 'PROB'
//   off 4  u32 version=1
//   off 8  u32 count
//   off 12 u32 date_yyyymmdd
//   off 16 u32 t_min_unix
//   off 20 u32 t_max_unix
//   off 24 u32 unique_vehicles_today  (パーキングフィルタ後の当日生存レコードに現れるユニークvid数)
//   off 28 f32 min_lon
//   off 32 f32 min_lat
//   off 36 f32 max_lon
//   off 40 f32 max_lat
//   off 44 _reserved (20バイト)

import { createReadStream, createWriteStream, statSync, existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// 元アーカイブ(PROBE-YYYYMM.tar.bz2)はPROBE_DATA_iTIC/に置く。
// 日次処理では、月単位アーカイブを*まるごと*一度TMP_DIRに展開してから、各日のCSVをディスクから読む。
// 以前のストリーミング方式(`tar -xjOf … | node`)はNodeのreadlineがbzip2に背圧をかけ、1日あたり約17分かかっていた。
// 全展開ならbzip2の処理がCPUバウンドの1パスで終わり、各日の読み込みは1秒未満になる。
//
// TMP_DIRはアーカイブごとの日処理が終わった時点で削除する(KEEP_TMP=1指定時を除く)。
const SRC_DIR = resolve(process.argv[2] || '../../PROBE_DATA_iTIC');
const OUT_DIR = resolve(process.argv[3] || '../app/public/data');
const TMP_DIR = resolve(process.env.TMP_EXTRACT_DIR || './.tmp');

// 抽出対象の日付。`DATES=20250101,20250115,...`で上書きできる。
// デフォルトはリポジトリが事前処理済みで同梱しているデモ日付:2017〜2025年の各年について9月中旬の水曜日と、その直後の日曜日。
const DEFAULT_DATES = [
  20170913, 20170917,
  20180912, 20180916,
  20190918, 20190922,
  20200916, 20200920,
  20210915, 20210919,
  20220914, 20220918,
  20230913, 20230917,
  20240918, 20240922,
  20250917, 20250921,
];

// Windows上のGNU tarは--force-localを付けないと`C:\...`をリモートホスト扱いする。macOSのBSD tarにはこのフラグが無いが、POSIXパスでは必要ない。
const TAR_LOCAL_FLAGS = platform() === 'win32' ? ['--force-local'] : [];

// Windows同梱のtar.exeのbzip2実装は7-Zipと比べて極端に遅い(実測で約25倍差。1.4GBのtar.bz2でtar.exe経由が約25分、7z.exe経由が約1分)。
// 7z.exeが見つかればそれを使い、それ以外(POSIX)はGNU tarで直接処理する(こちらは問題ない)。
function find7z() {
  if (platform() !== 'win32') return null;
  const env7z = process.env.SEVENZIP_EXE;
  if (env7z && existsSync(env7z)) return env7z;
  for (const p of [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}
const SEVEN_ZIP = find7z();

const RECORD_SIZE = 20;
const HEADER_SIZE = 64;

// 駐車停止フィルタ: 各車両ごとに時刻順に並べたうえで、速度0の連続区間のうち継続時間がSTOP_SEC以上のものを丸ごと落とす。
// 短い停止(信号待ち、客先での短時間アイドリングなど)は残す。生レコードの約70%はspeed=0なので、ここが転送量を抑える主要な調整箇所。
// PARK_FILTER=0で無効化、STOP_SECでデフォルト1200秒(20分)を上書きできる。
const PARK_FILTER = !process.env.PARK_FILTER || process.env.PARK_FILTER !== '0';
const STOP_SEC = +(process.env.STOP_SEC || 1200);

mkdirSync(OUT_DIR, { recursive: true });

const vehicleDict = new Map();
const getVid = (s) => {
  let v = vehicleDict.get(s);
  if (v === undefined) { v = vehicleDict.size; vehicleDict.set(s, v); }
  return v;
};

// 月単位アーカイブを`destParent`に丸ごと展開する。tarが正常終了したら解決し、それ以外はstderrを添えて拒否する。
// 展開後のレイアウトはアーカイブそのままで、`destParent/PROBE-YYYYMM/YYYYMMDD.csv.out`になる。
function spawnP(exe, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'inherit', 'pipe'], ...opts });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); process.stderr.write(b); });
    child.on('error', rej);
    child.on('exit', (code) => {
      if (code === 0) res();
      else rej(new Error(`${exe} exit ${code}: ${stderr.trim()}`));
    });
  });
}

async function extractArchive(archivePath, destParent) {
  if (SEVEN_ZIP) {
    // 7zは.tar.bz2を2パス(bz2→tar、その後untar)で処理する。パイプ経由の1パスも可能だが、Node側のパイプバッファリングが先ほど避けたのと同じスロットリング問題を再導入してしまう。
    // ディスクを介した2パスでも、この開発機の1.4GBアーカイブなら合計約1分で済む。
    const tarName = archivePath.split(/[\\/]/).pop().replace(/\.bz2$/i, '');
    const tarPath = join(destParent, tarName);
    await spawnP(SEVEN_ZIP, ['x', archivePath, `-o${destParent}`, '-y']);
    try {
      await spawnP(SEVEN_ZIP, ['x', tarPath, `-o${destParent}`, '-y']);
    } finally {
      rmSync(tarPath, { force: true });
    }
  } else {
    // POSIX側: ビルトインbzip2を使ったGNU tarで十分速い。
    // cwdはWindowsでtarが`-C C:\…`をホスト名と誤解する問題を回避するためのもので、POSIXパスにはコロンがないのでここでは実質無害な安全策。
    await spawnP('tar', [...TAR_LOCAL_FLAGS, '-xjf', archivePath], { cwd: destParent });
  }
}

// 各車両ごとに時刻順で見たときに、長い速度0連続区間に属するレコードを削除対象としてマークする。戻り値はUint8Array(count)で、1なら削除対象。
// メモリ: 約5*countバイト(インデックス+フラグ) + 8*vehicleCount。
function markParkedRuns(buf, count, vehicleCount, stopSec) {
  const drop = new Uint8Array(count);
  if (count === 0 || vehicleCount === 0) return { drop, droppedCount: 0 };

  // 接頭和を使ってvidごとにレコードをバケット化し、`indicesByVid`内で各車両のレコードが連続するようにする。
  // 車両ごとのJS配列を作る方式(400万レコードで約256MBオーバーヘッド)を避ける。型付き配列のバケットなら合計で約16MBに収まる。
  const vidCounts = new Uint32Array(vehicleCount);
  for (let i = 0; i < count; i++) vidCounts[buf.readUInt32LE(i * RECORD_SIZE + 16)]++;
  const vidStart = new Uint32Array(vehicleCount + 1);
  for (let v = 0; v < vehicleCount; v++) vidStart[v + 1] = vidStart[v] + vidCounts[v];
  const indicesByVid = new Uint32Array(count);
  const cursor = new Uint32Array(vehicleCount);
  for (let i = 0; i < count; i++) {
    const vid = buf.readUInt32LE(i * RECORD_SIZE + 16);
    indicesByVid[vidStart[vid] + cursor[vid]++] = i;
  }

  // 車両ごとに、そのインデックススライスをtでインプレースソートし、速度0の連続区間を歩きながら識別する。
  // 区間の継続時間(last_t - first_t)がstopSec以上なら、それは交通停止ではなく駐車扱いなので、その区間のレコードを全て落とす。
  const cmp = (a, b) => buf.readUInt32LE(a * RECORD_SIZE + 8) - buf.readUInt32LE(b * RECORD_SIZE + 8);
  let droppedCount = 0;
  for (let v = 0; v < vehicleCount; v++) {
    const start = vidStart[v];
    const end = vidStart[v + 1];
    if (start === end) continue;
    const slice = indicesByVid.subarray(start, end);
    slice.sort(cmp);

    let runStart = -1;
    let runStartT = 0;
    let runEndT = 0;
    for (let k = 0; k < slice.length; k++) {
      const off = slice[k] * RECORD_SIZE;
      const isZero = buf.readUInt8(off + 12) === 0;
      if (isZero) {
        const t = buf.readUInt32LE(off + 8);
        if (runStart === -1) { runStart = k; runStartT = t; }
        runEndT = t;
      } else if (runStart !== -1) {
        if (runEndT - runStartT >= stopSec) {
          for (let m = runStart; m < k; m++) { drop[slice[m]] = 1; droppedCount++; }
        }
        runStart = -1;
      }
    }
    if (runStart !== -1 && runEndT - runStartT >= stopSec) {
      for (let m = runStart; m < slice.length; m++) { drop[slice[m]] = 1; droppedCount++; }
    }
  }

  return { drop, droppedCount };
}

async function processFile(inputStream, dateYmd) {
  const t0 = Date.now();
  let cap = 1 << 20;
  let buf = Buffer.alloc(cap * RECORD_SIZE);
  let count = 0;
  let lineNo = 0, skipped = 0;

  // ファイル名の日付から大きく外れたタイムスタンプの古い・キャッシュ済みprobeを除外する。
  // 許容窓: GMT+7で[date-2日, date+3日]を、UTCのunix秒で表したもの。
  const yy = Math.floor(dateYmd / 10000);
  const mn = Math.floor((dateYmd / 100) % 100);
  const dy = dateYmd % 100;
  const dayStartUtc = Date.UTC(yy, mn - 1, dy) / 1000 - 7 * 3600;
  const tValidMin = dayStartUtc - 2 * 86400;
  const tValidMax = dayStartUtc + 3 * 86400;

  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNo++;
    if (!line) { skipped++; continue; }
    const p = line.split(',');
    if (p.length < 9) { skipped++; continue; }

    const lat = +p[2];
    const lon = +p[3];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { skipped++; continue; }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) { skipped++; continue; }
    if (lat === 0 && lon === 0) { skipped++; continue; }

    const ts = p[4];
    if (ts.length < 19) { skipped++; continue; }
    const yyyy = +ts.slice(0, 4);
    const mm = +ts.slice(5, 7);
    const dd = +ts.slice(8, 10);
    const HH = +ts.slice(11, 13);
    const MM = +ts.slice(14, 16);
    const SS = +ts.slice(17, 19);
    if (yyyy < 2000 || yyyy > 2100) { skipped++; continue; }
    const tUtc = Date.UTC(yyyy, mm - 1, dd, HH, MM, SS);
    if (!Number.isFinite(tUtc)) { skipped++; continue; }
    const tUnixSigned = tUtc / 1000 - 7 * 3600;
    if (tUnixSigned < tValidMin || tUnixSigned > tValidMax) { skipped++; continue; }
    const tUnix = tUnixSigned >>> 0;

    const speed = Math.min(255, Math.max(0, +p[5] | 0));
    const heading = Math.min(360, Math.max(0, +p[6] | 0));
    const forHire = (+p[7] | 0) ? 1 : 0;
    const engineAcc = (+p[8] | 0) ? 1 : 0;
    const gpsValid = (+p[1] | 0) ? 1 : 0;

    const vid = getVid(p[0]);

    if (count === cap) {
      cap *= 2;
      const nbuf = Buffer.alloc(cap * RECORD_SIZE);
      buf.copy(nbuf, 0, 0, count * RECORD_SIZE);
      buf = nbuf;
    }
    const off = count * RECORD_SIZE;
    buf.writeFloatLE(lon, off);
    buf.writeFloatLE(lat, off + 4);
    buf.writeUInt32LE(tUnix, off + 8);
    buf.writeUInt8(speed, off + 12);
    buf.writeUInt8((heading >> 1) & 0xff, off + 13);
    buf.writeUInt8((forHire) | (engineAcc << 1) | (gpsValid << 2), off + 14);
    // off + 15 はゼロのまま
    buf.writeUInt32LE(vid >>> 0, off + 16);
    count++;

    if ((count & 0x7FFFF) === 0) process.stdout.write('.');
  }

  // 駐車フィルタ: 長い速度0連続区間をインプレースで落とす。bbox/t範囲はこの後で生存レコードから再計算するので、ヘッダはフィルタ前の範囲ではなく実際に出力される内容を反映する。
  const rawCount = count;
  let droppedParked = 0;
  if (PARK_FILTER) {
    const tFilter = Date.now();
    const { drop, droppedCount } = markParkedRuns(buf, count, vehicleDict.size, STOP_SEC);
    droppedParked = droppedCount;
    let writeIdx = 0;
    for (let i = 0; i < count; i++) {
      if (drop[i]) continue;
      if (writeIdx !== i) {
        buf.copy(buf, writeIdx * RECORD_SIZE, i * RECORD_SIZE, (i + 1) * RECORD_SIZE);
      }
      writeIdx++;
    }
    count = writeIdx;
    process.stdout.write(`[park ${((Date.now() - tFilter) / 1000).toFixed(1)}s drop=${droppedCount.toLocaleString()}]`);
  }

  // (フィルタ後の可能性がある)レコードからbboxとt範囲を再計算する。
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  let tMin = 0xFFFFFFFF, tMax = 0;
  for (let i = 0; i < count; i++) {
    const off = i * RECORD_SIZE;
    const lon = buf.readFloatLE(off);
    const lat = buf.readFloatLE(off + 4);
    const t = buf.readUInt32LE(off + 8);
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (count === 0) { minLon = minLat = maxLon = maxLat = 0; tMin = tMax = 0; }

  // 日次のユニークvid数(フィルタ後)。以前はここにグローバル辞書の累計サイズを書き込んでいたが、処理順で値がズレるうえに、その日の合計とも実行全体の合計とも一致せず、UIの"unique vehicles"統計で混乱を招いていた。
  // ユーザが期待するのはあくまで日次のカウント。
  const seenVid = new Uint8Array(vehicleDict.size);
  let uniqueVehiclesToday = 0;
  for (let i = 0; i < count; i++) {
    const vid = buf.readUInt32LE(i * RECORD_SIZE + 16);
    if (!seenVid[vid]) { seenVid[vid] = 1; uniqueVehiclesToday++; }
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.write('PROB', 0, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(dateYmd >>> 0, 12);
  header.writeUInt32LE(tMin, 16);
  header.writeUInt32LE(tMax, 20);
  header.writeUInt32LE(uniqueVehiclesToday, 24);
  header.writeFloatLE(minLon, 28);
  header.writeFloatLE(minLat, 32);
  header.writeFloatLE(maxLon, 36);
  header.writeFloatLE(maxLat, 40);

  const outPath = join(OUT_DIR, `${dateYmd}.bin`);
  await new Promise((res, rej) => {
    const ws = createWriteStream(outPath);
    ws.on('error', rej);
    ws.on('finish', res);
    ws.write(header);
    ws.write(buf.subarray(0, count * RECORD_SIZE));
    ws.end();
  });

  return {
    date: dateYmd,
    count,
    raw_count: rawCount,
    dropped_parked: droppedParked,
    unique_vehicles: uniqueVehiclesToday,
    skipped,
    line_count: lineNo,
    t_min: tMin,
    t_max: tMax,
    bbox: [minLon, minLat, maxLon, maxLat],
    file: `${dateYmd}.bin`,
    elapsed_ms: Date.now() - t0,
  };
}

function parseDates() {
  const env = process.env.DATES;
  if (env) {
    const list = env.split(',').map(s => +s.trim()).filter(d => /^\d{8}$/.test(String(d)));
    if (list.length === 0) {
      console.error(`DATES env var present but no valid YYYYMMDD entries: ${env}`);
      process.exit(1);
    }
    return list;
  }
  return DEFAULT_DATES.slice();
}

async function main() {
  if (!existsSync(SRC_DIR) || !statSync(SRC_DIR).isDirectory()) {
    console.error(`Source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }
  const archives = readdirSync(SRC_DIR).filter(f => /^PROBE-\d{6}\.tar\.bz2$/.test(f));
  if (archives.length === 0) {
    console.error(`No PROBE-YYYYMM.tar.bz2 archives in ${SRC_DIR}`);
    process.exit(1);
  }
  const archiveByMonth = new Map();
  for (const a of archives) archiveByMonth.set(+a.slice(6, 12), a);

  let dates = parseDates();
  const limit = +process.env.LIMIT;
  if (Number.isFinite(limit) && limit > 0) dates = dates.slice(0, limit);

  // APPEND=1にすると既存のvehicles.json/meta.jsonを再利用するので、出荷済みの*.binファイルに焼き込まれたvidインデックスが引き続き有効になる。
  // このフラグが無い場合は辞書をゼロから組み直す。クリーンリビルドには問題ないが、vidの対応が変わるので過去に生成済みの.binは全て無効になる。
  const append = !!process.env.APPEND && process.env.APPEND !== '0';
  const metaPath = join(OUT_DIR, 'meta.json');
  const vehiclesPath = join(OUT_DIR, 'vehicles.json');

  const meta = {
    generated_at: new Date().toISOString(),
    record_size: RECORD_SIZE,
    header_size: HEADER_SIZE,
    timezone_offset_hours: 7,
    days: [],
  };

  if (append) {
    if (existsSync(vehiclesPath)) {
      const existing = JSON.parse(readFileSync(vehiclesPath, 'utf8'));
      for (let i = 0; i < existing.length; i++) vehicleDict.set(existing[i], i);
      console.log(`append : seeded vehicleDict from ${existing.length.toLocaleString()} existing IDs`);
    }
    if (existsSync(metaPath)) {
      const existing = JSON.parse(readFileSync(metaPath, 'utf8'));
      const reproc = new Set(dates);
      meta.days = (existing.days || []).filter((d) => !reproc.has(d.date));
      console.log(`append : kept ${meta.days.length} existing day(s) from meta.json (reprocessing ${dates.length})`);
    }
  }

  console.log(`src    : ${SRC_DIR}`);
  console.log(`out    : ${OUT_DIR}`);
  console.log(`dates  : ${dates.join(', ')}${append ? '  (APPEND mode)' : ''}`);

  // 指定された日付を元アーカイブごとにグループ化して、1回の実行で各アーカイブを最大1度しか展開しないようにする。
  // KEEP_TMP=1にすると展開済みCSVをディスクに残し、開発時の繰り返し実行で必要日が全て揃っていれば展開をスキップできる。
  const datesByArchive = new Map();
  for (const d of dates) {
    const m = Math.floor(d / 100);
    if (!datesByArchive.has(m)) datesByArchive.set(m, []);
    datesByArchive.get(m).push(d);
  }
  const keepTmp = !!process.env.KEEP_TMP && process.env.KEEP_TMP !== '0';
  mkdirSync(TMP_DIR, { recursive: true });
  console.log(`tmp    : ${TMP_DIR}${keepTmp ? '  (KEEP_TMP=1: not deleted at end)' : ''}`);
  console.log(`extract: ${SEVEN_ZIP ? `7z (${SEVEN_ZIP})` : 'tar -xjf'}`);

  for (const [yyyymm, datesInArchive] of datesByArchive) {
    const archiveName = archiveByMonth.get(yyyymm);
    if (!archiveName) {
      console.warn(`no archive for ${yyyymm}, skipping ${datesInArchive.join(',')}`);
      continue;
    }
    const archivePath = join(SRC_DIR, archiveName);
    const extractDir = join(TMP_DIR, `PROBE-${yyyymm}`);
    const neededPaths = datesInArchive.map((d) => join(extractDir, `${d}.csv.out`));
    const allPresent = neededPaths.every((p) => existsSync(p) && statSync(p).size > 0);

    try {
      if (allPresent) {
        console.log(`reusing extracted ${extractDir}`);
      } else {
        const aSizeMB = (statSync(archivePath).size / 1e6).toFixed(1);
        console.log(`extracting ${archiveName} (${aSizeMB}MB) → ${extractDir}…`);
        const t0 = Date.now();
        await extractArchive(archivePath, TMP_DIR);
        console.log(`  extracted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }

      for (const dateYmd of datesInArchive) {
        const csvPath = join(extractDir, `${dateYmd}.csv.out`);
        if (!existsSync(csvPath)) {
          console.warn(`[${dateYmd}] missing in extract: ${csvPath}, skipping`);
          continue;
        }
        const sizeMB = (statSync(csvPath).size / 1e6).toFixed(1);
        process.stdout.write(`[${dateYmd}] (csv ${sizeMB}MB) `);
        const r = await processFile(createReadStream(csvPath), dateYmd);
        console.log(` ${r.count.toLocaleString()} pts  skip=${r.skipped}  ${(r.elapsed_ms / 1000).toFixed(1)}s`);
        if (r.count === 0) {
          console.warn(`[${dateYmd}] zero records — wrong CSV path? expected ${csvPath}`);
        }
        meta.days.push(r);
        meta.days.sort((a, b) => a.date - b.date);
        meta.vehicle_count = vehicleDict.size;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
    } finally {
      if (!keepTmp) {
        rmSync(extractDir, { recursive: true, force: true });
      }
    }
  }

  if (!keepTmp) {
    try {
      if (readdirSync(TMP_DIR).length === 0) rmSync(TMP_DIR, { recursive: true, force: true });
    } catch { /* 無視 */ }
  }

  const vehicles = new Array(vehicleDict.size);
  for (const [k, v] of vehicleDict) vehicles[v] = k;
  writeFileSync(vehiclesPath, JSON.stringify(vehicles));
  console.log(`vehicles.json: ${vehicles.length.toLocaleString()} unique IDs`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
