// Photo viewer UI: browse a folder of JPGs, zoom, star with space, export RAW names.
//
// Runs in two modes. 'server': served by server.js on a Mac, which reads a folder of JPGs on disk.
// 'web': hosted as static files (GitHub Pages), where the page downloads JPG previews from Google
// Drive into this browser's storage and sw.js serves them back, also offline.
const $ = (id) => document.getElementById(id);
let MODE = 'server';

const stage = $('stage');
const placeholder = $('placeholder');
let photoEl = $('photo');

const state = {
  dir: '',
  photos: [], // [{ jpg, raw, id? }] (id: Google Drive file id, web mode)
  byJpg: new Map(), // jpg -> photo
  stars: new Set(), // jpg names
  view: [], // indices into photos for the current filter
  pos: 0, // position within view
  filter: 'all',
};

// scale is CSS px per image px; x/y is the image's top-left corner inside the stage.
const zoom = { scale: 1, x: 0, y: 0, fit: 1, nw: 0, nh: 0 };
const dpr = () => window.devicePixelRatio || 1;

const imageCache = new Map(); // jpg -> HTMLImageElement, kept for the current photo and its neighbours
const PRELOAD_RADIUS = 2;
let loadToken = 0;

const enc = encodeURIComponent;
// Phones get 2048 px copies: quicker over Wi-Fi, and Safari can't hold many 24 MP photos in memory.
const isTouch = matchMedia('(pointer: coarse)').matches;
const imgUrl = (jpg) => backend.photoUrl(state.byJpg.get(jpg));
const thumbUrl = (jpg) => backend.thumbUrl(state.byJpg.get(jpg));
// Smaller copies are shown at first; zooming in fetches more detail (see loadDetail).
const usesDetail = () => isTouch || MODE === 'web';

async function api(url, body) {
  const options = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Everything that differs between the two modes. The web version is further down.
const serverBackend = {
  photoUrl: (p) => `/api/img?dir=${enc(state.dir)}&name=${enc(p.jpg)}${isTouch ? '&variant=phone' : ''}`,
  thumbUrl: (p) => `/api/thumb?dir=${enc(state.dir)}&name=${enc(p.jpg)}`,
  // Just the visible area, cut from the full-size original on the Mac.
  detail(p, region, px) {
    const f = (n) => n.toFixed(5);
    return {
      src:
        `/api/crop?dir=${enc(state.dir)}&name=${enc(p.jpg)}` +
        `&x=${f(region.x)}&y=${f(region.y)}&w=${f(region.w)}&h=${f(region.h)}&px=${Math.min(px, 4000)}`,
      region,
      px,
    };
  },
  saveStar: (dir, jpg, starred) => api('/api/star', { dir, jpg, starred }),
  loadStars: async () => (await api(`/api/stars?dir=${enc(state.dir)}`)).stars,
  importStars: (text, replace) => api('/api/stars/import', { dir: state.dir, text, replace }),
  exportStarred: () => api('/api/export', { dir: state.dir }), // { file, raws }
};
let backend = serverBackend;

// Reads a streamed response of one JSON message per line.
async function readNdjson(res, onMessage) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      onMessage(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
    }
  }
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

// ---------- folders ----------

async function pickFolder(prompt) {
  const result = await api('/api/pick-folder', { prompt });
  if (result.path) return result.path;
  if (result.unsupported) return window.prompt(`${prompt} (full path):`, state.dir) || null;
  return null;
}

async function openFolder(dir) {
  const data = await api(`/api/photos?dir=${enc(dir)}`);
  loadPhotos(data.dir, data.photos, data.stars);
  if (!data.photos.length) toast('No JPGs found in that folder', true);
}

function loadPhotos(dir, photos, stars) {
  state.dir = dir;
  state.photos = photos;
  state.byJpg = new Map(photos.map((p) => [p.jpg, p]));
  state.stars = new Set(stars);
  state.filter = 'all';
  state.pos = 0;
  imageCache.clear();
  zoom.nw = 0;
  buildView();
  renderFilmstrip();
  show();
}

async function chooseAndOpenFolder() {
  try {
    const dir = await pickFolder('Choose a folder of JPGs');
    if (dir) await openFolder(dir);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- view / navigation ----------

const currentIndex = () => state.view[state.pos];

function buildView() {
  const current = currentIndex();
  state.view = state.photos
    .map((_, i) => i)
    .filter((i) => state.filter === 'all' || state.stars.has(state.photos[i].jpg));
  // Stay on the same photo if it is still visible, otherwise the next one after it.
  const at = state.view.findIndex((i) => i >= (current ?? 0));
  state.pos = at >= 0 ? at : Math.max(0, state.view.length - 1);
}

function setFilter(filter) {
  if (filter === 'starred' && state.stars.size === 0) {
    toast('No starred photos yet — press space to star one');
    return;
  }
  state.filter = filter;
  buildView();
  renderFilmstrip();
  show();
}

function go(delta) {
  if (!state.view.length) return;
  const pos = Math.max(0, Math.min(state.view.length - 1, state.pos + delta));
  if (pos === state.pos) return;
  state.pos = pos;
  show();
}

function goTo(pos) {
  state.pos = pos;
  show();
}

function getImage(jpg) {
  let img = imageCache.get(jpg);
  if (!img) {
    img = new Image();
    img.className = 'photo';
    img.draggable = false;
    img.alt = jpg;
    img.src = imgUrl(jpg);
    imageCache.set(jpg, img);
  }
  return img;
}

function preloadAround() {
  const keep = new Set();
  for (let d = -PRELOAD_RADIUS; d <= PRELOAD_RADIUS; d++) {
    const i = state.view[state.pos + d];
    if (i !== undefined) keep.add(state.photos[i].jpg);
  }
  for (const jpg of imageCache.keys()) if (!keep.has(jpg)) imageCache.delete(jpg);
  // Load the next photos first, since browsing usually goes forward.
  [1, 2, -1, -2].forEach((d) => {
    const i = state.view[state.pos + d];
    if (i !== undefined) getImage(state.photos[i].jpg);
  });
}

function show() {
  updateChrome();
  const i = currentIndex();
  if (i === undefined) {
    photoEl.hidden = true;
    placeholder.hidden = true;
    return;
  }
  const { jpg } = state.photos[i];
  const token = ++loadToken;
  const carry = zoomCarry();
  const img = getImage(jpg);
  clearDetail();

  const display = () => {
    if (token !== loadToken) return;
    photoEl.replaceWith(img);
    photoEl = img;
    photoEl.hidden = false;
    placeholder.hidden = true;
    stage.classList.remove('loading');
    zoom.nw = img.naturalWidth;
    zoom.nh = img.naturalHeight;
    computeFit();
    if (carry) {
      const r = stage.getBoundingClientRect();
      zoom.scale = zoom.fit * carry.rel;
      zoom.x = r.width / 2 - carry.cx * zoom.scale * zoom.nw;
      zoom.y = r.height / 2 - carry.cy * zoom.scale * zoom.nh;
    } else {
      resetToFit();
    }
    renderZoom();
  };

  if (img.complete && img.naturalWidth) {
    display();
  } else {
    // Show the small thumbnail with a spinner until the full JPG is ready.
    placeholder.src = thumbUrl(jpg);
    placeholder.hidden = false;
    photoEl.hidden = true;
    stage.classList.add('loading');
    whenLoaded(img).then(display, () => {
      if (token !== loadToken) return;
      stage.classList.remove('loading');
      imageCache.delete(jpg); // let the next visit retry
      toast(`Could not load ${jpg}`, true);
    });
  }
  preloadAround();
}

// Resolves once an image has loaded. (img.decode() is avoided: on some phones it never settles.)
function whenLoaded(img) {
  if (img.complete) return img.naturalWidth ? Promise.resolve() : Promise.reject(new Error('failed'));
  return new Promise((resolve, reject) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', reject, { once: true });
  });
}

// ---------- zoom & pan ----------

function computeFit() {
  const r = stage.getBoundingClientRect();
  zoom.fit = zoom.nw ? Math.min(r.width / zoom.nw, r.height / zoom.nh) : 1;
}

const isZoomed = () => zoom.nw && zoom.scale > zoom.fit * 1.001;

// Remembers zoom level and centre point so the next photo opens at the same spot.
function zoomCarry() {
  if (!isZoomed()) return null;
  const r = stage.getBoundingClientRect();
  return {
    rel: zoom.scale / zoom.fit,
    cx: (r.width / 2 - zoom.x) / (zoom.scale * zoom.nw),
    cy: (r.height / 2 - zoom.y) / (zoom.scale * zoom.nh),
  };
}

function resetToFit() {
  zoom.scale = zoom.fit;
  zoom.x = 0;
  zoom.y = 0;
}

function clampPan() {
  const r = stage.getBoundingClientRect();
  const w = zoom.nw * zoom.scale;
  const h = zoom.nh * zoom.scale;
  zoom.x = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, zoom.x));
  zoom.y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, zoom.y));
}

