#!/usr/bin/env node
// Local server for the photo viewer: downloads JPG previews of RAW files from a
// Google Drive folder, then serves a folder of JPGs to the browser UI for culling.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT) || 5178;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, 'config.json');

// Files the app keeps inside each photo folder.
const MANIFEST_FILE = '.raw-manifest.json'; // { "OCT01574.jpg": { raw: "OCT01574.ARW", id: "<drive id>" } }
const STARS_FILE = '.stars.json'; // ["OCT01574.jpg", ...]

const JPG_RE = /\.jpe?g$/i;
const RAW_RE = /\.(arw|srf|sr2|cr2|cr3|crw|nef|nrw|dng|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|mef|mos|kdc|rwl)$/i;
// Used for exports when a JPG has no manifest entry and no RAW sitting next to it.
const FALLBACK_RAW_EXT = '.ARW';
const DOWNLOAD_CONCURRENCY = Number(process.env.DOWNLOAD_CONCURRENCY) || 6;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// ---------- helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

const loadConfig = () => readJsonFile(CONFIG_PATH, {});
async function saveConfig(patch) {
  const config = { ...(await loadConfig()), ...patch };
  await writeJsonFile(CONFIG_PATH, config);
  return config;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
}

async function requireDir(dir) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('Folder must be an absolute path');
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${dir}`);
  return path.resolve(dir);
}

// Only plain JPG file names inside the chosen folder may be served.
function requireJpgName(name) {
  if (!name || name !== path.basename(name) || !JPG_RE.test(name)) throw new Error('Invalid file name');
  return name;
}

// ---------- Google Drive ----------

function parseFolderId(input) {
  const s = String(input || '').trim();
  const match = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  if (match) return match[1];
  if (/^[\w-]{10,}$/.test(s)) return s;
  throw new Error('Could not find a folder ID in that Drive link');
}

const decodeHtml = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

// Lists a folder shared as "Anyone with the link" without an API key, using Drive's public embed page.
async function listPublicFolder(folderId) {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Could not read the Drive folder (HTTP ${res.status}). Is it shared as "Anyone with the link"?`);
  const html = await res.text();
  return html
    .split('<div class="flip-entry" id="entry-')
    .slice(1)
    .map((chunk) => {
      const thumb = chunk.match(/<img src="(https:\/\/lh3\.googleusercontent\.com\/[^"]+)"/)?.[1];
      return {
        id: chunk.slice(0, chunk.indexOf('"')),
        name: decodeHtml(chunk.match(/class="flip-entry-title">([^<]*)/)?.[1] || ''),
        mimeType: chunk.includes('/drive/folders/') ? FOLDER_MIME : '',
        thumbnailLink: thumb && decodeHtml(thumb),
      };
    });
}

async function listDriveFolder(folderId, apiKey) {
  const files = apiKey ? await listFolderWithApi(folderId, apiKey) : await listPublicFolder(folderId);
  return files
    .filter((f) => f.mimeType !== FOLDER_MIME)
    .filter((f) => RAW_RE.test(f.name) || f.mimeType.startsWith('image/'))
    .sort((a, b) => naturalSort(a.name, b.name));
}

async function listFolderWithApi(folderId, apiKey) {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, thumbnailLink)',
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${body.error?.message || res.statusText}`);
    files.push(...(body.files || []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

async function fetchImage(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) {
    throw Object.assign(new Error(`HTTP ${res.status} (${type || 'no content type'})`), { status: res.status });
  }
  return Buffer.from(await res.arrayBuffer());
}

// Drive renders a JPG from each RAW's embedded preview; `size` is the long edge in px.
async function fetchPreview(file, size) {
  const urls = [];
  if (file.thumbnailLink) urls.push(file.thumbnailLink.replace(/=s\d+$/, '') + `=s${size}`);
  urls.push(`https://drive.google.com/thumbnail?id=${encodeURIComponent(file.id)}&sz=s${size}`);

  let lastError;
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchImage(url);
      } catch (err) {
        lastError = err;
        if (err.status === 404) break; // no preview at this URL; try the next one
        await sleep(err.status === 429 ? 30000 : 1000 * 2 ** attempt);
      }
    }
  }
  // Drive has no preview for this file: download the RAW itself and convert it locally.
  if (RAW_RE.test(file.name)) return convertRaw(file, size).catch((err) => Promise.reject(new Error(`${lastError.message}; RAW fallback: ${err.message}`)));
  throw lastError;
}

