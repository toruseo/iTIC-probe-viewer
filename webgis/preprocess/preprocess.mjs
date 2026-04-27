// CSV (iTIC probe data) -> per-day packed binary for the deck.gl frontend.
//
// Record layout (20 bytes, little-endian):
//   off 0  f32 lon
//   off 4  f32 lat
//   off 8  u32 t_unix         (UTC seconds; source timestamps are GMT+7)
//   off 12 u8  speed_kmh      (clamped 0..255)
//   off 13 u8  heading_div2   (heading_deg/2, 0..180)
//   off 14 u8  flags          (bit0 for_hire, bit1 engine_acc, bit2 gps_valid)
//   off 15 u8  _pad
//   off 16 u32 vid            (index into vehicles.json)
//
// Header (64 bytes, little-endian):
//   off 0  char[4] 'PROB'
//   off 4  u32 version=1
//   off 8  u32 count
//   off 12 u32 date_yyyymmdd
//   off 16 u32 t_min_unix
//   off 20 u32 t_max_unix
//   off 24 u32 vehicle_count_global
//   off 28 f32 min_lon
//   off 32 f32 min_lat
//   off 36 f32 max_lon
//   off 40 f32 max_lat
//   off 44 _reserved (20 bytes)

import { createReadStream, createWriteStream, statSync, existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// Source archives (PROBE-YYYYMM.tar.bz2) live in PROBE_DATA_iTIC/.
// To process a day, we extract the *whole* monthly archive once into TMP_DIR,
// then read individual days off disk. The earlier streaming approach
// (`tar -xjOf … | node`) backpressured bzip2 against Node's readline and
// burned ~17 min per day; full extraction completes the bzip2 work in one
// CPU-bound pass and per-day reads are sub-second.
//
// TMP_DIR is wiped after each archive's days are done, unless KEEP_TMP=1.
const SRC_DIR = resolve(process.argv[2] || '../../PROBE_DATA_iTIC');
const OUT_DIR = resolve(process.argv[3] || '../app/public/data');
const TMP_DIR = resolve(process.env.TMP_EXTRACT_DIR || './.tmp');

// Which dates to extract. Override with `DATES=20250101,20250115,...`
// Default = the bundled demo days the repo ships preprocessed.
const DEFAULT_DATES = [20250101, 20250201, 20250919];

// GNU tar on Windows treats `C:\...` as a remote host unless --force-local is
// passed. macOS BSD tar lacks the flag but doesn't need it (POSIX paths).
const TAR_LOCAL_FLAGS = platform() === 'win32' ? ['--force-local'] : [];

// On Windows, the bundled tar.exe's bzip2 implementation is dramatically
// slower than 7-Zip (observed ~25× difference: 1.4 GB tar.bz2 took ~25 min
// via tar.exe vs ~1 min via 7z.exe). When 7z.exe is available we route
// extraction through it; everywhere else (POSIX) we use GNU tar directly,
// which is fine.
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

mkdirSync(OUT_DIR, { recursive: true });

const vehicleDict = new Map();
const getVid = (s) => {
  let v = vehicleDict.get(s);
  if (v === undefined) { v = vehicleDict.size; vehicleDict.set(s, v); }
  return v;
};

// Extract a whole monthly archive into `destParent`. Returns when tar exits
// successfully; rejects with the captured stderr otherwise. The resulting
// layout matches the archive: `destParent/PROBE-YYYYMM/YYYYMMDD.csv.out`.
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
    // 7z handles .tar.bz2 in two passes: bz2→tar, then untar. Pipe-based
    // single-pass would also work but Node-level pipe buffering reintroduces
    // the same throttling issue we just escaped from. Two passes via disk is
    // ~1 min total for a 1.4 GB archive on this dev box.
    const tarName = archivePath.split(/[\\/]/).pop().replace(/\.bz2$/i, '');
    const tarPath = join(destParent, tarName);
    await spawnP(SEVEN_ZIP, ['x', archivePath, `-o${destParent}`, '-y']);
    try {
      await spawnP(SEVEN_ZIP, ['x', tarPath, `-o${destParent}`, '-y']);
    } finally {
      rmSync(tarPath, { force: true });
    }
  } else {
    // POSIX path: GNU tar with built-in bzip2 is fast enough.
    // cwd avoids tar's `-C C:\…` colon-as-host mis-parse on Windows, but on
    // POSIX paths there is no colon, so this is a no-op safety measure.
    await spawnP('tar', [...TAR_LOCAL_FLAGS, '-xjf', archivePath], { cwd: destParent });
  }
}

async function processFile(inputStream, dateYmd) {
  const t0 = Date.now();
  let cap = 1 << 20;
  let buf = Buffer.alloc(cap * RECORD_SIZE);
  let count = 0;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  let tMin = 0xFFFFFFFF, tMax = 0;
  let lineNo = 0, skipped = 0;

  // Filter out stale/cached probes whose timestamp falls far outside the filename's date.
  // Window: [date-2d, date+3d] in GMT+7, expressed in UTC unix seconds.
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
    // off + 15 left as 0
    buf.writeUInt32LE(vid >>> 0, off + 16);
    count++;

    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
    if (tUnix < tMin) tMin = tUnix;
    if (tUnix > tMax) tMax = tUnix;

    if ((count & 0x7FFFF) === 0) process.stdout.write('.');
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.write('PROB', 0, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(dateYmd >>> 0, 12);
  header.writeUInt32LE(tMin, 16);
  header.writeUInt32LE(tMax, 20);
  header.writeUInt32LE(vehicleDict.size, 24);
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

  // APPEND=1 reuses the existing vehicles.json/meta.json so that vid indices
  // already baked into shipped *.bin files stay valid. Without this flag the
  // dictionary is built from scratch — fine for a clean rebuild, but it
  // invalidates every previously-emitted .bin since vid mapping shifts.
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

  // Group requested dates by their source archive so we extract each archive
  // at most once per run. KEEP_TMP=1 leaves the extracted CSVs on disk for
  // iterative dev re-runs (skip extraction if all needed days are present).
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
    } catch { /* ignore */ }
  }

  const vehicles = new Array(vehicleDict.size);
  for (const [k, v] of vehicleDict) vehicles[v] = k;
  writeFileSync(vehiclesPath, JSON.stringify(vehicles));
  console.log(`vehicles.json: ${vehicles.length.toLocaleString()} unique IDs`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