function renderZoom() {
  if (!zoom.nw) return;
  clampPan();
  photoEl.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  stage.classList.toggle('zoomed', isZoomed());
  // Above 100% on screen pixels, show crisp pixels instead of a blur. Phones get full-size detail instead.
  stage.classList.toggle('pixelated', !usesDetail() && zoom.scale * dpr() > 2);
  $('zoomLevel').textContent = `${Math.round(zoom.scale * dpr() * 100)}%`;
  positionDetail();
  if (usesDetail()) scheduleDetail();
}

// ---------- more detail when zoomed ----------
// Phones (and the web version) show smaller copies. Once zoomed in far enough that those would be
// stretched, a sharper image is laid over the photo: a crop of the original from the Mac, or a
// bigger copy of the whole photo from Google Drive.

const detail = { el: null, region: null, scale: 0, px: 0, token: 0, timer: 0 };

function clearDetail() {
  detail.token++;
  clearTimeout(detail.timer);
  detail.el?.remove();
  detail.el = null;
  detail.region = null;
  detail.px = 0;
}

function scheduleDetail() {
  clearTimeout(detail.timer);
  detail.timer = setTimeout(loadDetail, 200);
}

const covers = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

function loadDetail() {
  const i = currentIndex();
  if (i === undefined || !zoom.nw || pointers.size) return; // wait until fingers lift
  // Below this the 2048 px copy already has a pixel for every screen pixel.
  if (zoom.scale * dpr() <= 1.1) return clearDetail();

  const r = stage.getBoundingClientRect();
  const w = zoom.nw * zoom.scale;
  const h = zoom.nh * zoom.scale;
  const x = Math.max(0, -zoom.x / w);
  const y = Math.max(0, -zoom.y / h);
  const region = { x, y, w: Math.min(1, (r.width - zoom.x) / w) - x, h: Math.min(1, (r.height - zoom.y) / h) - y };
  if (region.w <= 0 || region.h <= 0) return;

  const px = Math.round(Math.max(region.w * w, region.h * h) * dpr());
  const want = backend.detail(state.photos[i], region, px, Math.round(Math.max(w, h) * dpr()));
  if (!want) return;
  // A whole-photo copy is enough while it has the pixels; a crop also has to cover the view.
  const enough = want.full ? detail.px >= want.px * 0.95 : detail.scale >= zoom.scale * 0.95;
  if (detail.region && covers(detail.region, want.region) && enough) return;

  const token = ++detail.token;
  const img = new Image();
  img.className = 'detail';
  img.draggable = false;
  img.alt = '';
  img.src = want.src;
  whenLoaded(img).then(
    () => {
      if (token !== detail.token) return;
      detail.el?.remove();
      Object.assign(detail, { el: img, region: want.region, scale: zoom.scale, px: want.px });
      stage.insertBefore(img, $('starBadge'));
      positionDetail();
    },
    () => {}, // keep showing the 2048 px copy
  );
}

function positionDetail() {
  if (!detail.el) return;
  const { x, y, w, h } = detail.region;
  const W = zoom.nw * zoom.scale;
  const H = zoom.nh * zoom.scale;
  Object.assign(detail.el.style, {
    left: `${zoom.x + x * W}px`,
    top: `${zoom.y + y * H}px`,
    width: `${w * W}px`,
    height: `${h * H}px`,
  });
}

const clampScale = (scale) => Math.max(zoom.fit, Math.min(Math.max(zoom.fit, 8 / dpr()), scale));

function zoomTo(scale, cx, cy) {
  if (!zoom.nw) return;
  scale = clampScale(scale);
  zoom.x = cx - (cx - zoom.x) * (scale / zoom.scale);
  zoom.y = cy - (cy - zoom.y) * (scale / zoom.scale);
  zoom.scale = scale;
  renderZoom();
}

function zoomAtCentre(factor) {
  const r = stage.getBoundingClientRect();
  zoomTo(zoom.scale * factor, r.width / 2, r.height / 2);
}

// 100% = one image pixel per screen pixel.
function toggleActualSize(cx, cy) {
  if (isZoomed()) {
    resetToFit();
    renderZoom();
    return;
  }
  const r = stage.getBoundingClientRect();
  const actual = 1 / dpr();
  zoomTo(actual > zoom.fit * 1.05 ? actual : zoom.fit * 2, cx ?? r.width / 2, cy ?? r.height / 2);
}