async function convertRaw(file, size) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-viewer-'));
  const raw = path.join(tmpDir, `raw${path.extname(file.name)}`);
  const jpg = path.join(tmpDir, 'out.jpg');
  try {
    const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(file.id)}&export=download&confirm=t`;
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`RAW download HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(raw));

    const dims = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', raw]);
    const longEdge = Math.max(...[...dims.matchAll(/pixel(?:Width|Height): (\d+)/g)].map((m) => Number(m[1])));
    const resize = longEdge > size ? ['-Z', String(size)] : [];
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', ...resize, raw, '--out', jpg]);
    return await fsp.readFile(jpg);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

// Downloads a JPG preview of every RAW in the Drive folder into `dir`, reporting progress via `send`.
async function downloadFolder({ folder, dir, size, apiKey }, send, isCancelled = () => false) {
  const folderId = parseFolderId(folder);
  if (!dir || !path.isAbsolute(dir)) throw new Error('Choose a folder to save the JPGs into');

  send({ type: 'status', message: 'Listing Drive folder…' });
  const files = await listDriveFolder(folderId, apiKey);
  // Only remember a key once Drive has accepted it.
  await saveConfig({ ...(apiKey && { apiKey }), lastDriveFolder: folder, lastDir: dir });
  if (!files.length) throw new Error('No RAW or image files found in that Drive folder');

  await fsp.mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const manifest = await readJsonFile(manifestPath, {});

  // Pick a JPG name per Drive file, reusing earlier assignments so re-runs resume.
  const byId = new Map(Object.entries(manifest).map(([jpg, v]) => [v.id, jpg]));
  const taken = new Set(Object.keys(manifest));
  const jobs = files.map((file) => {
    let jpg = byId.get(file.id);
    if (!jpg) {
      const base = file.name.replace(/\.[^.]+$/, '');
      jpg = taken.has(`${base}.jpg`) ? `${base}_${file.id.slice(0, 6)}.jpg` : `${base}.jpg`;
      taken.add(jpg);
    }
    return { file, jpg };
  });

  const total = jobs.length;
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  const failed = [];
  send({ type: 'start', total });

  let next = 0;
  async function worker() {
    while (next < jobs.length && !isCancelled()) {
      const { file, jpg } = jobs[next++];
      const dest = path.join(dir, jpg);
      try {
        const existing = await fsp.stat(dest).catch(() => null);
        if (existing && existing.size > 0 && manifest[jpg]?.id === file.id && manifest[jpg]?.size >= size) {
          skipped++;
        } else {
          const data = await fetchPreview(file, size);
          await fsp.writeFile(`${dest}.part`, data);
          await fsp.rename(`${dest}.part`, dest);
          downloaded++;
        }
        manifest[jpg] = { raw: file.name, id: file.id, size: Math.max(size, manifest[jpg]?.size || 0) };
      } catch (err) {
        failed.push({ name: file.name, error: err.message });
      }
      done++;
      send({ type: 'progress', done, total, name: file.name });
      if (done % 10 === 0) await writeJsonFile(manifestPath, manifest);
    }
  }
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
  await writeJsonFile(manifestPath, manifest);

  return { type: isCancelled() ? 'cancelled' : 'done', downloaded, skipped, failed, dir };
}

