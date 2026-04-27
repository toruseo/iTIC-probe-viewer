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

import { createWriteStream, statSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// New layout (2026-04): the original iTIC archives stay compressed in
// PROBE_DATA_iTIC/ as `PROBE-YYYYMM.tar.bz2`. We stream individual days out of
// each archive via `tar -xjOf` (no on-disk extraction).
const SRC_DIR = resolve(process.argv[2] || '../../PROBE_DATA_iTIC');
const OUT_DIR = resolve(process.argv[3] || '../app/public/data');

// Which dates to extract. Override with `DATES=20250101,20250115,...`
// Default = the two bundled demo days the repo ships preprocessed.
const DEFAULT_DATES = [20250101, 20250201];

// GNU tar on Windows treats `C:\...` as a remote host unless --force-local is
// passed. macOS BSD tar lacks the flag but doesn't need it (POSIX paths).
const TAR_LOCAL_FLAGS = platform() === 'win32' ? ['--force-local'] : [];

const RECORD_SIZE = 20;
const HEADER_SIZE = 64;

mkdirSync(OUT_DIR, { recursive: true });

const vehicleDict = new Map();
const getVid = (s) => {
  let v = vehicleDict.get(s);
  if (v === undefined) { v = vehicleDict.size; vehicleDict.set(s, v); }
  return v;
};

// Open a readable stream of one day's CSV by streaming a single member out of
// the month archive. tar's `-O` writes the member to stdout, so we never
// materialize the decompressed CSV on disk.
function openCsvStreamFromArchive(archivePath, member) {
  const args = [...TAR_LOCAL_FLAGS, '-xjOf', archivePath, member];
  const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  child.on('error', (e) => {
    console.error(`tar spawn failed: ${e.message}`);
  });
  child.on('exit', (code) => {
    if (code !== 0 && stderr) {
      // Surface tar's complaints (missing member, bad archive, etc.).
      process.stderr.write(`\ntar exit ${code}: ${stderr.trim()}\n`);
    }
  });
  return child.stdout;
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

  console.log(`src    : ${SRC_DIR}`);
  console.log(`out    : ${OUT_DIR}`);
  console.log(`dates  : ${dates.join(', ')}`);

  const meta = {
    generated_at: new Date().toISOString(),
    record_size: RECORD_SIZE,
    header_size: HEADER_SIZE,
    timezone_offset_hours: 7,
    days: [],
  };

  for (const dateYmd of dates) {
    const yyyymm = Math.floor(dateYmd / 100);
    const archiveName = archiveByMonth.get(yyyymm);
    if (!archiveName) {
      console.warn(`[${dateYmd}] no archive for ${yyyymm}, skipping`);
      continue;
    }
    const archivePath = join(SRC_DIR, archiveName);
    const member = `PROBE-${yyyymm}/${dateYmd}.csv.out`;
    const sizeMB = (statSync(archivePath).size / 1e6).toFixed(1);
    process.stdout.write(`[${archiveName}::${dateYmd}] (archive ${sizeMB}MB) `);
    const stream = openCsvStreamFromArchive(archivePath, member);
    const r = await processFile(stream, dateYmd);
    console.log(` ${r.count.toLocaleString()} pts  skip=${r.skipped}  ${(r.elapsed_ms / 1000).toFixed(1)}s`);
    if (r.count === 0) {
      console.warn(`[${dateYmd}] zero records — wrong member path? expected ${member}`);
    }
    meta.days.push(r);
    meta.vehicle_count = vehicleDict.size;
    writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  const vehicles = new Array(vehicleDict.size);
  for (const [k, v] of vehicleDict) vehicles[v] = k;
  writeFileSync(join(OUT_DIR, 'vehicles.json'), JSON.stringify(vehicles));
  console.log(`vehicles.json: ${vehicles.length.toLocaleString()} unique IDs`);
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