stage.addEventListener(
  'wheel',
  (e) => {
    if (!zoom.nw || currentIndex() === undefined) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const k = e.ctrlKey ? 0.01 : 0.002;
    zoomTo(zoom.scale * Math.exp(-dy * k), e.clientX - r.left, e.clientY - r.top);
  },
  { passive: false },
);

// Mouse or one finger drags to pan when zoomed. On touch screens a quick horizontal swipe changes
// photo, two fingers pinch-zoom, and a double tap toggles fit / 100%.
const pointers = new Map(); // pointerId -> { x, y } within the stage
let gesture = null;
let multiTouch = false; // a pinch happened; ignore swipes/taps until every finger is lifted
let lastTap = null;
let lastPointerType = 'mouse';

function stagePoint(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function beginGesture() {
  const [a, b] = [...pointers.values()];
  if (b) {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture = { type: 'pinch', dist: Math.hypot(b.x - a.x, b.y - a.y), mid, scale: zoom.scale, x: zoom.x, y: zoom.y };
  } else {
    gesture = { type: 'drag', start: { ...a }, x: zoom.x, y: zoom.y, time: Date.now(), moved: false };
  }
}

stage.addEventListener('pointerdown', (e) => {
  lastPointerType = e.pointerType;
  if (!zoom.nw || currentIndex() === undefined || e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, stagePoint(e));
  if (pointers.size > 1) multiTouch = true;
  beginGesture();
  stage.classList.toggle('panning', isZoomed());
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, stagePoint(e));
  const [a, b] = [...pointers.values()];
  if (gesture.type === 'pinch' && b) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = clampScale((gesture.scale * dist) / gesture.dist);
    // Keep the spot that started between the fingers under them as they move.
    zoom.x = mid.x - (gesture.mid.x - gesture.x) * (scale / gesture.scale);
    zoom.y = mid.y - (gesture.mid.y - gesture.y) * (scale / gesture.scale);
    zoom.scale = scale;
    renderZoom();
  } else if (gesture.type === 'drag') {
    const dx = a.x - gesture.start.x;
    const dy = a.y - gesture.start.y;
    if (Math.hypot(dx, dy) > 8) gesture.moved = true;
    if (isZoomed()) {
      zoom.x = gesture.x + dx;
      zoom.y = gesture.y + dy;
      renderZoom();
    }
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const end = stagePoint(e);
  pointers.delete(e.pointerId);
  const g = gesture;
  if (pointers.size) {
    beginGesture(); // the finger left after a pinch carries on panning
    return;
  }
  const wasMulti = multiTouch;
  multiTouch = false;
  gesture = null;
  stage.classList.remove('panning');
  if (usesDetail()) scheduleDetail();
  if (e.type === 'pointercancel' || wasMulti || e.pointerType !== 'touch' || g?.type !== 'drag') return;

  const dx = end.x - g.start.x;
  const dy = end.y - g.start.y;
  if (!isZoomed() && Date.now() - g.time < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    go(dx < 0 ? 1 : -1);
  } else if (!g.moved) {
    const now = Date.now();
    if (lastTap && now - lastTap.time < 300 && Math.hypot(end.x - lastTap.x, end.y - lastTap.y) < 30) {
      lastTap = null;
      toggleActualSize(end.x, end.y);
    } else {
      lastTap = { time: now, ...end };
    }
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

stage.addEventListener('dblclick', (e) => {
  if (currentIndex() === undefined || lastPointerType === 'touch') return;
  const r = stage.getBoundingClientRect();
  toggleActualSize(e.clientX - r.left, e.clientY - r.top);
});

window.addEventListener('resize', () => {
  if (!zoom.nw) return;
  const wasFit = !isZoomed();
  computeFit();
  if (wasFit || zoom.scale < zoom.fit) resetToFit();
  renderZoom();
});

// ---------- stars ----------

// Each toggle is sent on its own, in order, so stars made on a phone and on the Mac merge.
let starQueue = Promise.resolve();
let starEdits = 0;
function saveStar(jpg, starred) {
  const dir = state.dir;
  starEdits++;
  starQueue = starQueue
    .then(() => backend.saveStar(dir, jpg, starred))
    .catch((err) => toast(`Could not save star: ${err.message}`, true));
}

// Picks up stars made on another device whenever this one comes back into view.
async function refreshStars() {
  if (!state.dir || document.hidden || MODE === 'web') return;
  await starQueue;
  const edits = starEdits;
  try {
    const stars = await backend.loadStars();
    if (edits !== starEdits) return; // starred something meanwhile; the next refresh will catch up
    state.stars = new Set(stars);
    thumbEls.forEach((_, i) => updateThumb(i));
    updateChrome();
  } catch {
    // Offline or the folder moved; keep what we have.
  }
}
document.addEventListener('visibilitychange', refreshStars);
window.addEventListener('focus', refreshStars);

function toggleStar() {
  const i = currentIndex();
  if (i === undefined) return;
  const { jpg } = state.photos[i];
  if (state.stars.has(jpg)) state.stars.delete(jpg);
  else state.stars.add(jpg);
  saveStar(jpg, state.stars.has(jpg));
  updateChrome();
  updateThumb(i);
  const badge = $('starBadge');
  badge.classList.remove('pop');
  void badge.offsetWidth; // restart the animation
  badge.classList.add('pop');
}

async function exportStarred() {
  if (!state.stars.size) return toast('Star some photos first (space bar)');
  try {
    await starQueue;
    const { file, raws } = await backend.exportStarred();
    $('exportTitle').textContent = `${file ? 'Exported ' : ''}${raws.length} starred RAW file name${raws.length === 1 ? '' : 's'}`;
    $('exportPath').textContent = file || 'Copy the list, save it as a .txt file, or share it.';
    $('shareListBtn').hidden = !navigator.share;
    $('exportList').value = raws.join('\n');
    $('exportDialog').dataset.file = file;
    $('exportDialog').showModal();
  } catch (err) {
    toast(err.message, true);
  }
}

$('copyBtn').addEventListener('click', async () => {
  const list = $('exportList');
  try {
    await navigator.clipboard.writeText(list.value);
  } catch {
    // Phones on plain http have no clipboard API, so copy from a selection instead.
    list.focus();
    list.setSelectionRange(0, list.value.length);
    if (!document.execCommand('copy')) return toast('Select the list and copy it by hand');
  }
  toast('Copied to clipboard');
});
$('revealBtn').addEventListener('click', () => api('/api/reveal', { file: $('exportDialog').dataset.file }));
$('saveListBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('exportList').value + '\n'], { type: 'text/plain' }));
  a.download = `starred-raws_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});
$('shareListBtn').addEventListener('click', () =>
  navigator.share({ title: 'Starred RAW files', text: $('exportList').value }).catch(() => {}),
);

// ---------- chrome / filmstrip ----------

const thumbEls = new Map(); // photo index -> button

function renderFilmstrip() {
  strip.replaceChildren();
  thumbEls.clear();
  state.view.forEach((i, pos) => {
    const { jpg, raw } = state.photos[i];
    const btn = document.createElement('button');
    btn.className = 'thumb';
    btn.title = raw;
    btn.tabIndex = -1;
    btn.innerHTML = '<img loading="lazy" alt=""><span class="star">★</span>';
    btn.querySelector('img').src = thumbUrl(jpg);
    btn.addEventListener('click', () => goTo(pos));
    strip.append(btn);
    thumbEls.set(i, btn);
    updateThumb(i);
  });
  updateScrubber();
}

// A draggable bar under the filmstrip: phones hide scrollbars, and 1,800 thumbnails is a long swipe.
const strip = $('filmstrip');
const scrubber = $('scrubber');
const scrubThumb = $('scrubThumb');
const scrubLabel = $('scrubLabel');
let scrubbing = null;

function updateScrubber() {
  const track = scrubber.clientWidth;
  const max = strip.scrollWidth - strip.clientWidth;
  scrubber.hidden = max <= 0;
  if (max <= 0) return;
  const thumbW = Math.max(44, (track * strip.clientWidth) / strip.scrollWidth);
  scrubThumb.style.width = `${thumbW}px`;
  scrubThumb.style.transform = `translateX(${((track - thumbW) * strip.scrollLeft) / max}px)`;
  if (scrubbing) {
    // Which photo sits in the middle of the strip right now.
    const first = strip.firstElementChild;
    const step = first ? first.offsetWidth + 4 : 1;
    const pos = Math.min(state.view.length - 1, Math.max(0, Math.floor((strip.scrollLeft + strip.clientWidth / 2) / step)));
    scrubLabel.textContent = `${pos + 1} / ${state.view.length}`;
    scrubLabel.style.transform = `translateX(${((track - thumbW) * strip.scrollLeft) / max + thumbW / 2}px)`;
  }
}

function scrubTo(clientX) {
  const r = scrubber.getBoundingClientRect();
  const thumbW = scrubThumb.offsetWidth;
  const fraction = Math.min(1, Math.max(0, (clientX - r.left - scrubbing.grab) / (r.width - thumbW)));
  strip.scrollLeft = fraction * (strip.scrollWidth - strip.clientWidth);
  updateScrubber();
}

scrubber.addEventListener('pointerdown', (e) => {
  scrubber.setPointerCapture(e.pointerId);
  const t = scrubThumb.getBoundingClientRect();
  // Grabbing the handle keeps the finger where it is on it; tapping the track centres the handle there.
  const onThumb = e.clientX >= t.left && e.clientX <= t.right;
  scrubbing = { grab: onThumb ? e.clientX - t.left : t.width / 2 };
  scrubber.classList.add('active');
  scrubTo(e.clientX);
});
scrubber.addEventListener('pointermove', (e) => scrubbing && scrubTo(e.clientX));
const endScrub = () => {
  scrubbing = null;
  scrubber.classList.remove('active');
};
scrubber.addEventListener('pointerup', endScrub);
scrubber.addEventListener('pointercancel', endScrub);
strip.addEventListener('scroll', updateScrubber, { passive: true });
window.addEventListener('resize', updateScrubber);

function updateThumb(i) {
  thumbEls.get(i)?.classList.toggle('starred', state.stars.has(state.photos[i].jpg));
}

let currentThumb;
function updateChrome() {
  const i = currentIndex();
  const photo = state.photos[i];
  const starred = photo && state.stars.has(photo.jpg);

  $('empty').hidden = state.photos.length > 0;
  $('folderPath').textContent = state.dir ? `‎${state.dir}‎` : '';
  $('folderPath').title = state.dir;
  $('countAll').textContent = state.photos.length;
  $('countStarred').textContent = state.stars.size;
  $('filterAll').classList.toggle('active', state.filter === 'all');
  $('filterStarred').classList.toggle('active', state.filter === 'starred');
  $('exportBtn').disabled = state.stars.size === 0;
  $('starBadge').hidden = !starred;
  $('starBtn').hidden = !photo;
  $('starBtn').textContent = starred ? '★' : '☆';
  $('starBtn').classList.toggle('on', Boolean(starred));
  $('starBtn').setAttribute('aria-pressed', String(Boolean(starred)));
  $('rawName').textContent = photo ? photo.raw : '';
  $('position').textContent = photo ? `${state.pos + 1} / ${state.view.length}` : '';
  if (!photo) $('zoomLevel').textContent = '';
  document.title = photo ? `${starred ? '★ ' : ''}${photo.raw} — Photo Viewer` : 'Photo Viewer';

  currentThumb?.classList.remove('current');
  currentThumb = thumbEls.get(i);
  if (currentThumb) {
    currentThumb.classList.add('current');
    // Scroll only the filmstrip; scrollIntoView would also scroll the page itself.
    const left = currentThumb.offsetLeft - (strip.clientWidth - currentThumb.offsetWidth) / 2;
    strip.scrollTo({ left, behavior: 'smooth' });
  }
}

// ---------- Drive download ----------

const dl = { controller: null };

async function openDownloadDialog() {
  if (MODE === 'web') return openWebDownloadDialog();
  const config = await api('/api/config').catch(() => ({}));
  if (!$('driveFolder').value) $('driveFolder').value = config.lastDriveFolder || '';
  if (!$('destDir').value) $('destDir').value = config.lastDir || '';
  $('apiKey').placeholder = config.hasApiKey ? 'Saved key will be used' : 'AIza…';
  $('downloadDialog').showModal();
}

function setDownloadRunning(running) {
  $('startDownloadBtn').disabled = running;
  $('cancelDownloadBtn').textContent = running ? 'Cancel' : 'Close';
  for (const id of ['driveFolder', 'apiKey', 'destDir', 'previewSize', 'pickDestBtn']) $(id).disabled = running;
}

function setProgress(text, fraction, isError = false) {
  $('progressWrap').hidden = false;
  $('progressText').textContent = text;
  $('progressText').classList.toggle('progress-text-error', isError);
  if (fraction !== undefined) $('progressBar').style.width = `${Math.round(fraction * 100)}%`;
}

async function startDownload(e) {
  e.preventDefault();
  if (MODE === 'web') return webDownload();
  const dir = $('destDir').value.trim();
  dl.controller = new AbortController();
  setDownloadRunning(true);
  setProgress('Starting…', 0);
  let result;
  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: $('driveFolder').value,
        apiKey: $('apiKey').value,
        dir,
        size: Number($('previewSize').value),
      }),
      signal: dl.controller.signal,
    });
    await readNdjson(res, (msg) => {
      if (msg.type === 'status') setProgress(msg.message);
      else if (msg.type === 'start') setProgress(`0 / ${msg.total}`, 0);
      else if (msg.type === 'progress') setProgress(`${msg.done} / ${msg.total} — ${msg.name}`, msg.done / msg.total);
      else if (msg.type === 'error') setProgress(msg.message, undefined, true);
      else result = msg;
    });
  } catch (err) {
    if (err.name === 'AbortError') setProgress('Cancelled — run it again to resume where it stopped.');
    else setProgress(err.message, undefined, true);
  }
  setDownloadRunning(false);
  dl.controller = null;

  if (result?.type === 'done' || result?.type === 'cancelled') {
    const failed = result.failed.length;
    const summary = `Downloaded ${result.downloaded}, already had ${result.skipped}` + (failed ? `, ${failed} failed` : '');
    setProgress(
      failed ? `${summary}: ${result.failed.slice(0, 3).map((f) => `${f.name} (${f.error})`).join('; ')}` : summary,
      1,
      failed > 0,
    );
    if ($('apiKey').value) {
      $('apiKey').value = '';
      $('apiKey').placeholder = 'Saved key will be used';
    }
    await openFolder(result.dir).catch((err) => toast(err.message, true));
    if (!failed && result.type === 'done') {
      $('downloadDialog').close();
      toast(summary);
    }
  }
}

$('downloadForm').addEventListener('submit', startDownload);
$('cancelDownloadBtn').addEventListener('click', () => {
  if (dl.controller) dl.controller.abort();
  else $('downloadDialog').close();
});
$('pickDestBtn').addEventListener('click', async () => {
  try {
    const dir = await pickFolder('Choose where to save the JPGs');
    if (dir) $('destDir').value = dir;
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- star from a list ----------

function openImportDialog() {
  if (!state.photos.length) return toast('Open some photos first', true);
  $('importResult').textContent = '';
  $('importDialog').showModal();
}

function refreshStarDisplay() {
  if (state.filter === 'starred') {
    buildView();
    renderFilmstrip();
    show();
  } else {
    thumbEls.forEach((_, i) => updateThumb(i));
    updateChrome();
  }
}

$('importFileBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  if (file) $('importText').value = await file.text();
  $('importFile').value = '';
});
$('importCloseBtn').addEventListener('click', () => $('importDialog').close());
$('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = $('importResult');
  result.classList.remove('progress-text-error');
  try {
    await starQueue;
    starEdits++;
    const r = await backend.importStars($('importText').value, $('importReplace').checked);
    state.stars = new Set(r.stars);
    refreshStarDisplay();
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    let message = `Starred ${plural(r.matched, 'photo')}`;
    if (r.added < r.matched) message += ` (${r.matched - r.added} already starred)`;
    message += '.';
    if (r.unmatched.length) {
      const shown = r.unmatched.slice(0, 8).join(', ') + (r.unmatched.length > 8 ? ', …' : '');
      message += ` ${plural(r.unmatched.length, 'name')} didn’t match a photo: ${shown}`;
    }
    result.textContent = message;
  } catch (err) {
    result.textContent = err.message;
    result.classList.add('progress-text-error');
  }
});

// ---------- offline copy ----------

const PHONE_JPG_MB = 0.56; // average size of a 2048 px copy
function aboutSize(count) {
  const mb = count * PHONE_JPG_MB;
  return mb >= 1000 ? `about ${(mb / 1000).toFixed(1)} GB` : `about ${Math.max(1, Math.round(mb))} MB`;
}
const formatBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function setOfflineProgress(text, fraction, isError = false) {
  $('offlineProgressWrap').hidden = false;
  $('offlineProgressText').textContent = text;
  $('offlineProgressText').classList.toggle('progress-text-error', isError);
  if (fraction !== undefined) $('offlineProgressBar').style.width = `${Math.round(fraction * 100)}%`;
}

function openOfflineDialog() {
  if (!state.dir) return toast('Open a folder first', true);
  const starred = state.stars.size;
  const total = state.photos.length;
  $('offlineStarredInfo').textContent = starred
    ? `(${starred} photo${starred === 1 ? '' : 's'}, ${aboutSize(starred)})`
    : '(none starred yet)';
  $('offlineAllInfo').textContent = `(${total} photos, ${aboutSize(total + starred)})`;
  const starredRadio = document.querySelector('input[name="offlineScope"][value="starred"]');
  starredRadio.disabled = starred === 0;
  if (starred === 0) document.querySelector('input[name="offlineScope"][value="all"]').checked = true;
  $('offlineProgressWrap').hidden = true;
  $('offlineHint').hidden = true;
  $('offlineProgressBar').style.width = '0';
  $('offlineStartBtn').disabled = false;
  $('offlineDialog').showModal();
}

$('offlineCloseBtn').addEventListener('click', () => $('offlineDialog').close());
$('offlineForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const scope = document.querySelector('input[name="offlineScope"]:checked').value;
  $('offlineStartBtn').disabled = true;
  setOfflineProgress('Getting photos ready…', 0);
  let ready;
  try {
    await starQueue;
    const res = await fetch('/api/offline/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: state.dir, scope }),
    });
    await readNdjson(res, (msg) => {
      if (msg.type === 'progress') setOfflineProgress(`Getting photos ready… ${msg.done} / ${msg.total}`, msg.done / msg.total);
      else if (msg.type === 'error') throw new Error(msg.message);
      else if (msg.type === 'ready') ready = msg;
    });
  } catch (err) {
    setOfflineProgress(err.message, undefined, true);
    $('offlineStartBtn').disabled = false;
    return;
  }
  // The browser does the actual download (the server answers with an attachment, so the page stays put).
  // The server reports how much it has sent, which drives the progress bar.
  const id = Math.random().toString(36).slice(2, 12);
  window.location.href = `/api/offline/zip?dir=${enc(state.dir)}&scope=${scope}&id=${id}`;
  setOfflineProgress(`Starting download of ${ready.photos} photos (${formatBytes(ready.bytes)})…`, 0);
  trackOfflineDownload(id, ready);
});

async function trackOfflineDownload(id, ready) {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    if (!$('offlineDialog').open) return;
    const p = await api(`/api/offline/progress?id=${id}`).catch(() => ({ state: 'lost' }));
    if (p.state === 'waiting') {
      if (Date.now() - started > 8000) setOfflineProgress('Waiting for the download to start. If your browser asks, tap Download.', 0);
      continue;
    }
    if (p.state === 'sending') {
      setOfflineProgress(`Downloading ${formatBytes(p.sent)} of ${formatBytes(p.total)}…`, p.sent / p.total);
      continue;
    }
    if (p.state === 'done') {
      setOfflineProgress(`Downloaded ${ready.photos} photos (${formatBytes(ready.bytes)}).`, 1);
      $('offlineFile').textContent = ready.filename;
      $('offlineHint').hidden = false;
    } else {
      setOfflineProgress('The download stopped before it finished. Tap Download to try again.', undefined, true);
    }
    $('offlineStartBtn').disabled = false;
    return;
  }
}

// ---------- web version (GitHub Pages) ----------
// No Mac here. The page lists the Drive folder with the Drive API, downloads each JPG preview straight
// from Google into Cache Storage, and sw.js serves them back, offline too. The photo list, stars and
// API key are kept in localStorage, so the next visit opens the same photos.

const LIBRARY_KEY = 'pv-library';
const STARS_KEY = 'pv-stars';
const API_KEY_KEY = 'pv-api-key';
const LIBRARY_CACHE = 'photo-library'; // also named in sw.js
const THUMB_PX = 400;
const WEB_SIZES = [
  [1600, 0.3],
  [2048, 0.5],
  [3000, 0.9],
  [4000, 1.4],
]; // long edge in px, rough MB per photo
const WEB_CONCURRENCY = 6;
const RAW_RE = /\.(arw|srf|sr2|cr2|cr3|crw|nef|nrw|dng|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|mef|mos|kdc|rwl)$/i;
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const saved = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
  remove: (key) => localStorage.removeItem(key),
};

let library = null; // { folderId, link, name, size, photos: [{ jpg, raw, id? }] }
let swReady = false;

const drivePreview = (id, px) => `https://lh3.googleusercontent.com/d/${id}=s${px}`;
const configuredKey = () => window.PHOTO_VIEWER_CONFIG?.googleApiKey || '';

// Drive photos live at library/<px>/<drive id>/<name>; photos added from the device at library/local/<name>.
function libraryPath(photo, thumb) {
  if (!photo.id) return `library/local${thumb ? '-thumb' : ''}/${enc(photo.jpg)}`;
  return `library/${thumb ? THUMB_PX : library.size}/${photo.id}/${enc(photo.jpg)}`;
}
const libraryUrl = (photo, thumb) => new URL(libraryPath(photo, thumb), location.href).href;

const webBackend = {
  // Without a service worker (rare), Drive photos load straight from Google, online only.
  photoUrl: (p) => (swReady || !p.id ? libraryPath(p, false) : drivePreview(p.id, library.size)),
  thumbUrl: (p) => (swReady || !p.id ? libraryPath(p, true) : drivePreview(p.id, THUMB_PX)),
  // Drive can't crop, so zooming in brings in a bigger copy of the whole photo, while online.
  detail(p, region, px, fullPx) {
    const size = Math.min(4096, fullPx);
    if (!p.id || !navigator.onLine || size <= library.size * 1.05) return null;
    return { src: drivePreview(p.id, size), region: { x: 0, y: 0, w: 1, h: 1 }, px: size, full: true };
  },
  saveStar: async () => saved.set(STARS_KEY, [...state.stars]),
  loadStars: async () => saved.get(STARS_KEY, []),
  async importStars(text, replace) {
    const { matched, unmatched } = matchNames(state.photos, text);
    if (replace) state.stars.clear();
    let added = 0;
    for (const jpg of matched) {
      if (!state.stars.has(jpg)) {
        state.stars.add(jpg);
        added++;
      }
    }
    saved.set(STARS_KEY, [...state.stars]);
    return { matched: matched.size, added, unmatched, stars: [...state.stars] };
  },
  exportStarred: async () => ({ file: null, raws: state.photos.filter((p) => state.stars.has(p.jpg)).map((p) => p.raw) }),
};

// Same matching as the Mac server: RAW names, JPG names or bare names, in any common list format.
const nameKey = (name) => name.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
function matchNames(photos, text) {
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
    const words = byKey.has(nameKey(piece)) ? [piece] : piece.split(/\s+/);
    for (const word of words) {
      const jpg = byKey.get(nameKey(word));
      if (jpg) matched.add(jpg);
      else unmatched.add(word);
    }
  }
  return { matched, unmatched: [...unmatched] };
}

async function startWeb() {
  MODE = 'web';
  backend = webBackend;
  document.body.classList.add('web');
  swReady = await startServiceWorker();
  library = saved.get(LIBRARY_KEY, null);
  if (library?.photos?.length) openLibrary();
  else updateChrome();
}

async function startServiceWorker() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('sw.js');
    if (!navigator.serviceWorker.controller) {
      // First visit: wait for the new worker to take charge of this page.
      await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
    }
    return Boolean(navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}

function openLibrary() {
  const names = new Set(library.photos.map((p) => p.jpg));
  loadPhotos(library.name, library.photos, saved.get(STARS_KEY, []).filter((jpg) => names.has(jpg)));
}

async function savedUrls() {
  const cache = await caches.open(LIBRARY_CACHE);
  return new Set((await cache.keys()).map((r) => r.url));
}

async function showLibraryStatus() {
  if (!library) {
    $('libraryStatus').textContent = '';
    return;
  }
  const urls = await savedUrls();
  const have = library.photos.filter((p) => urls.has(libraryUrl(p, false))).length;
  const usage = (await navigator.storage?.estimate?.().catch(() => null))?.usage;
  $('libraryStatus').textContent =
    `On this device: “${library.name}”, ${have} of ${library.photos.length} photos saved` +
    (usage ? ` (${formatBytes(usage)} used)` : '') +
    '. Downloading again only fetches what’s missing.';
}

function openWebDownloadDialog() {
  const select = $('previewSize');
  select.replaceChildren(...WEB_SIZES.map(([px, mb]) => new Option(`${px} px (~${mb} MB each)`, px)));
  select.value = String(library?.size || 2048);
  if (!$('driveFolder').value) $('driveFolder').value = library?.link || '';
  const hasKey = Boolean(configuredKey() || saved.get(API_KEY_KEY, ''));
  $('apiKeyLabel').textContent = 'Google API key';
  $('apiKey').required = !hasKey;
  $('apiKey').placeholder = hasKey ? 'Saved key will be used' : 'AIza…';
  $('apiKeyHint').textContent = hasKey
    ? 'Already saved on this device.'
    : 'Needed once per device to list the folder’s files. See “How to get a free API key” below.';
  $('keyOrigin').textContent = `${location.origin}/*`;
  $('destDir').required = false;
  $('progressWrap').hidden = true;
  showLibraryStatus();
  $('downloadDialog').showModal();
}

function parseFolderId(input) {
  const s = String(input || '').trim();
  const match = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  if (match) return match[1];
  if (/^[\w-]{10,}$/.test(s)) return s;
  throw new Error('That doesn’t look like a Google Drive folder link.');
}

async function driveApi(path, params, apiKey, signal) {
  if (!apiKey) throw new Error('Add a Google API key first (see “How to get a free API key”).');
  const query = new URLSearchParams({ ...params, key: apiKey });
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}?${query}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const message = body.error?.message || res.statusText;
  if (/api key not valid/i.test(message)) throw new Error('That API key isn’t valid. Check you copied all of it.');
  if (/has not been used|is disabled/i.test(message)) {
    throw new Error('Turn on the Google Drive API for your key’s project (step 2 below), wait a minute, then try again.');
  }
  if (/referer|referrer/i.test(message)) {
    throw new Error(`Your API key doesn’t allow this site yet. Add ${location.origin}/* to its website restrictions.`);
  }
  if (res.status === 404) throw new Error('Folder not found. Check the link, and that it’s shared as “Anyone with the link”.');
  throw new Error(`Google Drive said: ${message}`);
}

async function listDriveFolder(folderId, apiKey, signal) {
  const files = [];
  let pageToken;
  do {
    const body = await driveApi(
      'files',
      {
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: '1000',
        orderBy: 'name',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(pageToken && { pageToken }),
      },
      apiKey,
      signal,
    );
    files.push(...(body.files || []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files
    .filter((f) => f.mimeType !== 'application/vnd.google-apps.folder')
    .filter((f) => RAW_RE.test(f.name) || f.mimeType.startsWith('image/'))
    .sort((a, b) => naturalSort(a.name, b.name));
}

// Drive sometimes takes minutes to make a preview the first time, so each try gets a time limit.
const PREVIEW_TIMEOUT_MS = 90000;
async function fetchPreview(id, px, signal) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptControl = new AbortController();
    const stop = () => attemptControl.abort();
    const timer = setTimeout(stop, PREVIEW_TIMEOUT_MS);
    signal.addEventListener('abort', stop, { once: true });
    try {
      const res = await fetch(drivePreview(id, px), { signal: attemptControl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (err) {
      if (signal.aborted) throw err;
      lastError = err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }
  throw lastError;
}

// Keeps the screen on while downloading; phones pause pages whose screen has locked.
let wakeLock = null;
async function holdWakeLock(on) {
  if (!on) {
    await wakeLock?.release().catch(() => {});
    wakeLock = null;
  } else if (navigator.wakeLock && !document.hidden) {
    wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
  }
}
document.addEventListener('visibilitychange', () => {
  if (dl.controller && MODE === 'web') holdWakeLock(true);
});

async function webDownload() {
  const typedKey = $('apiKey').value.trim();
  const apiKey = typedKey || saved.get(API_KEY_KEY, '') || configuredKey();
  const size = Number($('previewSize').value);
  let folderId;
  try {
    folderId = parseFolderId($('driveFolder').value);
  } catch (err) {
    return setProgress(err.message, undefined, true);
  }
  const sameFolder = library?.folderId === folderId;
  if (library && !sameFolder) {
    const replace = confirm(`This replaces “${library.name}” on this device, and its stars. Export your stars first if you need them. Carry on?`);
    if (!replace) return;
  }

  dl.controller = new AbortController();
  const { signal } = dl.controller;
  setDownloadRunning(true);
  setProgress('Reading the Drive folder…', 0);
  try {
    const [folder, files] = await Promise.all([
      driveApi(`files/${folderId}`, { fields: 'name', supportsAllDrives: 'true' }, apiKey, signal),
      listDriveFolder(folderId, apiKey, signal),
    ]);
    if (typedKey) {
      saved.set(API_KEY_KEY, typedKey);
      $('apiKey').value = '';
      $('apiKey').required = false;
      $('apiKey').placeholder = 'Saved key will be used';
      $('apiKeyHint').textContent = 'Saved on this device.';
    }
    if (!files.length) throw new Error('No photos found in that folder.');

    // Reuse earlier names when updating the same folder, so stars stay attached.
    const previous = new Map(sameFolder ? library.photos.filter((p) => p.id).map((p) => [p.id, p.jpg]) : []);
    const taken = new Set(previous.values());
    const photos = files.map((f) => {
      let jpg = previous.get(f.id);
      if (!jpg) {
        const base = f.name.replace(/\.[^.]+$/, '');
        jpg = taken.has(`${base}.jpg`) ? `${base}_${f.id.slice(0, 6)}.jpg` : `${base}.jpg`;
        taken.add(jpg);
      }
      return { jpg, raw: f.name, id: f.id };
    });
    const localPhotos = sameFolder ? library.photos.filter((p) => !p.id) : [];
    if (!sameFolder) {
      await caches.delete(LIBRARY_CACHE);
      saved.remove(STARS_KEY);
    }
    library = { folderId, link: $('driveFolder').value.trim(), name: folder.name || 'Google Drive photos', size, photos: [...photos, ...localPhotos] };
    saved.set(LIBRARY_KEY, library);
    navigator.storage?.persist?.().catch(() => {});
    openLibrary(); // photos show straight away and fill in as they arrive

    const cache = await caches.open(LIBRARY_CACHE);
    const have = new Set((await cache.keys()).map((r) => r.url));
    const wanted = new Set(photos.flatMap((p) => [libraryUrl(p, false), libraryUrl(p, true)]));
    // Drop copies at an old size or of files no longer in the folder.
    for (const url of have) if (/\/library\/\d+\//.test(url) && !wanted.has(url)) await cache.delete(url);

    const jobs = photos.flatMap((p) => [[p, false], [p, true]]).filter(([p, thumb]) => !have.has(libraryUrl(p, thumb)));
    let done = photos.length * 2 - jobs.length;
    let bytes = 0;
    const failed = [];
    const report = () =>
      setProgress(
        `${Math.floor(done / 2)} of ${photos.length} photos saved on this device` + (bytes ? ` (${formatBytes(bytes)} downloaded)` : '') + '…',
        done / (photos.length * 2),
      );
    report();
    await holdWakeLock(true);

    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !signal.aborted) {
        const [p, thumb] = jobs[next++];
        try {
          const blob = await fetchPreview(p.id, thumb ? THUMB_PX : size, signal);
          await cache.put(libraryUrl(p, thumb), new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } }));
          bytes += blob.size;
        } catch (err) {
          if (signal.aborted) break;
          if (!thumb) failed.push(p.raw);
        }
        done++;
        report();
      }
    };
    await Promise.all(Array.from({ length: WEB_CONCURRENCY }, worker));
    if (signal.aborted) throw Object.assign(new Error('Paused'), { name: 'AbortError' });

    if (failed.length) {
      setProgress(
        `Saved ${photos.length - failed.length} of ${photos.length}. ${failed.length} didn’t download (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''}). Tap Download to retry them.`,
        1,
        true,
      );
    } else {
      setProgress(`All ${photos.length} photos are saved on this device.`, 1);
      toast(`All ${photos.length} photos saved on this device`);
    }
    showLibraryStatus();
  } catch (err) {
    if (err.name === 'AbortError') setProgress('Paused. Tap Download to carry on where it stopped.');
    else setProgress(err.message, undefined, true);
  } finally {
    holdWakeLock(false);
    setDownloadRunning(false);
    dl.controller = null;
  }
}

// JPGs already on the device (say, an unzipped offline copy) are copied into the app's storage.
async function addLocalPhotos(files) {
  if (MODE !== 'web') return;
  const jpgs = files.filter((f) => /\.jpe?g$/i.test(f.name));
  if (!jpgs.length) return toast('Choose JPG photos', true);
  library ||= { folderId: null, link: '', name: 'Photos on this device', size: 2048, photos: [] };
  const known = new Set(library.photos.map((p) => p.jpg.toLowerCase()));
  const cache = await caches.open(LIBRARY_CACHE);
  let added = 0;
  for (const [n, file] of jpgs.entries()) {
    toast(`Adding photos… ${n + 1} / ${jpgs.length}`);
    if (known.has(file.name.toLowerCase())) continue;
    const photo = { jpg: file.name, raw: file.name.replace(/\.[^.]+$/, '') + '.ARW' };
    await cache.put(libraryUrl(photo, false), new Response(file, { headers: { 'Content-Type': 'image/jpeg' } }));
    await cache.put(libraryUrl(photo, true), new Response(await makeThumb(file), { headers: { 'Content-Type': 'image/jpeg' } }));
    library.photos.push(photo);
    known.add(file.name.toLowerCase());
    added++;
  }
  library.photos.sort((a, b) => naturalSort(a.jpg, b.jpg));
  saved.set(LIBRARY_KEY, library);
  navigator.storage?.persist?.().catch(() => {});
  openLibrary();
  toast(added ? `Added ${added} photo${added === 1 ? '' : 's'}` : 'Those photos were already here');
}

async function makeThumb(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, THUMB_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
}

async function removeLibrary() {
  if (!library) return toast('Nothing is saved on this device yet');
  const sure = confirm(
    `Remove all ${library.photos.length} photos of “${library.name}” from this device? Your stars go too, so export them first if you need them.`,
  );
  if (!sure) return;
  await caches.delete(LIBRARY_CACHE);
  saved.remove(LIBRARY_KEY);
  saved.remove(STARS_KEY);
  library = null;
  loadPhotos('', [], []);
  toast('Removed from this device');
}

// ---------- phone ----------

async function openPhoneDialog() {
  const { phoneUrls } = await api('/api/config').catch(() => ({}));
  const body = $('phoneBody');
  if (!phoneUrls) {
    body.innerHTML =
      '<p>Phone access is off. Quit the viewer (Ctrl+C in Terminal) and start it again with:</p>' +
      '<pre class="mono code">npm run phone</pre>';
  } else if (!phoneUrls.length) {
    body.innerHTML = '<p>This Mac isn’t connected to a network, so your phone can’t reach it.</p>';
  } else {
    body.innerHTML =
      '<p>Scan this with your phone’s camera. The phone has to be on the same Wi-Fi as this Mac.</p>' +
      '<div id="qr" class="qr"></div><p id="phoneLinks" class="mono"></p>' +
      '<p class="muted">The link has a secret key in it. Anyone on your Wi-Fi with the link can see and star the photos, so only share it with people you trust.</p>';
    $('phoneLinks').innerHTML = phoneUrls.map(() => '<span></span>').join('<br>');
    $('phoneLinks').querySelectorAll('span').forEach((el, i) => (el.textContent = phoneUrls[i]));
    renderQr($('qr'), phoneUrls[0]);
  }
  $('phoneDialog').showModal();
}

function renderQr(el, text) {
  const draw = () => {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  };
  if (window.qrcode) return draw();
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  script.onload = draw;
  script.onerror = () => (el.textContent = 'QR code needs an internet connection. Type the link instead.');
  document.head.append(script);
}

// ---------- wiring ----------

$('openFolderBtn').addEventListener('click', chooseAndOpenFolder);
$('downloadBtn').addEventListener('click', openDownloadDialog);
$('exportBtn').addEventListener('click', exportStarred);
$('menu').addEventListener('beforetoggle', (e) => {
  if (e.newState !== 'open') return;
  const r = $('menuBtn').getBoundingClientRect();
  $('menu').style.top = `${r.bottom + 6}px`;
  $('menu').style.right = `${document.documentElement.clientWidth - r.right}px`;
});
$('menu').addEventListener('click', (e) => {
  const action = e.target.closest('[data-menu]')?.dataset.menu;
  if (!action) return;
  $('menu').hidePopover();
  if (action === 'import') openImportDialog();
  if (action === 'offline') openOfflineDialog();
  if (action === 'download') openDownloadDialog();
  if (action === 'addLocal') $('localFiles').click();
  if (action === 'removeLibrary') removeLibrary();
  if (action === 'help') $('helpDialog').showModal();
});
$('starBtn').addEventListener('click', toggleStar);
$('phoneBtn').addEventListener('click', openPhoneDialog);
$('filterAll').addEventListener('click', () => setFilter('all'));
$('filterStarred').addEventListener('click', () => setFilter('starred'));
$('empty').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'open') chooseAndOpenFolder();
  if (action === 'download') openDownloadDialog();
  if (action === 'addLocal') $('localFiles').click();
});
$('localFiles').addEventListener('change', () => {
  const files = [...$('localFiles').files];
  $('localFiles').value = '';
  addLocalPhotos(files).catch((err) => toast(err.message, true));
});

// Keep focus off toolbar buttons so space always stars instead of re-clicking a button.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && !btn.closest('dialog')) btn.blur();
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      go(1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      go(-1);
      break;
    case 'Home':
      go(-Infinity);
      break;
    case 'End':
      go(Infinity);
      break;
    case ' ':
      toggleStar();
      break;
    case '+':
    case '=':
      zoomAtCentre(1.25);
      break;
    case '-':
    case '_':
      zoomAtCentre(0.8);
      break;
    case '0':
      resetToFit();
      renderZoom();
      break;
    case 'z':
    case 'Z':
    case '1':
      toggleActualSize();
      break;
    case 's':
    case 'S':
      setFilter(state.filter === 'all' ? 'starred' : 'all');
      break;
    case '?':
      $('helpDialog').showModal();
      break;
    default:
      return;
  }
  e.preventDefault();
});

// On startup: if a Mac server answers, reopen its last folder; otherwise this is the web version.
(async () => {
  updateChrome();
  const config = await fetch('/api/config')
    .then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null))
    .catch(() => null);
  if (!config) return startWeb();
  document.body.classList.toggle('remote', Boolean(config.remote));
  if (config.lastDir) await openFolder(config.lastDir).catch((err) => toast(err.message, true));
})();