async function handleDownload(req, res) {
  const { folder, dir, size = 6000, apiKey: apiKeyInput } = await readBody(req);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const send = (msg) => res.write(JSON.stringify(msg) + '\n');
  let cancelled = false;
  res.on('close', () => (cancelled = true));

  try {
    const config = await loadConfig();
    const apiKey = (apiKeyInput || '').trim() || config.apiKey || process.env.GOOGLE_API_KEY;
    send(await downloadFolder({ folder, dir, size, apiKey }, send, () => cancelled));
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
}

// ---------- local folder ----------

async function listPhotos(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
  const jpgs = names.filter((n) => JPG_RE.test(n)).sort(naturalSort);
  const rawsByBase = new Map(names.filter((n) => RAW_RE.test(n)).map((n) => [n.replace(/\.[^.]+$/, ''), n]));
  const manifest = await readJsonFile(path.join(dir, MANIFEST_FILE), {});
  const stars = await readJsonFile(path.join(dir, STARS_FILE), []);

  const photos = jpgs.map((jpg) => {
    const base = jpg.replace(/\.[^.]+$/, '');
    return { jpg, raw: manifest[jpg]?.raw || rawsByBase.get(base) || base + FALLBACK_RAW_EXT };
  });
  const jpgSet = new Set(jpgs);
  return { dir, photos, stars: stars.filter((s) => jpgSet.has(s)) };
}

async function exportStarred(dir) {
  const { photos, stars } = await listPhotos(dir);
  const starred = new Set(stars);
  const raws = photos.filter((p) => starred.has(p.jpg)).map((p) => p.raw);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const file = path.join(dir, `starred-raws_${stamp}.txt`);
  await fsp.writeFile(file, raws.join('\n') + (raws.length ? '\n' : ''));
  return { file, raws };
}

// Smaller copies (filmstrip thumbnails, phone-sized photos) are made with macOS `sips`
// and cached in hidden folders next to the originals.
const VARIANTS = {
  phone: { dir: '.phone', size: 2048, quality: 80 },
  // Made from the phone copy when there is one: much quicker than decoding a 24 MP original.
  thumb: { dir: '.thumbs', size: 360, quality: 70, from: '.phone' },
};
const SIPS_CONCURRENCY = Math.max(3, os.cpus().length - 2);
const sipsQueue = [];
const resizesInFlight = new Map(); // dest -> promise, so one file is never resized twice at once
let sipsRunning = 0;

// Runs sips with a cap on how many run at once, so a burst of requests can't swamp the Mac.
function queueSips(args) {
  return new Promise((resolve, reject) => {
    sipsQueue.push({ args, resolve, reject });
    pumpSips();
  });
}

function pumpSips() {
  while (sipsRunning < SIPS_CONCURRENCY && sipsQueue.length) {
    const { args, resolve, reject } = sipsQueue.shift();
    sipsRunning++;
    run('sips', args)
      .then(resolve, reject)
      .finally(() => {
        sipsRunning--;
        pumpSips();
      });
  }
}

function resize(src, dest, { size, quality }) {
  if (!resizesInFlight.has(dest)) {
    const job = queueSips(['-Z', String(size), '-s', 'formatOptions', String(quality), src, '--out', dest]).finally(() =>
      resizesInFlight.delete(dest),
    );
    resizesInFlight.set(dest, job);
  }
  return resizesInFlight.get(dest);
}

async function serveImage(res, file, cacheable) {
  const stat = await fsp.stat(file);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': stat.size,
    'Cache-Control': cacheable ? 'private, max-age=86400' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

// Returns the path of a cached smaller copy, making it first if needed; falls back to the original.
async function ensureVariant(dir, name, variant) {
  const original = path.join(dir, name);
  const cacheDir = path.join(dir, variant.dir);
  const dest = path.join(cacheDir, name);
  const [originalStat, destStat] = await Promise.all([fsp.stat(original), fsp.stat(dest).catch(() => null)]);
  if (destStat && destStat.mtimeMs >= originalStat.mtimeMs) return dest;
  const shortcut = variant.from && path.join(dir, variant.from, name);
  const shortcutStat = shortcut && (await fsp.stat(shortcut).catch(() => null));
  const src = shortcutStat && shortcutStat.mtimeMs >= originalStat.mtimeMs ? shortcut : original;
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await resize(src, dest, variant);
    return dest;
  } catch {
    return src;
  }
}

async function serveVariant(res, dir, name, variant) {
  return serveImage(res, await ensureVariant(dir, name, variant), true);
}

const imageSizes = new Map(); // path -> { width, height, mtimeMs }
async function imageSize(file) {
  const { mtimeMs } = await fsp.stat(file);
  const cached = imageSizes.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached;
  const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const size = { width: Number(out.match(/pixelWidth: (\d+)/)[1]), height: Number(out.match(/pixelHeight: (\d+)/)[1]), mtimeMs };
  imageSizes.set(file, size);
  return size;
}

// Phones view 2048 px copies; when zoomed in they ask for just the visible area of the full-size
// original. x/y/w/h are fractions of the image, `px` caps the long edge of what's sent back.
async function serveCrop(res, dir, name, q) {
  const src = path.join(dir, name);
  const { width, height } = await imageSize(src);
  const frac = (key) => Math.min(1, Math.max(0, Number(q.get(key)) || 0));
  const left = Math.floor(frac('x') * width);
  const top = Math.floor(frac('y') * height);
  const cropW = Math.max(1, Math.min(width - left, Math.ceil(frac('w') * width)));
  const cropH = Math.max(1, Math.min(height - top, Math.ceil(frac('h') * height)));
  const maxEdge = Math.min(4000, Math.max(64, Number(q.get('px')) || 2000));

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'photo-viewer-crop-'));
  const out = path.join(tmpDir, 'crop.jpg');
  try {
    // sips ignores the crop offset when it also resizes in the same call, so these are two steps.
    await queueSips(['--cropOffset', String(top), String(left), '-c', String(cropH), String(cropW), '-s', 'formatOptions', '85', src, '--out', out]);
    if (Math.max(cropW, cropH) > maxEdge) await queueSips(['-Z', String(maxEdge), out]);
    const data = await fsp.readFile(out);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=3600' });
    res.end(data);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

// Stars are changed one at a time so a phone and the Mac can both star without overwriting each other.
let starsLock = Promise.resolve();
function changeStars(dir, change) {
  const task = starsLock.then(async () => {
    const file = path.join(dir, STARS_FILE);
    const stars = new Set(await readJsonFile(file, []));
    const result = change(stars);
    await writeJsonFile(file, [...stars].sort(naturalSort));
    return result;
  });
  starsLock = task.catch(() => {});
  return task;
}

const updateStar = (dir, jpg, starred) => changeStars(dir, (stars) => (starred ? stars.add(jpg) : stars.delete(jpg)));

const nameKey = (name) => path.basename(name.replace(/\\/g, '/')).replace(/\.[^.]+$/, '').toLowerCase();

// Stars every photo named in `text`: RAW names, JPG names or bare names like OCT01574,
// one per line or separated by commas, semicolons, tabs or spaces.
async function importStars(dir, text, replace) {
  const { photos } = await listPhotos(dir);
  const byKey = new Map();
  for (const p of photos) {
    byKey.set(nameKey(p.jpg), p.jpg);
    byKey.set(nameKey(p.raw), p.jpg);
  }
  const matched = new Set();
  const unmatched = new Set();
  for (const chunk of String(text || '').split(/[\r\n,;\t]+/)) {
    const piece = chunk.trim().replace(/^["']+|["']+$/g, '');
    if (!piece) continue;
    // Try the whole piece first so names containing spaces still match.
    const words = byKey.has(nameKey(piece)) ? [piece] : piece.split(/\s+/);
    for (const word of words) {
      const jpg = byKey.get(nameKey(word));
      if (jpg) matched.add(jpg);
      else unmatched.add(word);
    }
  }
  const added = await changeStars(dir, (stars) => {
    if (replace) stars.clear();
    let count = 0;
    for (const jpg of matched) if (!stars.has(jpg) && stars.add(jpg)) count++;
    return count;
  });
  return { matched: matched.size, added, unmatched: [...unmatched], stars: (await listPhotos(dir)).stars };
}

// ---------- offline copy ----------
// Phones can save a .zip of the 2048 px copies to keep: a Starred folder (stars from every device),
// optionally every photo too, plus the starred RAW names.

async function offlinePlan(dir, scope) {
  const { photos, stars } = await listPhotos(dir);
  const starred = new Set(stars);
  const root = path.basename(dir);
  const picks = photos.filter((p) => starred.has(p.jpg));
  const entries = picks.map((p) => ({ name: `${root}/Starred/${p.jpg}`, jpg: p.jpg }));
  if (scope === 'all') entries.push(...photos.map((p) => ({ name: `${root}/All/${p.jpg}`, jpg: p.jpg })));
  const list = Buffer.from(picks.map((p) => p.raw).join('\n') + (picks.length ? '\n' : ''));
  return { root, entries, list };
}

// Makes sure every phone-sized copy exists, reporting progress as they're made.
async function prepareOffline(dir, entries, onProgress) {
  const names = [...new Set(entries.map((e) => e.jpg))];
  let done = 0;
  await Promise.all(
    names.map(async (jpg) => {
      await ensureVariant(dir, jpg, VARIANTS.phone);
      onProgress(++done, names.length);
    }),
  );
}

async function zipFiles(dir, { root, entries, list }) {
  const files = await Promise.all(
    entries.map(async (e) => {
      const file = await ensureVariant(dir, e.jpg, VARIANTS.phone);
      const stat = await fsp.stat(file);
      return { name: e.name, file, size: stat.size, mtime: stat.mtime };
    }),
  );
  files.push({ name: `${root}/starred-raws.txt`, data: list, size: list.length, mtime: new Date() });
  const bytes = files.reduce((n, f) => n + 30 + 46 + 2 * Buffer.byteLength(f.name) + f.size, 22);
  // Plain zip (no ZIP64) tops out at 4 GB and 65,535 entries.
  if (bytes > 0xffffffff || files.length >= 0xffff) throw new Error('Too many photos for one download; try Starred only');
  return { files, bytes };
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Streams an uncompressed zip (JPEGs don't shrink further), so Content-Length is known up front.
// Bytes sent per offline download, so the phone can show a progress bar for the browser's own download.
const zipProgress = new Map(); // id -> { sent, total, state }

async function streamZip(res, files, progress) {
  const central = [];
  let offset = 0;
  const waitForDrain = () =>
    new Promise((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.on('drain', done);
      res.on('close', done);
    });
  const write = async (buf) => {
    offset += buf.length;
    if (!res.write(buf)) await waitForDrain();
    progress.sent = offset;
  };

  for (const f of files) {
    if (res.destroyed) return;
    const data = f.data || (await fsp.readFile(f.file));
    if (data.length !== f.size) return res.destroy(); // changed on disk since sizing; a short zip is worse than none
    const name = Buffer.from(f.name);
    const crc = zlib.crc32(data);
    const { time, date } = dosDateTime(f.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42); // where this file's local header starts
    central.push(header, name);

    await write(Buffer.concat([local, name]));
    await write(data);
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(directory);
  await write(end);
  res.end();
  progress.state = 'done';
}

async function handleOfflinePrepare(req, res, remote) {
  const { dir, scope } = await readBody(req);
  const safeDir = await photoDir(dir, remote);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const send = (msg) => res.write(JSON.stringify(msg) + '\n');
  try {
    const plan = await offlinePlan(safeDir, scope);
    let last = 0;
    await prepareOffline(safeDir, plan.entries, (done, total) => {
      if (done === total || Date.now() - last > 250) {
        last = Date.now();
        send({ type: 'progress', done, total });
      }
    });
    const { files, bytes } = await zipFiles(safeDir, plan);
    send({ type: 'ready', photos: files.length - 1, bytes, filename: zipName(plan.root, scope) });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
}

const zipName = (root, scope) => `${root}-${scope === 'all' ? 'all' : 'starred'}.zip`;

async function handleOfflineZip(res, dir, scope, id) {
  const plan = await offlinePlan(dir, scope);
  const { files, bytes } = await zipFiles(dir, plan);
  const filename = zipName(plan.root, scope);
  const progress = { sent: 0, total: bytes, state: 'sending' };
  if (/^[\w-]{6,40}$/.test(id || '')) {
    zipProgress.set(id, progress);
    res.on('close', () => {
      if (progress.state !== 'done') progress.state = 'stopped';
      setTimeout(() => zipProgress.delete(id), 30 * 60 * 1000);
    });
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': bytes,
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  return streamZip(res, files, progress);
}

// ---------- phone access ----------
// With `--lan`, phones on the same Wi-Fi can browse the folder that's open on this Mac.
// They need the secret link printed at startup; after the first visit the key lives in a cookie.

const LAN = process.argv.includes('--lan');
const KEY_COOKIE = 'pv_key';
const PHONE_ROUTES = new Set([
  'GET /api/config',
  'GET /api/photos',
  'GET /api/img',
  'GET /api/thumb',
  'GET /api/stars',
  'POST /api/star',
  'POST /api/export',
  'POST /api/stars/import',
  'POST /api/offline/prepare',
  'GET /api/offline/zip',
  'GET /api/offline/progress',
  'GET /api/crop',
]);

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

async function phoneKey() {
  const config = await loadConfig();
  return config.phoneKey || (await saveConfig({ phoneKey: crypto.randomBytes(12).toString('base64url') })).phoneKey;
}

async function phoneUrls() {
  const key = await phoneKey();
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}/?key=${key}`);
}

// Returns true when the request may go ahead; otherwise it has already been answered.
async function authorizePhone(req, res, url) {
  const key = await phoneKey();
  if (url.searchParams.get('key') === key) {
    res.writeHead(302, {
      Location: url.pathname,
      'Set-Cookie': `${KEY_COOKIE}=${key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
    });
    res.end();
    return false;
  }
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${KEY_COOKIE}=`));
  if (cookie && cookie.slice(KEY_COOKIE.length + 1) === key) return true;
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<meta name="viewport" content="width=device-width"><p style="font:17px -apple-system,sans-serif;padding:24px">' +
      'Open the phone link shown on your Mac (Phone button in the viewer) to see these photos.</p>',
  );
  return false;
}

// Phones may only look at the folder currently open on the Mac.
async function photoDir(dir, remote) {
  const safe = await requireDir(dir);
  if (remote && safe !== (await loadConfig()).lastDir) throw new Error('Only the folder open on the Mac can be viewed from a phone');
  return safe;
}

// ---------- routing ----------

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const q = url.searchParams;
  const remote = !isLoopback(req);
  if (remote && !PHONE_ROUTES.has(route)) return sendJson(res, 403, { error: 'Not available from a phone' });

  switch (route) {
    case 'GET /api/config': {
      const c = await loadConfig();
      if (remote) return sendJson(res, 200, { remote: true, lastDir: c.lastDir || '' });
      return sendJson(res, 200, {
        hasApiKey: Boolean(c.apiKey || process.env.GOOGLE_API_KEY),
        lastDir: c.lastDir || '',
        lastDriveFolder: c.lastDriveFolder || '',
        phoneUrls: LAN ? await phoneUrls() : null,
      });
    }
    case 'POST /api/pick-folder': {
      const { prompt = 'Choose a folder' } = await readBody(req);
      try {
        const out = await run('osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]);
        return sendJson(res, 200, { path: out.trim().replace(/\/$/, '') || '/' });
      } catch (err) {
        // osascript exits with -128 / "User canceled" when the dialog is dismissed.
        if (/-128|cancel/i.test(err.stderr || '')) return sendJson(res, 200, { cancelled: true });
        return sendJson(res, 200, { unsupported: true });
      }
    }
    case 'GET /api/photos': {
      const dir = await photoDir(q.get('dir'), remote);
      if (!remote) await saveConfig({ lastDir: dir });
      return sendJson(res, 200, await listPhotos(dir));
    }
    case 'GET /api/img': {
      const dir = await photoDir(q.get('dir'), remote);
      const name = requireJpgName(q.get('name'));
      if (q.get('variant') === 'phone') return serveVariant(res, dir, name, VARIANTS.phone);
      return serveImage(res, path.join(dir, name), false);
    }
    case 'GET /api/thumb': {
      const dir = await photoDir(q.get('dir'), remote);
      return serveVariant(res, dir, requireJpgName(q.get('name')), VARIANTS.thumb);
    }
    case 'GET /api/stars': {
      const dir = await photoDir(q.get('dir'), remote);
      return sendJson(res, 200, { stars: (await listPhotos(dir)).stars });
    }
    case 'POST /api/star': {
      const { dir, jpg, starred } = await readBody(req);
      await updateStar(await photoDir(dir, remote), requireJpgName(jpg), Boolean(starred));
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/stars/import': {
      const { dir, text, replace } = await readBody(req);
      return sendJson(res, 200, await importStars(await photoDir(dir, remote), text, Boolean(replace)));
    }
    case 'POST /api/offline/prepare':
      return handleOfflinePrepare(req, res, remote);
    case 'GET /api/offline/zip': {
      const dir = await photoDir(q.get('dir'), remote);
      return handleOfflineZip(res, dir, q.get('scope') === 'all' ? 'all' : 'starred', q.get('id'));
    }
    case 'GET /api/offline/progress':
      return sendJson(res, 200, zipProgress.get(q.get('id')) || { state: 'waiting' });
    case 'GET /api/crop': {
      const dir = await photoDir(q.get('dir'), remote);
      return serveCrop(res, dir, requireJpgName(q.get('name')), q);
    }
    case 'POST /api/export': {
      const { dir } = await readBody(req);
      return sendJson(res, 200, await exportStarred(await photoDir(dir, remote)));
    }
    case 'POST /api/reveal': {
      const { file } = await readBody(req);
      if (!file || !path.isAbsolute(file)) throw new Error('Invalid path');
      await run('open', ['-R', file]).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/download':
      return handleDownload(req, res);
  }
  sendJson(res, 404, { error: 'Not found' });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (!isLoopback(req) && !(await authorizePhone(req, res, url))) return;
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { error: err.message });
    else res.end();
  }
});

// `node server.js download <drive-folder-link> <dest-dir> [size]` runs a download without the UI.
async function downloadFromCli([folder, dir, size = '6000']) {
  if (!folder || !dir) {
    console.error('Usage: npm run download -- <drive-folder-link> <dest-dir> [size]');
    process.exit(2);
  }
  const apiKey = (await loadConfig()).apiKey || process.env.GOOGLE_API_KEY;
  const started = Date.now();
  const send = (msg) => {
    const time = new Date().toLocaleTimeString();
    if (msg.type === 'status') console.log(`${time} ${msg.message}`);
    if (msg.type === 'start') console.log(`${time} ${msg.total} files`);
    if (msg.type === 'progress') console.log(`${time} [${msg.done}/${msg.total}] ${msg.name}`);
  };
  try {
    const result = await downloadFolder({ folder, dir: path.resolve(dir), size: Number(size), apiKey }, send);
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`Done in ${minutes} min: downloaded ${result.downloaded}, already had ${result.skipped}, failed ${result.failed.length}`);
    for (const f of result.failed) console.log(`FAILED ${f.name}: ${f.error}`);
    process.exit(result.failed.length ? 1 : 0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[2] === 'download') {
  downloadFromCli(process.argv.slice(3));
} else {
  server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', async () => {
    const address = `http://localhost:${PORT}`;
    console.log(`Photo viewer running at ${address}`);
    if (LAN) {
      const urls = await phoneUrls();
      if (urls.length) console.log(`On your phone (same Wi-Fi): ${urls.join('  or  ')}`);
      else console.log('Not connected to a network, so phones cannot reach this Mac.');
    }
    if (!process.argv.includes('--no-open')) run('open', [address]).catch(() => {});
  });
}
