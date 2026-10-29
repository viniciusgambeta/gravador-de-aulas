import {
  DIMS, PRESETS, BACKGROUNDS, MAX_LAYOUTS, defaultScene, defaultLayouts, makeLayout, newId,
} from './layouts.js';
import { Compositor, Feed, createTicker } from './compositor.js';
import { AudioMixer } from './audio.js';
import { Editor } from './editor.js';
import { Cutter } from './cutter.js';
import { Gallery } from './gallery.js';
import { icon, hydrateIcons } from './icons.js';

const api = window.api;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

hydrateIcons();

// ================================================================== state

const info = await api.info();
const saved = await api.getSettings();

// The recording itself is a high-bitrate master (temporary); the size of the
// final file is decided at export by x264's CRF.
const RAW_BPS = { main: 10e6, camera: 8e6, screen: 12e6 };
const QUALITY = {
  eco: { crf: 28, note: 'Arquivos bem leves: cerca de 100 a 400 MB por hora de aula.' },
  standard: { crf: 26, note: 'Ótimo equilíbrio: cerca de 150 a 500 MB por hora, sem perda visível.' },
  high: { crf: 23, note: 'Mais nitidez em detalhes finos: cerca de 250 a 800 MB por hora.' },
};

const prefs = {
  outDir: info.defaultOutDir,
  fps: 30,
  quality: 'standard',
  countdown: 3,
  mirror: false,
  micGain: 1,
  noise: true,
  systemAudio: false,
  openEditor: true,
  levelAudio: true,
  keepOriginal: false,
  recordMode: 'final', // 'final' | 'all' (final + camera + screen)
  intro: null, // horizontal intro { path, url, name, isImage, hasAudio, duration }
  introV: null, // vertical intro
  introEnabled: true,
  transition: null, // "a few moments later" clip, horizontal
  transitionV: null, // vertical
  audioDelay: 100, // ms: delay assumed for a camera that was never calibrated
  syncByCamera: {}, // camera label -> measured delay (ms), from the clap test
  logo: null, // watermark image { path, url, name, width, height }
  logoOn: true,
  logoPos: 'tr',
  logoSize: 12, // % of the frame width
  logoOpacity: 0.9,
  mdeAuto: false, // send to the MDE lessons panel right after exporting
  mdeBaseUrl: '', // empty = default API address
  ...(saved.prefs || {}),
};
if (!QUALITY[prefs.quality]) prefs.quality = 'standard';

let screenAspect = saved.screenAspect || 16 / 9;

function sanitizeLayout(l, o) {
  const base = PRESETS[o].some((p) => p.key === l.base) ? l.base : PRESETS[o][0].key;
  const def = defaultScene(base, screenAspect);
  return {
    id: l.id || newId(),
    name: String(l.name || 'Layout').slice(0, 40),
    base,
    custom: !!l.custom,
    order: Array.isArray(l.order) && l.order.length === 2 ? l.order : def.order,
    screen: { ...def.screen, ...(l.screen || {}) },
    camera: { ...def.camera, ...(l.camera || {}) },
  };
}

function loadLayoutSets() {
  const sets = { h: null, v: null };
  if (saved.layoutSets) {
    for (const o of ['h', 'v']) {
      const list = saved.layoutSets[o];
      if (Array.isArray(list) && list.length) sets[o] = list.slice(0, MAX_LAYOUTS).map((l) => sanitizeLayout(l, o));
    }
  } else if (Array.isArray(saved.layouts) && saved.layouts.length) {
    sets.h = saved.layouts.slice(0, MAX_LAYOUTS).map((l) => sanitizeLayout(l, 'h')); // v1.1
  } else if (saved.scenes) {
    sets.h = defaultLayouts(screenAspect, 'h').map((l) => {
      const s = saved.scenes[l.id]; // v1.0: one scene per fixed preset
      return s && s.screen && s.camera ? sanitizeLayout({ ...s, id: l.id, name: l.name, base: l.base }, 'h') : l;
    });
  }
  for (const o of ['h', 'v']) if (!sets[o]) sets[o] = defaultLayouts(screenAspect, o);
  return sets;
}

const S = {
  screen: saved.screen || null, // { id, name, type, displayId, width, height }
  cameraId: saved.cameraId ?? null,
  micId: saved.micId ?? null,
  orientation: saved.orientation === 'v' ? 'v' : 'h',
  layouts: loadLayoutSets(),
  active: { h: null, v: null },
  bg: saved.bg || { key: 'preto' },
  screenCrop: saved.screenCrop || null, // { displayId, x, y, w, h } as fractions of that screen
};
{
  const act = typeof saved.active === 'object' && saved.active ? saved.active : { h: saved.active };
  for (const o of ['h', 'v']) {
    S.active[o] = S.layouts[o].some((l) => l.id === act[o]) ? act[o] : S.layouts[o][0].id;
  }
}

const dims = () => DIMS[S.orientation];
const layouts = () => S.layouts[S.orientation];
const scene = () => layouts().find((l) => l.id === S.active[S.orientation]) || layouts()[0];
const activeIndex = () => Math.max(0, layouts().findIndex((l) => l.id === S.active[S.orientation]));
const layoutById = (id) => layouts().find((l) => l.id === id);

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api.setSettings({
      prefs,
      screen: S.screen,
      cameraId: S.cameraId,
      micId: S.micId,
      orientation: S.orientation,
      screenCrop: S.screenCrop,
      layoutSets: S.layouts,
      active: S.active,
      bg: S.bg,
      screenAspect,
      layouts: undefined,
      scenes: undefined,
    });
  }, 250);
}

// ================================================================== engine

const canvas = $('#canvas');
const compositor = new Compositor(canvas);
const mixer = new AudioMixer();
compositor.mirror = prefs.mirror;
mixer.setMicGain(prefs.micGain);

const feeds = { screen: null, camera: null };
const streams = { mic: null, sys: null };
let devices = [];
let sourceList = [];

const editor = new Editor({
  overlay: $('#overlay'),
  getScene: scene,
  getSourceSize: (name) => compositor.sourceSize(name),
  hasFeed: (name) => !!feeds[name],
  onBegin: beginChange,
  onChange: (name, patch) => updateLayer(name, patch),
  onCommit: (changed) => commitChange(changed),
  onSelect: () => {
    renderLayers();
    renderProps();
  },
});

const introFor = (o) => (o === 'v' ? (prefs.introV || prefs.intro) : prefs.intro);
const orientationOfProject = (p) => p.orientation || (p.height > p.width ? 'v' : 'h');
const transitionFor = (o) => (o === 'v' ? (prefs.transitionV || prefs.transition) : (prefs.transition || prefs.transitionV));

const cutter = new Cutter({
  api,
  toast: (...a) => toast(...a),
  confirm: (o) => confirmBox(o),
  getIntro: (project) => ({ intro: introFor(orientationOfProject(project || {})), enabled: prefs.introEnabled }),
  getTransition: (project) => transitionFor(orientationOfProject(project || {})) || null,
  getAudioDelay: () => prefs.audioDelay, // recordings made before the delay was applied while recording
  onSetupTransition: () => openSettings('transition'),
  getFps: () => prefs.fps,
  onExport: (project, opts) => exportProject(project, opts),
  onClose: (why) => {
    if (why === 'discarded') toast('Gravação enviada para a Lixeira.');
    if (why === 'draft') toast('Rascunho salvo com os cortes. Continue quando quiser pela Galeria.', 'ok', 5000, { label: 'Abrir galeria', onClick: () => setView('gallery') });
    gallery.markStale();
  },
  onSetupIntro: () => openSettings('intro'),
});

const gallery = new Gallery({
  api,
  toast: (...a) => toast(...a),
  confirm: (o) => confirmBox(o),
  getDir: () => prefs.outDir,
  onWatch: (item) => showWatch(item),
  onEdit: (item) => editItem(item),
  onEmptyAction: () => setView('studio'),
  getMde: (item) => (item.folder && liveMde.get(item.folder)) || item.mde || null,
  canMde: () => mdeInfo.hasKey,
  onMdeSend: (item) => sendToMde(item.folder, item.main, item.title, { fresh: item.mde && item.mde.status === 'ready' }),
  onMdeOpen: (url) => api.mde.open(url),
});

// ================================================================== Comunidade MDE

let mdeInfo = { hasKey: false, last4: '', baseUrl: '', defaultUrl: '' };
let mdeEditingKey = false;
const liveMde = new Map(); // folder -> latest upload state
const mdeNotified = new Set();

async function refreshMdeInfo() {
  mdeInfo = await api.mde.info().catch(() => mdeInfo);
  renderMdePane();
}

function renderMdePane() {
  const has = mdeInfo.hasKey;
  $('#mde-connected').hidden = !has || mdeEditingKey;
  $('#mde-form').hidden = has && !mdeEditingKey;
  $('#mde-conn-sub').textContent = `Chave •••• ${mdeInfo.last4}`;
  $('#mde-auto').checked = !!prefs.mdeAuto;
  $('#mde-auto').disabled = !has;
  $('#mde-base').value = prefs.mdeBaseUrl || mdeInfo.defaultUrl;
  $('#mde-tab-dot').hidden = !has;
}

function mdeMessage(text, kind = '') {
  const el = $('#mde-msg');
  el.hidden = !text;
  el.className = `mde-msg ${kind}`;
  el.textContent = text || '';
}

function bindMde() {
  $('#mde-save').addEventListener('click', async () => {
    const input = $('#mde-key');
    const key = input.value.trim();
    if (!key) { mdeMessage('Cole a sua chave de API primeiro.', 'bad'); return; }
    $('#mde-save').disabled = true;
    mdeMessage('Testando a conexão…');
    const res = await api.mde.setKey(key).catch((err) => ({ ok: false, message: cleanError(err) }));
    $('#mde-save').disabled = false;
    input.value = '';
    if (res.ok) {
      mdeEditingKey = false;
      mdeMessage('');
      toast('Conectado à Comunidade MDE.', 'ok');
    } else if (res.code === 'INVALID_API_KEY') {
      await api.mde.clearKey();
      mdeMessage(res.message, 'bad');
    } else {
      mdeMessage(`Chave salva, mas não consegui confirmar agora: ${res.message || 'sem resposta'}`, 'bad');
      mdeEditingKey = false;
    }
    await refreshMdeInfo();
    const box = $('#mde-connected');
    box.classList.toggle('bad', !res.ok);
    $('#mde-conn-title').textContent = res.ok ? 'Conectado' : 'Chave salva · não confirmada';
  });
  $('#mde-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#mde-save').click(); });
  $('#mde-retest').addEventListener('click', async () => {
    $('#mde-retest').disabled = true;
    const res = await api.mde.test().catch((err) => ({ ok: false, message: cleanError(err) }));
    $('#mde-retest').disabled = false;
    $('#mde-connected').classList.toggle('bad', !res.ok);
    $('#mde-conn-title').textContent = res.ok ? 'Conectado' : 'Não conectado';
    toast(res.ok ? 'Conexão com o MDE funcionando.' : res.message, res.ok ? 'ok' : 'error', 6000);
  });
  $('#mde-change').addEventListener('click', () => {
    mdeEditingKey = true;
    renderMdePane();
    $('#mde-key').focus();
  });
  $('#mde-auto').addEventListener('change', (e) => { prefs.mdeAuto = e.target.checked; persist(); });
  $('#mde-base').addEventListener('change', (e) => {
    const v = e.target.value.trim().replace(/\/+$/, '');
    prefs.mdeBaseUrl = !v || v === mdeInfo.defaultUrl ? '' : v;
    persist();
  });

  api.mde.onStatus((st) => {
    liveMde.set(st.folder, st);
    renderMdePill();
    if (gallery.isOpen) gallery.render();
    const key = `${st.folder}|${st.status}|${st.phase}`;
    if (mdeNotified.has(key)) return;
    if (st.status === 'ready' && st.phase === 'done') {
      mdeNotified.add(key);
      toast(`“${st.title}” está pronta no painel do MDE (rascunho).`, 'ok', 9000, st.adminUrl ? { label: 'Abrir aula', onClick: () => api.mde.open(st.adminUrl) } : null);
    } else if (st.phase === 'error' || st.status === 'failed' || st.status === 'superseded') {
      mdeNotified.add(key);
      toast(`Envio ao MDE: ${st.message || st.errorCode || 'falhou'}`, 'error', 10000);
    }
  });
  $('#mde-pill').addEventListener('click', () => setView('gallery'));
}

function renderMdePill() {
  const active = [...liveMde.values()].filter((m) => ['reserving', 'uploading', 'processing'].includes(m.phase));
  const pill = $('#mde-pill');
  pill.hidden = !active.length;
  if (!active.length) return;
  const m = active[0];
  const label = active.length > 1 ? `${active.length} envios`
    : m.phase === 'uploading' ? `enviando ${Math.round((m.sentPct || 0) * 100)}%`
      : m.phase === 'processing' ? `processando ${Math.round(m.encodeProgress || 0)}%` : 'preparando';
  pill.innerHTML = `<span class="spinner"></span> MDE · ${label}`;
}

async function sendToMde(folder, file, title, opts = {}) {
  if (!mdeInfo.hasKey) {
    toast('Conecte sua conta da Comunidade MDE primeiro.', 'info', 6000, { label: 'Configurar', onClick: () => openSettings('mde') });
    return null;
  }
  try {
    const st = await api.mde.send(folder, { file, title, fresh: !!opts.fresh });
    if (st) liveMde.set(folder, { folder, ...st });
    renderMdePill();
    toast(`Enviando “${title}” para o MDE…`, 'info', 4000);
    return st;
  } catch (err) {
    toast(`Não foi possível enviar ao MDE. ${cleanError(err)}`, 'error', 8000);
    return null;
  }
}

// ================================================================== screen area (record part of the screen)

function activeCrop() {
  const c = S.screenCrop;
  return c && S.screen && S.screen.type === 'screen' && String(c.displayId) === String(S.screen.displayId)
    ? { x: c.x, y: c.y, w: c.w, h: c.h } : null;
}

function applyScreenCrop(fallbackAspect = 0) {
  const crop = activeCrop();
  compositor.setCrop('screen', crop);
  const size = compositor.sourceSize('screen');
  const aspect = size ? size.w / size.h : (fallbackAspect && crop ? fallbackAspect * (crop.w / crop.h) : fallbackAspect);
  if (aspect) onScreenAspect(aspect);
  renderAreaRow();
  editor.render();
}

function renderAreaRow() {
  const crop = activeCrop();
  const row = $('#area-row');
  if (!row) return;
  const isScreen = S.screen && S.screen.type === 'screen';
  row.classList.toggle('on', !!crop);
  $('#area-pick').disabled = !isScreen;
  $('#area-clear').hidden = !crop;
  if (crop && S.screen) {
    const w = Math.round((S.screen.width || 1920) * crop.w);
    const h = Math.round((S.screen.height || 1080) * crop.h);
    $('#area-title').textContent = `Área selecionada: ${w} × ${h}`;
    $('#area-sub').textContent = 'Só essa parte da tela entra na gravação.';
  } else {
    $('#area-title').textContent = 'Tela inteira';
    $('#area-sub').textContent = isScreen ? 'Grave só uma parte da tela: um app, um navegador, uma região.' : 'Para janelas, a janela inteira é gravada.';
  }
}

async function pickScreenArea() {
  if (!S.screen || S.screen.type !== 'screen') {
    toast('Escolha uma tela (não uma janela) para selecionar uma área.');
    return;
  }
  const rect = await api.selectRegion(S.screen.displayId).catch(() => null);
  if (!rect) return;
  S.screenCrop = { displayId: S.screen.displayId, ...rect };
  persist();
  applyScreenCrop();
  toast('Área definida. Ajuste o layout se quiser: o enquadramento já usa só essa parte.', 'ok');
}

// ================================================================== logo (watermark)

let logoImg = null;
function applyLogo() {
  if (!prefs.logo || !prefs.logoOn) {
    compositor.setLogo(null);
    return;
  }
  if (!logoImg || logoImg.dataset.url !== prefs.logo.url) {
    logoImg = new Image();
    logoImg.dataset.url = prefs.logo.url;
    logoImg.src = prefs.logo.url;
  }
  compositor.setLogo({ img: logoImg, pos: prefs.logoPos, size: prefs.logoSize, opacity: prefs.logoOpacity });
}

function renderLogoSettings() {
  const l = prefs.logo;
  $('#logo-remove').hidden = !l;
  $('#logo-opts').hidden = !l;
  $('#logo-pick').textContent = l ? 'Trocar…' : 'Escolher imagem…';
  $('#logo-name').textContent = l ? l.name : 'Nenhuma logo definida';
  const prev = $('#logo-preview');
  if (!l) { prev.dataset.sig = ''; prev.innerHTML = icon('image', 22); }
  else if (prev.dataset.sig !== l.url) { prev.dataset.sig = l.url; prev.innerHTML = `<img src="${esc(l.url)}" alt="" />`; }
  $$('#logo-pos button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.logoPos));
  $('#logo-size').value = prefs.logoSize;
  setRangeFill($('#logo-size'));
  $('#logo-size-val').textContent = `${prefs.logoSize}% da largura`;
  $('#logo-op').value = Math.round(prefs.logoOpacity * 100);
  setRangeFill($('#logo-op'));
  $('#logo-op-val').textContent = `${Math.round(prefs.logoOpacity * 100)}%`;
  $('#logo-on').checked = prefs.logoOn;
}

function bindExtras() {
  $('#area-pick').addEventListener('click', pickScreenArea);
  $('#area-clear').addEventListener('click', () => {
    S.screenCrop = null;
    persist();
    applyScreenCrop();
  });
  $('#logo-pick').addEventListener('click', async () => {
    try {
      const logo = await api.pickIntro('logo');
      if (!logo) return;
      prefs.logo = logo;
      prefs.logoOn = true;
      persist();
      applyLogo();
      renderLogoSettings();
    } catch (err) {
      toast(`Não foi possível usar essa imagem. ${cleanError(err)}`, 'error');
    }
  });
  $('#logo-remove').addEventListener('click', () => { prefs.logo = null; persist(); applyLogo(); renderLogoSettings(); });
  $('#logo-pos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    prefs.logoPos = b.dataset.v;
    persist(); applyLogo(); renderLogoSettings();
  });
  $('#logo-size').addEventListener('input', (e) => { prefs.logoSize = Number(e.target.value); persist(); applyLogo(); renderLogoSettings(); });
  $('#logo-op').addEventListener('input', (e) => { prefs.logoOpacity = Number(e.target.value) / 100; persist(); applyLogo(); renderLogoSettings(); });
  $('#logo-on').addEventListener('change', (e) => { prefs.logoOn = e.target.checked; persist(); applyLogo(); });
  $('#btn-script').addEventListener('click', () => api.script.toggle());
  api.script.onState((open) => $('#btn-script').classList.toggle('on', !!open));
}

// ================================================================== capture pause (editor / gallery)

// Camera, screen and mic are released while editing or browsing: it frees the
// CPU/GPU for smooth preview and fast exports, and they come back in the studio.
let captureSuspended = false;
function suspendCapture() {
  if (captureSuspended || R.state !== 'idle') return;
  captureSuspended = true;
  for (const k of ['screen', 'camera']) {
    if (feeds[k]) { feeds[k].stop(); feeds[k] = null; compositor.setFeed(k, null); }
  }
  for (const k of ['mic', 'sys']) {
    if (streams[k]) { streams[k].getTracks().forEach((t) => t.stop()); streams[k] = null; }
  }
  mixer.setMic(null);
  mixer.setSystem(null);
}

async function resumeCapture() {
  if (!captureSuspended) return;
  captureSuspended = false;
  const src = S.screen ? (sourceList.find((x) => x.id === S.screen.id) || S.screen) : null;
  await Promise.all([setScreen(src), setCamera(S.cameraId), setMic(S.micId)]);
  if (prefs.systemAudio) setSystemAudio(true);
}

{
  const open = cutter.open.bind(cutter);
  const close = cutter.close.bind(cutter);
  cutter.open = (project) => { suspendCapture(); return open(project); };
  cutter.close = () => { close(); if (view === 'studio') resumeCapture(); };
}

// ================================================================== views (studio / gallery)

let view = 'studio';
function setView(next) {
  view = next;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === next));
  if (next === 'gallery') {
    closeModals();
    closeLayoutMenu();
    gallery.show();
    suspendCapture();
  } else {
    gallery.hide();
    fitStage();
    if (!cutter.isOpen) resumeCapture();
  }
}

// ================================================================== history (undo / redo)

const history = [];
const future = [];
let pendingSnapshot = null;

const snapshot = () => JSON.stringify({ layouts: S.layouts, active: S.active, bg: S.bg });

function beginChange() {
  if (!pendingSnapshot) pendingSnapshot = snapshot();
}

function commitChange(changed = true) {
  if (pendingSnapshot && changed && pendingSnapshot !== snapshot()) {
    history.push(pendingSnapshot);
    if (history.length > 100) history.shift();
    future.length = 0;
  }
  pendingSnapshot = null;
  updateUndoButtons();
  persist();
}

function restore(snap) {
  const data = JSON.parse(snap);
  S.layouts = data.layouts;
  S.active = data.active;
  S.bg = data.bg;
  applyBackground();
  compositor.setScene(scene(), { animate: true, duration: 260 });
  if (editor.selected && !scene()[editor.selected]?.visible) editor.select(null);
  renderAll();
  sendBarStatus();
  persist();
}

function undo() {
  if (!history.length) return;
  future.push(snapshot());
  restore(history.pop());
  updateUndoButtons();
}

function redo() {
  if (!future.length) return;
  history.push(snapshot());
  restore(future.pop());
  updateUndoButtons();
}

function updateUndoButtons() {
  $('#btn-undo').disabled = !history.length;
  $('#btn-redo').disabled = !future.length;
}

// ================================================================== scene edits

function updateLayer(name, patch) {
  const sc = scene();
  Object.assign(sc[name], patch);
  sc.custom = true;
  compositor.setScene(sc);
  editor.render();
  syncProps();
  renderLayoutGrid();
}

function editLayer(name, patch) {
  beginChange();
  updateLayer(name, patch);
  commitChange(true);
}

function setActiveLayout(id, animate = true) {
  if (!layoutById(id)) return;
  S.active[S.orientation] = id;
  compositor.setScene(scene(), { animate });
  renderAll();
  sendBarStatus();
  persist();
}

function setOrientation(o) {
  if (o === S.orientation) return;
  if (R.state !== 'idle') {
    toast('Não dá para trocar o formato durante a gravação.');
    return;
  }
  S.orientation = o;
  const d = dims();
  compositor.setSize(d.w, d.h);
  editor.setDims(d.w, d.h);
  editor.select(null);
  closeLayoutMenu();
  compositor.setScene(scene());
  renderAll();
  renderOrientation();
  renderOutput();
  fitStage();
  persist();
}

function renderOrientation() {
  $$('#orient-tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.o === S.orientation);
    b.disabled = R.state !== 'idle' && b.dataset.o !== S.orientation;
  });
  $('#layout-grid').classList.toggle('vertical', S.orientation === 'v');
}

function onScreenAspect(aspect) {
  if (!aspect || Math.abs(aspect - screenAspect) < 0.005) return;
  const old = screenAspect;
  screenAspect = aspect;
  for (const o of ['h', 'v']) {
    const H = DIMS[o].h;
    const list = S.layouts[o];
    list.forEach((sc, i) => {
      if (!sc.custom) {
        list[i] = makeLayout(sc.base, sc.name, aspect, sc.id);
        return;
      }
      // A customized screen frame that showed the whole old screen keeps showing
      // the whole new one: same center and width, new height (fit if too tall).
      const f = sc.screen;
      if (Math.abs(f.w / f.h - old) / old > 0.02) return;
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      let w = f.w;
      let h = w / aspect;
      if (h > H) { h = H; w = h * aspect; }
      Object.assign(f, { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) });
    });
  }
  compositor.setScene(scene());
  renderAll();
  persist();
}

function bgColors() {
  if (S.bg.key === 'custom') return [S.bg.color, S.bg.color];
  return (BACKGROUNDS.find((b) => b.key === S.bg.key) || BACKGROUNDS[0]).colors;
}

function applyBackground() {
  compositor.setBackground(bgColors());
}

// ================================================================== layouts: create / rename / duplicate / delete

function uniqueName(base) {
  const names = new Set(layouts().map((l) => l.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let i = 2;
  while (names.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

function insertLayout(copyOf, name) {
  const list = layouts();
  if (list.length >= MAX_LAYOUTS) {
    toast(`Você pode ter até ${MAX_LAYOUTS} layouts em cada formato (um por atalho Alt+Shift+1…9).`);
    return null;
  }
  beginChange();
  const copy = JSON.parse(JSON.stringify(copyOf));
  copy.id = newId();
  copy.name = uniqueName(name);
  copy.custom = true;
  const at = list.findIndex((l) => l.id === copyOf.id) + 1;
  list.splice(at, 0, copy);
  S.active[S.orientation] = copy.id;
  commitChange(true);
  compositor.setScene(scene(), { animate: true, duration: 300 });
  renderAll();
  sendBarStatus();
  return copy;
}

function addLayout() {
  const l = insertLayout(scene(), 'Novo layout');
  if (l) startRename(l.id);
}

function duplicateLayout(id) {
  const src = layoutById(id);
  if (src) insertLayout(src, `${src.name} (cópia)`);
}

function deleteLayout(id) {
  const list = layouts();
  if (list.length <= 1) {
    toast('É preciso ter pelo menos um layout.');
    return;
  }
  beginChange();
  const i = list.findIndex((l) => l.id === id);
  const [gone] = list.splice(i, 1);
  if (S.active[S.orientation] === id) {
    S.active[S.orientation] = list[Math.min(i, list.length - 1)].id;
    compositor.setScene(scene(), { animate: true });
  }
  commitChange(true);
  renderAll();
  sendBarStatus();
  toast(`Layout “${gone.name}” excluído.`, 'info', 6000, { label: 'Desfazer', onClick: undo });
}

function resetLayout(id) {
  const list = layouts();
  const i = list.findIndex((l) => l.id === id);
  if (i < 0) return;
  beginChange();
  const l = list[i];
  list[i] = makeLayout(l.base, l.name, screenAspect, l.id);
  if (id === S.active[S.orientation]) compositor.setScene(scene(), { animate: true, duration: 380 });
  commitChange(true);
  renderAll();
  sendBarStatus();
}

function renameLayout(id, value) {
  const l = layoutById(id);
  const name = value.trim().slice(0, 40);
  if (!l || !name || name === l.name) return;
  beginChange();
  l.name = name;
  commitChange(true);
  sendBarStatus();
}

let renaming = null;
function startRename(id) {
  closeLayoutMenu();
  const label = $(`#layout-grid [data-rename="${CSS.escape(id)}"]`);
  const l = layoutById(id);
  if (!label || !l) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lname-input';
  input.maxLength = 40;
  input.value = l.name;
  label.replaceWith(input);
  renaming = id;
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    renaming = null;
    if (save) renameLayout(id, input.value);
    renderLayoutGrid();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
}

let menuFor = null;
function openLayoutMenu(id, anchor) {
  const menu = $('#layout-menu');
  if (menuFor === id && !menu.hidden) {
    closeLayoutMenu();
    return;
  }
  menuFor = id;
  const panel = menu.offsetParent || menu.parentElement;
  const a = anchor.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  menu.hidden = false;
  const left = Math.min(a.right - p.left - menu.offsetWidth, p.width - menu.offsetWidth - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${a.bottom - p.top + 4}px`;
  menu.querySelector('[data-menu-act="duplicate"]').disabled = layouts().length >= MAX_LAYOUTS;
  menu.querySelector('[data-menu-act="delete"]').disabled = layouts().length <= 1;
}

function closeLayoutMenu() {
  $('#layout-menu').hidden = true;
  menuFor = null;
}

// ================================================================== devices

// "Default - Microphone (3- Shure MV7) (14ed:1012)" -> "Shure MV7"
const cleanLabel = (label = '') => {
  let s = label
    .replace(/^(Default|Padrão|Communications|Comunicações)\s*-\s*/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .replace(/\s*\(Bluetooth\)\s*$/i, '')
    .trim();
  const m = s.match(/^(?:Microphone|Microfone|Headset Microphone|Microfone do headset|Headset|Fone de ouvido|Fones de ouvido|Line|Linha|Mic)\s*\((.+)\)$/i);
  if (m) s = m[1];
  return s.replace(/^\d+-\s*/, '').trim();
};

// Cameras that show a placeholder until their companion app/phone is connected.
const VIRTUAL_CAM = /virtual|obs|quest|broadcast|iriun|droidcam|eos webcam|camo|epoccam|snap camera|xsplit|manycam|mmhmm/i;

async function refreshDevices() {
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    devices = [];
  }
  renderDeviceSelects();
}

const cameras = () => devices.filter((d) => d.kind === 'videoinput');
const mics = () => devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');

function cameraName(id) {
  const d = cameras().find((c) => c.deviceId === id);
  return d ? cleanLabel(d.label) || 'Câmera' : null;
}

function micName(id) {
  const d = mics().find((m) => m.deviceId === id);
  return d ? cleanLabel(d.label) || 'Microfone' : null;
}

let camToken = 0;
async function setCamera(id) {
  const token = ++camToken;
  S.cameraId = id || '';
  persist();
  if (feeds.camera) { feeds.camera.stop(); feeds.camera = null; }
  compositor.setFeed('camera', null);
  $('#cam-video').srcObject = null;
  renderCamPreview();
  if (id) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: id },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
      });
      if (token !== camToken) { stream.getTracks().forEach((t) => t.stop()); return; }
      feeds.camera = new Feed(stream, {
        onEnded: () => toast('A câmera foi desconectada.', 'error'),
        onResize: () => editor.render(),
      });
      compositor.setFeed('camera', feeds.camera);
      if (!$('#sources-modal').hidden) $('#cam-video').srcObject = stream;
    } catch (err) {
      if (token === camToken) toast(`Não foi possível abrir a câmera. ${friendlyError(err)}`, 'error');
    }
  }
  renderCamPreview();
  renderChips();
  renderLayers();
  editor.render();
  applySync();
}

// ---------------------------------------------------------------- lip sync
// A camera delivers each frame a little after it was seen (exposure, USB,
// driver), while the microphone is nearly instant. That delay is measured
// once per camera (clap test) and the voice is held back by it while
// recording, so every file already comes out in sync.

const cameraKey = () => (feeds.camera ? feeds.camera.track.label || S.cameraId : '');

function cameraDelay() {
  if (!feeds.camera) return 0;
  const ms = prefs.syncByCamera[cameraKey()];
  return Number.isFinite(ms) ? ms : prefs.audioDelay;
}

function applySync() {
  mixer.setDelay(cameraDelay());
  const note = $('#set-sync-note');
  if (!note) return;
  const ms = prefs.syncByCamera[cameraKey()];
  note.textContent = !feeds.camera ? 'Escolha uma câmera para calibrar.'
    : Number.isFinite(ms) ? `${cameraName(S.cameraId) || 'Câmera'}: atraso de ${ms} ms, compensado em toda gravação.`
      : `Esta câmera ainda não foi calibrada (usando ${prefs.audioDelay} ms). Leva uns 10 segundos.`;
  $('#set-sync-cal').disabled = !feeds.camera || R.state !== 'idle';
}

const calib = { token: 0 };

function openCalibration() {
  if (!feeds.camera || R.state !== 'idle') return;
  const v = $('#sync-video');
  v.srcObject = new MediaStream([feeds.camera.track]);
  v.style.transform = prefs.mirror ? 'scaleX(-1)' : '';
  v.play().catch(() => {});
  setCalib('Fique de frente para a câmera, com as mãos aparecendo na imagem. Ao começar, bata palmas 4 vezes, devagar, com uma pausa entre elas.', '', 'Começar');
  $('#sync-modal').hidden = false;
}

function closeCalibration() {
  calib.token++;
  if (calib.rec && calib.rec.state !== 'inactive') calib.rec.stop();
  $('#sync-modal').hidden = true;
  $('#sync-video').srcObject = null;
  mixer.setDelay(cameraDelay());
}

function setCalib(text, big, button) {
  $('#sync-msg').textContent = text;
  $('#sync-count').textContent = big;
  $('#sync-count').hidden = !big;
  const b = $('#sync-start');
  b.hidden = !button;
  b.textContent = button || '';
}

async function runCalibration() {
  if (!mixer.micSource) { setCalib('Escolha um microfone primeiro.', '', 'Tentar de novo'); return; }
  const token = ++calib.token;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = feeds.camera.track.clone();
  mixer.setDelay(0); // measure the raw delay
  mixer.resume();
  const chunks = [];
  const rec = new MediaRecorder(new MediaStream([clone, mixer.track]), { mimeType: pickMime(30), videoBitsPerSecond: 4e6 });
  calib.rec = rec;
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  try {
    for (const n of ['3', '2', '1']) {
      setCalib('Prepare as mãos…', n);
      await wait(700);
      if (token !== calib.token) return;
    }
    setCalib('Bata palmas 4 vezes, devagar.', '👏');
    await wait(6500);
    if (token !== calib.token) return;
    rec.stop();
    await stopped;
    setCalib('Medindo…', '');
    const res = await api.media.measureSync(await new Blob(chunks).arrayBuffer());
    if (token !== calib.token) return;
    // + half a frame: while recording, each tick draws the newest camera frame.
    const ms = Math.round(res.ms + 500 / prefs.fps);
    prefs.syncByCamera = { ...prefs.syncByCamera, [cameraKey()]: ms };
    persist();
    setCalib(`Pronto! Esta câmera entrega a imagem ${ms} ms depois do som. As próximas gravações com ela já saem sincronizadas.`, '✓', 'Medir de novo');
  } catch (err) {
    if (token === calib.token) setCalib(cleanError(err), '', 'Tentar de novo');
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    clone.stop();
    calib.rec = null;
    if (token === calib.token) applySync();
  }
}

let micToken = 0;
async function setMic(id) {
  const token = ++micToken;
  S.micId = id || '';
  persist();
  if (streams.mic) { streams.mic.getTracks().forEach((t) => t.stop()); streams.mic = null; }
  mixer.setMic(null);
  if (id) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: id },
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: prefs.noise,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
        },
      });
      if (token !== micToken) { stream.getTracks().forEach((t) => t.stop()); return; }
      streams.mic = stream;
      mixer.setMic(stream);
    } catch (err) {
      if (token === micToken) toast(`Não foi possível abrir o microfone. ${friendlyError(err)}`, 'error');
    }
  }
  renderChips();
  renderSourcesHint();
}

let screenToken = 0;
async function setScreen(src) {
  const token = ++screenToken;
  S.screen = src ? {
    id: src.id, name: src.name, type: src.type, displayId: src.displayId, width: src.width, height: src.height,
  } : null;
  persist();
  if (feeds.screen) { feeds.screen.stop(); feeds.screen = null; }
  compositor.setFeed('screen', null);
  renderThumbSelection();
  if (src) {
    const isScreen = src.type === 'screen';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            maxWidth: isScreen ? Math.min(3840, src.width || 3840) : 3840,
            maxHeight: isScreen ? Math.min(2160, src.height || 2160) : 2160,
            maxFrameRate: prefs.fps,
          },
        },
      });
      if (token !== screenToken) { stream.getTracks().forEach((t) => t.stop()); return; }
      feeds.screen = new Feed(stream, {
        onResize: () => applyScreenCrop(),
        onEnded: () => toast(isScreen ? 'A captura da tela foi interrompida.' : 'A janela capturada foi fechada.', 'error'),
      });
      compositor.setFeed('screen', feeds.screen);
      applyScreenCrop(isScreen && src.width ? src.width / src.height : 0);
    } catch (err) {
      if (token === screenToken) toast(`Não foi possível capturar a tela. ${friendlyError(err)}`, 'error');
    }
  }
  renderChips();
  renderLayers();
  editor.render();
}

let sysToken = 0;
async function setSystemAudio(on) {
  const token = ++sysToken;
  prefs.systemAudio = on;
  persist();
  if (streams.sys) { streams.sys.getTracks().forEach((t) => t.stop()); streams.sys = null; }
  mixer.setSystem(null);
  if (!on) return;
  try {
    if (!sourceList.length) sourceList = await api.listSources();
    const scr = (S.screen && S.screen.type === 'screen' ? S.screen : null) || sourceList.find((s) => s.type === 'screen');
    if (!scr) throw new Error('Nenhuma tela encontrada.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop', chromeMediaSourceId: scr.id, maxWidth: 320, maxHeight: 180, maxFrameRate: 1,
        },
      },
    });
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
    if (token !== sysToken) { stream.getTracks().forEach((t) => t.stop()); return; }
    streams.sys = stream;
    mixer.setSystem(stream);
  } catch (err) {
    if (token === sysToken) {
      toast(`Não foi possível capturar o áudio do computador. ${friendlyError(err)}`, 'error');
      prefs.systemAudio = false;
      $('#sysaudio').checked = false;
    }
  }
}

function friendlyError(err) {
  const name = err && err.name;
  if (name === 'NotReadableError') return 'O dispositivo pode estar em uso por outro programa.';
  if (name === 'NotAllowedError') return 'Verifique as permissões de privacidade do Windows.';
  if (name === 'OverconstrainedError' || name === 'NotFoundError') return 'O dispositivo não foi encontrado.';
  return err && err.message ? err.message : '';
}

function pickInitialCamera() {
  const list = cameras();
  if (S.cameraId === '') return '';
  if (S.cameraId && list.some((c) => c.deviceId === S.cameraId)) return S.cameraId;
  const real = list.find((c) => !VIRTUAL_CAM.test(c.label));
  return (real || list[0] || {}).deviceId || '';
}

function pickInitialMic() {
  const list = mics();
  if (S.micId === '') return '';
  if (S.micId && list.some((m) => m.deviceId === S.micId)) return S.micId;
  return (list.find((m) => m.deviceId === 'default') || list[0] || {}).deviceId || '';
}

function matchSavedScreen(list) {
  const s = S.screen;
  if (s) {
    const byId = list.find((x) => x.id === s.id);
    if (byId) return byId;
    if (s.type === 'screen') {
      const byDisplay = list.find((x) => x.type === 'screen' && x.displayId && x.displayId === s.displayId);
      if (byDisplay) return byDisplay;
    } else {
      const byName = list.find((x) => x.type === 'window' && x.name === s.name);
      if (byName) return byName;
    }
  }
  if (saved.screen === null && 'screen' in saved) return null; // the user chose "no screen"
  return list.find((x) => x.type === 'screen' && x.primary) || list.find((x) => x.type === 'screen') || null;
}

// ================================================================== rendering: inspector

function miniHTML(sc, o = S.orientation) {
  const { w: W, h: H } = DIMS[o];
  return sc.order.map((name) => {
    const l = sc[name];
    if (!l.visible) return '';
    const r = l.shape === 'circle' ? '50%' : `${Math.min(l.radius * 0.05, 4)}px`;
    return `<i class="m-${name}" style="left:${(l.x / W) * 100}%;top:${(l.y / H) * 100}%;width:${(l.w / W) * 100}%;height:${(l.h / H) * 100}%;border-radius:${r}"></i>`;
  }).join('');
}

function renderLayoutGrid() {
  if (renaming) return; // don't steal focus from a rename in progress
  const list = layouts();
  const active = S.active[S.orientation];
  $('#layout-grid').innerHTML = list.map((l, i) => `
    <div class="layout-card ${l.id === active ? 'on' : ''}" data-layout="${esc(l.id)}" title="${esc(l.name)} · Alt+Shift+${i + 1}">
      <span class="mini">${miniHTML(l)}<span class="key">${i + 1}</span></span>
      <span class="lname" data-rename="${esc(l.id)}">${esc(l.name)}</span>
      <button class="lc-more" data-menu="${esc(l.id)}" title="Opções do layout">${icon('more', 14)}</button>
    </div>`).join('')
    + (list.length < MAX_LAYOUTS ? `
    <button class="layout-card add" data-add title="Criar um novo layout a partir do atual">
      <span class="mini add-mini">${icon('plus', 18)}</span>
      <span class="lname">Novo</span>
    </button>` : '');
}

function layerSourceName(name) {
  if (name === 'screen') return S.screen && feeds.screen ? S.screen.name : 'sem fonte';
  return feeds.camera ? cameraName(S.cameraId) : 'sem fonte';
}

function renderLayers() {
  const sc = scene();
  const rows = [...sc.order].reverse();
  $('#layers').innerHTML = rows.map((name) => {
    const l = sc[name];
    return `
      <div class="layer-row ${editor.selected === name ? 'on' : ''} ${l.visible ? '' : 'hidden-layer'}" data-layer="${name}">
        <span class="lr-icon">${icon(name === 'screen' ? 'monitor' : 'camera', 16)}</span>
        <span class="lr-name">${name === 'screen' ? 'Tela' : 'Câmera'}</span>
        <span class="lr-sub">${esc(layerSourceName(name) || '')}</span>
        <button class="eye" data-eye="${name}" title="${l.visible ? 'Ocultar neste layout' : 'Mostrar neste layout'}">${icon(l.visible ? 'eye' : 'eyeOff', 16)}</button>
      </div>`;
  }).join('');
}

const BORDER_COLORS = ['#ffffff', '#000000', '#7b80ff', '#ff3b55'];

function renderProps() {
  const el = $('#props');
  const name = editor.selected;
  if (!name) {
    el.innerHTML = `
      <div class="panel-head"><h3>Ajustes</h3></div>
      <p class="props-empty">Clique na <b>tela</b> ou na <b>câmera</b> na prévia (ou nas camadas acima) para ajustar zoom, cantos, borda e sombra.</p>`;
    return;
  }
  const isCam = name === 'camera';
  const isTop = scene().order[scene().order.length - 1] === name;
  el.innerHTML = `
    <div class="panel-head"><h3>${isCam ? 'Câmera' : 'Tela'}</h3><button class="link" data-act="deselect">Concluir</button></div>

    <div class="prop">
      <div class="prop-label"><span>Zoom</span><output data-out="zoom"></output></div>
      <input type="range" min="100" max="600" step="1" data-prop="zoom" />
    </div>

    ${isCam ? `
    <div class="prop">
      <div class="prop-label"><span>Formato</span></div>
      <div class="seg full" data-seg="shape">
        <button data-v="rect">Retângulo</button>
        <button data-v="circle">Círculo</button>
      </div>
    </div>` : ''}

    <div class="prop" data-wrap="radius">
      <div class="prop-label"><span>Cantos arredondados</span><output data-out="radius"></output></div>
      <input type="range" min="0" max="120" step="1" data-prop="radius" />
    </div>

    <div class="prop">
      <div class="prop-label"><span>Borda</span><output data-out="borderWidth"></output></div>
      <div class="border-row">
        <button class="color-dot none" data-border="none" title="Sem borda"></button>
        ${BORDER_COLORS.map((c) => `<button class="color-dot" data-border="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <label class="color-dot custom" title="Outra cor"><input type="color" data-border-custom /></label>
      </div>
      <input type="range" min="1" max="24" step="1" data-prop="borderWidth" style="margin-top:10px" />
    </div>

    <label class="prop-inline"><span>Sombra</span><input type="checkbox" class="switch" data-check="shadow" /></label>
    ${isCam ? '<label class="prop-inline"><span>Espelhar imagem</span><input type="checkbox" class="switch" data-check="mirror" /></label>' : ''}

    <div class="prop-actions">
      <button class="btn sm" data-act="center">Centralizar</button>
      <button class="btn sm" data-act="fill">Preencher</button>
      ${isTop ? '' : `<button class="btn sm" data-act="front" title="Trazer para frente">${icon('front', 15)} Frente</button>`}
    </div>`;
  syncProps();
}

function setRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  input.style.setProperty('--p', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function syncProps() {
  const name = editor.selected;
  const el = $('#props');
  if (!name || !el.querySelector('[data-prop]')) return;
  const l = scene()[name];
  const active = document.activeElement;
  const setRange = (prop, value) => {
    const input = el.querySelector(`[data-prop="${prop}"]`);
    if (!input) return;
    if (input !== active) input.value = value;
    setRangeFill(input);
  };
  setRange('zoom', Math.round(l.zoom * 100));
  el.querySelector('[data-out="zoom"]').textContent = `${Math.round(l.zoom * 100)}%`;
  setRange('radius', l.radius);
  el.querySelector('[data-out="radius"]').textContent = l.shape === 'circle' ? '—' : `${Math.round(l.radius)} px`;
  el.querySelector('[data-prop="radius"]').disabled = l.shape === 'circle';
  el.querySelector('[data-wrap="radius"]').style.opacity = l.shape === 'circle' ? 0.45 : 1;

  setRange('borderWidth', Math.max(1, l.borderWidth));
  el.querySelector('[data-prop="borderWidth"]').style.display = l.borderWidth > 0 ? '' : 'none';
  el.querySelector('[data-out="borderWidth"]').textContent = l.borderWidth > 0 ? `${l.borderWidth} px` : 'Sem borda';
  $$('[data-border]', el).forEach((b) => {
    const v = b.dataset.border;
    b.classList.toggle('on', v === 'none' ? l.borderWidth === 0 : l.borderWidth > 0 && v.toLowerCase() === l.borderColor.toLowerCase());
  });
  const custom = el.querySelector('[data-border-custom]');
  const isPresetColor = BORDER_COLORS.includes(l.borderColor.toLowerCase());
  custom.parentElement.classList.toggle('on', l.borderWidth > 0 && !isPresetColor);
  if (custom !== active) custom.value = /^#[0-9a-f]{6}$/i.test(l.borderColor) ? l.borderColor : '#ffffff';

  el.querySelector('[data-check="shadow"]').checked = !!l.shadow;
  const mirror = el.querySelector('[data-check="mirror"]');
  if (mirror) mirror.checked = prefs.mirror;
  $$('[data-seg="shape"] button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === l.shape));
}

function bindProps() {
  const el = $('#props');
  el.addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) beginChange(); });
  el.addEventListener('input', (e) => {
    const name = editor.selected;
    if (!name) return;
    const t = e.target;
    if (t.dataset.prop === 'zoom') {
      updateLayer(name, editor.setZoom(name, Number(t.value) / 100));
    } else if (t.dataset.prop === 'radius') {
      updateLayer(name, { radius: Number(t.value) });
    } else if (t.dataset.prop === 'borderWidth') {
      updateLayer(name, { borderWidth: Number(t.value) });
    } else if (t.dataset.borderCustom !== undefined) {
      beginChange();
      updateLayer(name, { borderColor: t.value, borderWidth: scene()[name].borderWidth || 5 });
    }
    if (t.type === 'range') setRangeFill(t);
  });
  el.addEventListener('change', (e) => {
    const name = editor.selected;
    if (!name) return;
    const t = e.target;
    if (t.type === 'range' || t.dataset.borderCustom !== undefined) {
      commitChange(true);
    } else if (t.dataset.check === 'shadow') {
      editLayer(name, { shadow: t.checked });
    } else if (t.dataset.check === 'mirror') {
      setMirror(t.checked);
    }
  });
  el.addEventListener('click', (e) => {
    const name = editor.selected;
    const b = e.target.closest('button');
    if (!b || !name) return;
    const l = scene()[name];
    const { w: W, h: H } = dims();
    if (b.dataset.border) {
      if (b.dataset.border === 'none') editLayer(name, { borderWidth: 0 });
      else editLayer(name, { borderColor: b.dataset.border, borderWidth: l.borderWidth || 5 });
    } else if (b.closest('[data-seg="shape"]')) {
      const shape = b.dataset.v;
      if (shape === l.shape) return;
      if (shape === 'circle') {
        const size = Math.round(Math.min(l.w, l.h));
        editLayer(name, { shape, x: Math.round(l.x + (l.w - size) / 2), y: Math.round(l.y + (l.h - size) / 2), w: size, h: size });
      } else {
        editLayer(name, { shape, radius: l.radius || 24 });
      }
      renderProps();
    } else if (b.dataset.act === 'center') {
      editLayer(name, { x: Math.round((W - l.w) / 2), y: Math.round((H - l.h) / 2) });
    } else if (b.dataset.act === 'fill') {
      editLayer(name, { x: 0, y: 0, w: W, h: H, shape: 'rect', radius: 0, borderWidth: 0 });
      renderProps();
    } else if (b.dataset.act === 'front') {
      beginChange();
      const sc = scene();
      sc.order = [...sc.order.filter((n) => n !== name), name];
      sc.custom = true;
      compositor.setScene(sc);
      commitChange(true);
      renderAll();
    } else if (b.dataset.act === 'deselect') {
      editor.select(null);
    }
  });
}

function setMirror(on) {
  prefs.mirror = on;
  compositor.mirror = on;
  $('#cam-preview').classList.toggle('mirror', on);
  $('#set-mirror').checked = on;
  persist();
  syncProps();
}

function renderBackgrounds() {
  const custom = S.bg.key === 'custom';
  $('#bg-swatches').innerHTML = BACKGROUNDS.map((b) => `
    <button class="swatch ${S.bg.key === b.key ? 'on' : ''}" data-bg="${b.key}" title="${b.name}"
      style="background:linear-gradient(135deg, ${b.colors[0]}, ${b.colors[1]})"></button>`).join('')
    + `<label class="swatch custom ${custom ? 'on' : ''}" title="Cor personalizada" ${custom ? `style="background:${S.bg.color}"` : ''}>
        ${icon('palette', 16)}<input type="color" id="bg-custom" value="${custom ? S.bg.color : '#1e293b'}" />
      </label>`;
}

function renderAll() {
  renderLayoutGrid();
  renderLayers();
  renderProps();
  renderBackgrounds();
  editor.render();
}

// ================================================================== rendering: dock

function renderChips() {
  const set = (id, value, ok) => {
    const chip = $(id);
    chip.querySelector('.chip-value').textContent = value;
    chip.classList.toggle('ok', ok);
    chip.classList.toggle('off', !ok);
    chip.title = value;
  };
  set('#chip-screen', S.screen && feeds.screen ? S.screen.name : 'Nenhuma', !!feeds.screen);
  set('#chip-camera', feeds.camera ? cameraName(S.cameraId) || 'Câmera' : 'Desligada', !!feeds.camera);
  set('#chip-mic', streams.mic ? micName(S.micId) || 'Microfone' : 'Desligado', !!streams.mic);
  $('#btn-record').disabled = !feeds.screen && !feeds.camera;
}

function renderOutput() {
  const d = dims();
  $('#output-spec').textContent = `${d.w}×${d.h} · ${prefs.fps} fps · MP4`;
  const parts = prefs.outDir.split(/[\\/]/).filter(Boolean);
  $('#output-dir').textContent = parts.slice(-2).join(' › ');
  $('#btn-open-dir').title = prefs.outDir;
}

function renderRecMode() {
  $$('#rec-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.recordMode));
}

// ================================================================== sources modal

let srcTab = 'screen';
let srcRefreshTimer = null;

function renderDeviceSelects() {
  const camSel = $('#cam-select');
  const micSel = $('#mic-select');
  camSel.innerHTML = cameras().map((c) => `<option value="${esc(c.deviceId)}">${esc(cleanLabel(c.label) || 'Câmera')}</option>`).join('')
    + '<option value="">Sem câmera</option>';
  micSel.innerHTML = mics().map((m) => `<option value="${esc(m.deviceId)}">${esc(m.deviceId === 'default' ? `${cleanLabel(m.label)} · padrão do Windows` : cleanLabel(m.label) || 'Microfone')}</option>`).join('')
    + '<option value="">Sem microfone</option>';
  camSel.value = S.cameraId || '';
  micSel.value = S.micId || '';
}

function renderCamPreview() {
  const box = $('#cam-preview');
  box.classList.toggle('empty', !S.cameraId || !feeds.camera);
  box.classList.toggle('mirror', prefs.mirror);
}

async function loadSources() {
  try {
    sourceList = await api.listSources();
  } catch (err) {
    toast(`Não foi possível listar as telas. ${friendlyError(err)}`, 'error');
    sourceList = [];
  }
  renderThumbs();
}

function renderThumbs() {
  const list = sourceList.filter((s) => s.type === srcTab);
  const box = $('#thumbs');
  let html = list.map((s) => {
    const isScreen = s.type === 'screen';
    const sub = isScreen ? `${s.width}×${s.height}${s.primary ? ' · principal' : ''}` : '';
    return `
      <button class="thumb" data-src="${esc(s.id)}" title="${esc(s.name)}">
        <span class="t-img" style="background-image:url('${s.thumbnail}')"></span>
        <span class="t-name">
          ${s.icon ? `<img src="${s.icon}" alt="" />` : icon(isScreen ? 'monitor' : 'window', 16)}
          <span>${esc(isScreen ? s.name.replace(/^Screen/i, 'Tela') : s.name)}</span>
          ${sub ? `<span class="t-sub">${sub}</span>` : ''}
        </span>
        <span class="t-check">${icon('check', 14)}</span>
      </button>`;
  }).join('');
  if (srcTab === 'screen') {
    html += `
      <button class="thumb" data-src="">
        <span class="t-img">${icon('cameraOff', 26)}</span>
        <span class="t-name">${icon('x', 16)}<span>Nenhuma (só câmera)</span></span>
        <span class="t-check">${icon('check', 14)}</span>
      </button>`;
  }
  if (!list.length && srcTab === 'window') html = '<div class="thumbs-empty">Nenhuma janela aberta encontrada.</div>';
  box.innerHTML = html;
  renderThumbSelection();
}

function renderThumbSelection() {
  const id = S.screen ? S.screen.id : '';
  $$('#thumbs .thumb').forEach((t) => t.classList.toggle('on', t.dataset.src === id));
}

function renderSourcesHint() {
  const hint = $('#sources-hint');
  const warn = [];
  if (!S.micId) warn.push('Sem microfone: o vídeo ficará sem a sua voz.');
  else if (!S.screen && !S.cameraId) warn.push('Escolha pelo menos uma tela ou uma câmera.');
  hint.classList.toggle('warn', warn.length > 0);
  hint.innerHTML = warn.length
    ? `${icon('alert', 16)} ${warn[0]}`
    : `${icon('info', 16)} Tudo pronto. Ajuste o layout no estúdio e clique em Gravar.`;
}

function openSources() {
  closeModals();
  if (view !== 'studio') setView('studio');
  $('#sources-modal').hidden = false;
  $('#cam-video').srcObject = feeds.camera ? feeds.camera.stream : null;
  renderDeviceSelects();
  renderCamPreview();
  renderSourcesHint();
  renderAreaRow();
  $('#mic-gain').value = Math.round(prefs.micGain * 100);
  $('#mic-gain-val').textContent = `${Math.round(prefs.micGain * 100)}%`;
  setRangeFill($('#mic-gain'));
  $('#noise').checked = prefs.noise;
  $('#sysaudio').checked = prefs.systemAudio;
  loadSources();
  clearInterval(srcRefreshTimer);
  srcRefreshTimer = setInterval(() => { if (!$('#sources-modal').hidden) loadSources(); }, 5000);
}

function closeSources() {
  $('#sources-modal').hidden = true;
  clearInterval(srcRefreshTimer);
  $('#cam-video').srcObject = null;
}

function bindSources() {
  $('#src-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    srcTab = b.dataset.tab;
    $$('#src-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderThumbs();
  });
  $('#btn-refresh-sources').addEventListener('click', loadSources);
  $('#thumbs').addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    const src = sourceList.find((s) => s.id === t.dataset.src) || null;
    setScreen(src).then(renderSourcesHint);
    renderThumbSelection();
  });
  $('#cam-select').addEventListener('change', (e) => setCamera(e.target.value).then(renderSourcesHint));
  $('#mic-select').addEventListener('change', (e) => setMic(e.target.value));
  $('#mic-gain').addEventListener('input', (e) => {
    prefs.micGain = Number(e.target.value) / 100;
    mixer.setMicGain(prefs.micGain);
    $('#mic-gain-val').textContent = `${e.target.value}%`;
    setRangeFill(e.target);
    persist();
  });
  $('#noise').addEventListener('change', (e) => {
    prefs.noise = e.target.checked;
    persist();
    if (S.micId) setMic(S.micId);
  });
  $('#sysaudio').addEventListener('change', (e) => setSystemAudio(e.target.checked));
  $('#sources-done').addEventListener('click', closeSources);
}

// ================================================================== settings modal

const fmtLen = (sec) => (sec < 60 ? `${Math.round(sec * 10) / 10} s`.replace('.', ',') : fmtTime(sec * 1000, false));
const INTRO_KEY = { h: 'intro', v: 'introV', th: 'transition', tv: 'transitionV' };

function renderSettings() {
  $('#set-dir').textContent = prefs.outDir;
  $('#set-quality-note').textContent = QUALITY[prefs.quality].note;
  const segOn = (sel, v) => $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  segOn('#set-quality', prefs.quality);
  segOn('#set-fps', prefs.fps);
  segOn('#set-countdown', prefs.countdown);
  $$('#set-fps button').forEach((b) => { b.disabled = R.state !== 'idle'; });
  $('#set-mirror').checked = prefs.mirror;
  applySync();
  $('#set-editor').checked = prefs.openEditor;
  $('#set-level').checked = prefs.levelAudio;
  $('#set-keep').checked = prefs.keepOriginal;
  $('#intro-enabled').checked = prefs.introEnabled;
  renderIntroSettings();
  renderLogoSettings();
}

function renderIntroSettings() {
  for (const slot of ['h', 'v', 'th', 'tv']) {
    const card = $(`.intro-card[data-slot="${slot}"]`);
    const isTrans = slot.startsWith('t');
    const intro = prefs[INTRO_KEY[slot]];
    const prev = card.querySelector('.intro-preview');
    card.querySelector('[data-intro-act="remove"]').hidden = !intro;
    card.querySelector('.intro-image-dur').hidden = !(intro && intro.isImage);
    card.querySelector('[data-intro-act="pick"]').textContent = intro ? 'Trocar…' : 'Escolher arquivo…';
    card.classList.toggle('has-intro', !!intro);
    if (!intro) {
      prev.dataset.sig = '';
      prev.innerHTML = icon('film', 22);
      card.querySelector('.intro-name').textContent = isTrans ? 'Nenhuma transição definida' : 'Nenhuma intro definida';
      const META = {
        h: 'Usada nos vídeos horizontais.',
        v: prefs.intro ? 'Os vídeos verticais usam a intro horizontal, com faixas nas bordas.' : 'Opcional: uma versão 9:16 para Reels, TikTok e Shorts.',
        th: 'Ex.: um clipe “alguns momentos depois” de até 3 s.',
        tv: prefs.transition ? 'Os vídeos verticais usam a transição horizontal, com faixas nas bordas.' : 'Opcional: uma versão 9:16.',
      };
      card.querySelector('.intro-meta').textContent = META[slot];
      continue;
    }
    if (prev.dataset.sig !== intro.url) {
      prev.dataset.sig = intro.url;
      prev.innerHTML = intro.isImage
        ? `<img src="${esc(intro.url)}" alt="" />`
        : `<video src="${esc(intro.url)}#t=0.5" muted preload="metadata"></video>`;
    }
    card.querySelector('.intro-name').textContent = intro.name;
    card.querySelector('.intro-meta').textContent = intro.isImage
      ? `Imagem · aparece por ${intro.duration} s no começo`
      : `Vídeo · ${fmtLen(intro.duration)}${intro.hasAudio ? ' · com áudio' : ' · sem áudio'}`;
    card.querySelectorAll('.intro-image-dur button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === intro.duration));
  }
}

function setSettingsTab(tab) {
  $$('#set-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.set-pane').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  $('#settings-body').scrollTop = 0;
  if (tab === 'mde') refreshMdeInfo();
}

function openSettings(section) {
  closeModals();
  renderSettings();
  $('#settings-modal').hidden = false;
  const tab = { intro: 'intro', transition: 'intro', mde: 'mde' }[section] || 'rec';
  setSettingsTab(tab);
  if (section === 'transition') $('#set-trans-anchor').scrollIntoView({ block: 'start' });
}

function closeSettings() {
  const m = $('#settings-modal');
  if (m.hidden) return;
  m.hidden = true;
  $$('.intro-preview video').forEach((v) => v.pause());
  if (cutter.isOpen) cutter.refreshIntro();
}

function bindSettings() {
  $('#set-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setSettingsTab(b.dataset.tab);
  });
  $('#set-dir-change').addEventListener('click', async () => {
    const dir = await api.chooseFolder(prefs.outDir);
    if (!dir) return;
    prefs.outDir = dir;
    persist();
    renderSettings();
    renderOutput();
    gallery.markStale();
  });
  $('#set-dir-open').addEventListener('click', openOutDir);
  $('#set-quality').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs.quality = b.dataset.v;
    persist();
    renderSettings();
  });
  $('#set-fps').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || R.state !== 'idle') return;
    prefs.fps = Number(b.dataset.v);
    ticker.setFps(prefs.fps);
    persist();
    renderSettings();
    renderOutput();
    if (S.screen) setScreen(sourceList.find((s) => s.id === S.screen.id) || S.screen);
  });
  $('#set-countdown').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs.countdown = Number(b.dataset.v);
    persist();
    renderSettings();
  });
  $('#set-mirror').addEventListener('change', (e) => setMirror(e.target.checked));
  $('#set-sync-cal').addEventListener('click', openCalibration);
  $('#sync-start').addEventListener('click', runCalibration);
  $('#set-editor').addEventListener('change', (e) => { prefs.openEditor = e.target.checked; persist(); });
  $('#set-level').addEventListener('change', (e) => { prefs.levelAudio = e.target.checked; persist(); });
  $('#set-keep').addEventListener('change', (e) => { prefs.keepOriginal = e.target.checked; persist(); });
  $('#intro-enabled').addEventListener('change', (e) => { prefs.introEnabled = e.target.checked; persist(); });

  $$('.intro-card').forEach((card) => {
    const key = INTRO_KEY[card.dataset.slot];
    card.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-intro-act]')?.dataset.introAct;
      const dur = e.target.closest('.intro-image-dur button');
      if (act === 'pick') {
        try {
          const intro = await api.pickIntro(card.dataset.slot);
          if (!intro) return;
          prefs[key] = intro;
          persist();
          renderIntroSettings();
          if (key.startsWith('transition') && intro.duration >= 3 && !intro.isImage) {
            toast('O vídeo de transição será usado com no máximo 3 s.');
          } else if (!key.startsWith('transition') && !intro.isImage && intro.duration > 20) {
            toast(`A intro tem ${fmtLen(intro.duration)}. Intros de até 10 s costumam funcionar melhor.`);
          }
        } catch (err) {
          toast(`Não foi possível usar esse arquivo. ${cleanError(err)}`, 'error');
        }
      } else if (act === 'remove') {
        prefs[key] = null;
        persist();
        renderIntroSettings();
      } else if (dur && prefs[key]) {
        prefs[key] = { ...prefs[key], duration: Number(dur.dataset.v) };
        persist();
        renderIntroSettings();
      }
    });
  });
}

async function openOutDir() {
  const res = await api.openPath(prefs.outDir);
  if (res) toast('A pasta ainda não existe. Ela será criada na primeira gravação.');
}

// ================================================================== modals / toasts / confirm

function closeModals() {
  if (!$('#sync-modal').hidden) closeCalibration();
  if (!$('#sources-modal').hidden) closeSources();
  closeSettings();
  closeResult();
}

function closeResult() {
  const modal = $('#result-modal');
  if (modal.hidden) return;
  modal.hidden = true;
  const v = $('#result-video');
  v.pause();
  v.removeAttribute('src'); // release the file so it can be moved or renamed
  v.load();
}

function bindModals() {
  $$('.backdrop').forEach((bd) => {
    if (bd.id === 'confirm-modal') return; // handled by confirmBox
    bd.addEventListener('pointerdown', (e) => {
      if (e.target === bd) bd.dataset.downOnBackdrop = '1';
    });
    bd.addEventListener('click', (e) => {
      const onBackdrop = e.target === bd && bd.dataset.downOnBackdrop === '1';
      delete bd.dataset.downOnBackdrop;
      if (onBackdrop || e.target.closest('[data-close]')) {
        if (bd.id === 'sources-modal') closeSources();
        else if (bd.id === 'result-modal') closeResult();
        else if (bd.id === 'settings-modal') closeSettings();
        else if (bd.id === 'sync-modal') closeCalibration();
        else bd.hidden = true;
      }
    });
  });
}

function confirmBox({ title, text, ok = 'OK', cancel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    const m = $('#confirm-modal');
    const okB = $('#confirm-ok');
    const cancelB = $('#confirm-cancel');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    okB.textContent = ok;
    cancelB.textContent = cancel;
    okB.classList.toggle('danger', danger);
    m.hidden = false;
    okB.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(e.key === 'Enter');
      }
    };
    function done(value) {
      m.hidden = true;
      okB.onclick = null;
      cancelB.onclick = null;
      m.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    }
    okB.onclick = () => done(true);
    cancelB.onclick = () => done(false);
    m.onclick = (e) => { if (e.target === m) done(false); };
    document.addEventListener('keydown', onKey, true);
  });
}

function toast(message, type = 'info', ms = 4500, action = null) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert' : type === 'ok' ? 'check' : 'info', 16)}<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { action.onClick(); el.remove(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

const cleanError = (err) => String((err && err.message) || err || '')
  .replace(/^Error invoking remote method '[^']+': /, '')
  .replace(/^Error: /, '');

// ================================================================== recording

const R = {
  state: 'idle', // idle | arming | countdown | recording | paused | finishing
  recorders: {}, // main / camera / screen
  clones: [],
  mime: '',
  chains: {},
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  stereo: false,
  orientation: 'h',
};

function pickMime(fps) {
  const level = fps > 30 ? '64002a' : '640028';
  const candidates = [
    `video/mp4;codecs=avc1.${level},mp4a.40.2`,
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/x-matroska;codecs=avc1,opus',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function elapsed() {
  if (!R.startedAt) return 0;
  const now = performance.now();
  return now - R.startedAt - R.pausedTotal - (R.state === 'paused' ? now - R.pausedAt : 0);
}

function fmtTime(ms, long = true) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (long) return `${p(h)}:${p(m)}:${p(sec)}`;
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2).replace('.', ',')} GB`;
  return `${Math.max(0.1, bytes / 1e6).toFixed(1).replace('.', ',')} MB`;
}

const pctOf = (v, total) => Math.round((v / total) * 1000) / 10;
const barLayouts = () => {
  const { w: W, h: H } = dims();
  return layouts().map((sc) => ({
    name: sc.name,
    rects: sc.order.filter((k) => sc[k].visible).map((k) => ({
      k, x: pctOf(sc[k].x, W), y: pctOf(sc[k].y, H), w: pctOf(sc[k].w, W), h: pctOf(sc[k].h, H), circle: sc[k].shape === 'circle',
    })),
  }));
};

const busyElsewhere = () => cutter.isOpen || !$('#export-overlay').hidden;

function makeRecorder(key, stream, mime) {
  const mult = prefs.fps > 30 ? 1.5 : 1;
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: Math.round(RAW_BPS[key] * mult),
    audioBitsPerSecond: 192000,
    videoKeyFrameIntervalDuration: 2000,
  });
  R.chains[key] = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const blob = e.data;
    R.chains[key] = R.chains[key]
      .then(async () => api.rec.chunk(key, await blob.arrayBuffer()))
      .catch((err) => toast(`Erro ao salvar a gravação: ${err.message}`, 'error'));
  };
  if (key === 'main') {
    recorder.onerror = (e) => {
      toast(`Erro na gravação: ${(e.error && e.error.message) || 'desconhecido'}`, 'error');
      stopRecording();
    };
  }
  return recorder;
}

async function startRecording() {
  if (R.state !== 'idle') return;
  if (busyElsewhere()) {
    toast('Termine a edição ou a exportação antes de gravar de novo.');
    return;
  }
  if (captureSuspended) {
    setView('studio');
    await resumeCapture();
  }
  if (!feeds.screen && !feeds.camera) {
    toast('Escolha uma tela ou uma câmera antes de gravar.', 'error');
    openSources();
    return;
  }
  const mime = pickMime(prefs.fps);
  if (!mime) {
    toast('Este computador não suporta gravação de vídeo.', 'error');
    return;
  }
  closeModals();
  closeLayoutMenu();
  if (view !== 'studio') setView('studio');
  editor.select(null);
  R.state = 'arming';
  setRecUI();
  const tracks = prefs.recordMode === 'all'
    ? ['camera', 'screen'].filter((k) => feeds[k] && feeds[k].track.readyState === 'live')
    : [];
  const ext = mime.startsWith('video/mp4') ? '.mp4' : mime.includes('matroska') ? '.mkv' : '.webm';
  try {
    R.file = await api.rec.prepare({ outDir: prefs.outDir, ext, tracks });
  } catch (err) {
    R.state = 'idle';
    setRecUI();
    toast(`Não foi possível criar a pasta da gravação. ${cleanError(err)}`, 'error');
    return;
  }

  if (R.file.freeGB != null) {
    const mbps = 10 + (tracks.includes('camera') ? 8 : 0) + (tracks.includes('screen') ? 12 : 0);
    const hours = R.file.freeGB / (mbps * 0.45);
    if (hours < 2) toast(`Atenção: ${R.file.freeGB.toFixed(1).replace('.', ',')} GB livres, dá para cerca de ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1).replace('.', ',')} h`} de gravação.`, 'error', 9000);
  }
  R.micQuiet = 0;
  R.micWarn = false;
  mixer.resume();
  R.mime = mime;
  R.orientation = S.orientation;
  R.stereo = !!(prefs.systemAudio && streams.sys);
  R.syncMs = cameraDelay();
  mixer.setDelay(R.syncMs);
  R.startedAt = 0;
  R.recorders = {};
  R.clones = [];
  const videoTrack = compositor.startOutput(prefs.fps);
  R.recorders.main = makeRecorder('main', new MediaStream([videoTrack, mixer.track]), mime);
  // Separate files: the raw camera and screen, each with the same audio mix.
  for (const key of tracks) {
    const clone = feeds[key].track.clone();
    R.clones.push(clone);
    R.recorders[key] = makeRecorder(key, new MediaStream([clone, mixer.track]), mime);
  }

  R.state = 'countdown';
  setRecUI();
  await api.ui.startCountdown({ seconds: prefs.countdown, layouts: barLayouts(), active: activeIndex(), orientation: S.orientation });
}

function beginRecording() {
  if (R.state !== 'countdown' || !R.recorders.main) return;
  for (const r of Object.values(R.recorders)) r.start(1000);
  R.startedAt = performance.now();
  R.pausedTotal = 0;
  R.pausedAt = 0;
  R.state = 'recording';
  setRecUI();
  api.ui.recordingStarted({ layouts: barLayouts(), active: activeIndex(), orientation: S.orientation });
  sendBarStatus();
}

function releaseRecorders() {
  R.clones.forEach((t) => t.stop());
  R.clones = [];
  R.recorders = {};
  compositor.stopOutput();
}

async function cancelCountdown() {
  if (R.state !== 'countdown') return;
  releaseRecorders();
  R.state = 'idle';
  setRecUI();
  await api.rec.discard();
  await api.ui.recordingEnded();
  await api.ui.finalized();
}

function togglePause() {
  const recs = Object.values(R.recorders);
  if (!recs.length) return;
  if (R.state === 'recording') {
    recs.forEach((r) => { if (r.state === 'recording') r.pause(); });
    R.pausedAt = performance.now();
    R.state = 'paused';
  } else if (R.state === 'paused') {
    recs.forEach((r) => { if (r.state === 'paused') r.resume(); });
    R.pausedTotal += performance.now() - R.pausedAt;
    R.state = 'recording';
  } else {
    return;
  }
  setRecUI();
  sendBarStatus();
}

async function stopRecording({ discard = false } = {}) {
  if (R.state !== 'recording' && R.state !== 'paused') return;
  const recs = Object.values(R.recorders);
  const duration = elapsed();
  R.state = 'finishing';
  setRecUI();
  if (!discard) showBusy(true, 'Preparando o editor…');
  await api.ui.recordingEnded();

  await Promise.all(recs.map((r) => new Promise((res) => {
    if (r.state === 'inactive') { res(); return; }
    r.addEventListener('stop', res, { once: true });
    try { r.stop(); } catch { res(); }
  })));
  await Promise.all(Object.values(R.chains));
  releaseRecorders();

  let project = null;
  try {
    if (discard) {
      await api.rec.discard();
      toast('Gravação descartada.');
    } else {
      const d = DIMS[R.orientation];
      const res = await api.rec.finish({
        mime: R.mime,
        meta: { orientation: R.orientation, width: d.w, height: d.h, fps: prefs.fps, stereo: R.stereo, screenCrop: activeCrop(), syncMs: R.syncMs },
      });
      if (res.warning) toast(res.warning, 'error', 9000);
      project = {
        ...res,
        original: true,
        stereo: R.stereo,
        orientation: R.orientation,
        width: d.w,
        height: d.h,
        duration: res.duration || duration / 1000,
        removed: [],
        audioDelay: 0, // already in sync: the voice was delayed while recording
        introApplied: false,
      };
      gallery.markStale();
    }
  } catch (err) {
    toast(`Não foi possível salvar o vídeo. ${cleanError(err)}`, 'error', 8000);
  } finally {
    showBusy(false);
    R.startedAt = 0;
    R.state = 'idle';
    setRecUI();
    api.ui.finalized();
  }
  if (project) openProject(project);
}

function openProject(project) {
  closeModals();
  if (prefs.openEditor) cutter.open(project);
  else exportProject(project, { seq: null, removed: [], inserts: [], audioDelay: project.audioDelay ?? prefs.audioDelay, intro: prefs.introEnabled ? introFor(project.orientation) : null });
}

function setRecUI() {
  const app = $('#app');
  const live = R.state === 'recording' || R.state === 'paused' || R.state === 'finishing';
  app.classList.toggle('is-recording', live);
  app.classList.toggle('is-paused', R.state === 'paused');
  const pause = $('#btn-pause');
  pause.innerHTML = icon(R.state === 'paused' ? 'play' : 'pause', 16);
  pause.title = R.state === 'paused' ? 'Continuar (Alt+Shift+P)' : 'Pausar (Alt+Shift+P)';
  const btn = $('#btn-record');
  btn.querySelector('.rec-label').textContent = R.state === 'countdown' || R.state === 'arming' ? 'Preparando…' : 'Gravar';
  $('#btn-open-video').disabled = R.state !== 'idle';
  $$('#rec-mode button').forEach((b) => { b.disabled = R.state !== 'idle'; });
  renderOrientation();
  renderSettings();
}

function sendBarStatus() {
  if (R.state !== 'recording' && R.state !== 'paused') return;
  api.rec.status({
    state: R.state,
    elapsed: elapsed(),
    level: mixer.smoothed || 0,
    active: activeIndex(),
    layouts: barLayouts(),
    orientation: S.orientation,
    micOn: !!streams.mic,
    micWarn: !!R.micWarn,
  });
}

function showBusy(on, title = 'Finalizando seu vídeo…') {
  $('#busy').hidden = !on;
  $('#busy-title').textContent = title;
}

// ================================================================== export

const EXP = { start: 0, intro: false, tracks: 0 };
const PHASE_LABEL = {
  audio: () => 'Analisando e nivelando o áudio…',
  video: () => `Cortando${EXP.intro ? ', adicionando a intro' : ''} e comprimindo o vídeo final…`,
  camera: () => 'Comprimindo o arquivo da câmera…',
  screen: () => 'Comprimindo o arquivo da tela…',
};

async function exportProject(project, { seq, removed, inserts, audioDelay, intro, transition, title }) {
  EXP.start = 0;
  EXP.intro = !!intro;
  EXP.tracks = (project.tracks || []).length;
  $('#exp-title').textContent = EXP.tracks ? `Exportando ${EXP.tracks + 1} arquivos…` : 'Exportando o vídeo…';
  setExportProgress({ phase: prefs.levelAudio && project.hasAudio !== false ? 'audio' : 'video', pct: 0, overall: 0 });
  $('#export-overlay').hidden = false;
  try {
    const res = await api.exporter.run({
      folder: project.folder || null,
      source: project.path,
      output: project.finalPath,
      tracks: project.tracks || [],
      duration: project.duration,
      width: project.width,
      height: project.height,
      seq: seq || null,
      removed: removed || [],
      screenCrop: project.screenCrop || null,
      inserts: inserts || [],
      audioDelay: Number.isFinite(audioDelay) ? audioDelay : prefs.audioDelay,
      intro,
      transition: transition || null,
      introApplied: !!project.introApplied,
      fps: prefs.fps,
      crf: QUALITY[prefs.quality].crf,
      stereo: project.stereo,
      level: prefs.levelAudio,
      hasAudio: project.hasAudio !== false,
      trashOriginals: project.original && !prefs.keepOriginal,
    });
    if (cutter.isOpen) cutter.close();
    // The title typed in the editor names the lesson folder/files and the MDE lesson.
    let folder = project.folder || null;
    let lessonTitle = (title || project.title || '').trim();
    if (folder && lessonTitle && lessonTitle !== project.title) {
      try {
        const it = await api.gallery.rename({ kind: 'project', folder, main: res.path }, lessonTitle);
        folder = it.folder;
        res.path = it.main;
        res.url = it.mainUrl;
        lessonTitle = it.title;
      } catch (err) {
        toast(`O vídeo foi exportado, mas não consegui renomear a aula. ${cleanError(err)}`, 'error', 7000);
      }
    }
    gallery.markStale();
    let mdeStarted = false;
    if (folder && prefs.mdeAuto && mdeInfo.hasKey) mdeStarted = !!(await sendToMde(folder, res.path, lessonTitle || project.title));
    showResult(res, project, { folder, title: lessonTitle || project.title, mdeStarted });
    return true;
  } catch (err) {
    const msg = cleanError(err);
    if (/cancelled/.test(msg)) {
      toast('Exportação cancelada. Nada foi perdido.');
    } else {
      toast(`Não foi possível exportar o vídeo. ${msg.slice(0, 400)}`, 'error', 15000);
      if (!cutter.isOpen) cutter.open(project);
    }
    return false;
  } finally {
    $('#export-overlay').hidden = true;
  }
}

function setExportProgress({ phase, overall = 0 }) {
  $('#exp-fill').style.width = `${(overall * 100).toFixed(1)}%`;
  $('#exp-pct').textContent = `${Math.floor(overall * 100)}%`;
  $('#exp-phase').textContent = (PHASE_LABEL[phase] || PHASE_LABEL.video)();
  const now = performance.now();
  if (!EXP.start) EXP.start = now;
  let eta = '';
  if (overall > 0.04) {
    const left = ((now - EXP.start) * (1 - overall)) / overall / 1000;
    eta = left > 90 ? `faltam ~${Math.round(left / 60)} min` : `faltam ~${Math.max(1, Math.round(left))} s`;
  }
  $('#exp-eta').textContent = eta;
}

function openResultModal({ title, meta, notes, url, path, onEdit, primary, mde = null }) {
  closeModals();
  $('#result-title').textContent = title;
  $('#result-name').textContent = path.split(/[\\/]/).pop();
  $('#result-name').title = path;
  $('#result-meta').textContent = meta;
  const warn = $('#result-warning');
  warn.hidden = !notes;
  warn.textContent = notes || '';
  const v = $('#result-video');
  v.src = url;
  $('#result-folder').onclick = () => api.showItem(path);
  $('#result-open').onclick = () => { v.pause(); api.openPath(path); };
  const edit = $('#result-edit');
  edit.hidden = !onEdit;
  edit.onclick = onEdit ? () => { closeResult(); onEdit(); } : null;
  $('#result-close').textContent = primary;
  const mdeBtn = $('#result-mde');
  mdeBtn.hidden = !mde;
  mdeBtn.onclick = mde ? async () => {
    mdeBtn.disabled = true;
    const st = await sendToMde(mde.folder, mde.file, mde.title);
    mdeBtn.disabled = false;
    if (st) mdeBtn.hidden = true;
  } : null;
  $('#result-modal').hidden = false;
}

function showResult(res, project, lesson = {}) {
  const parts = [fmtTime(res.duration * 1000, false), fmtSize(res.size)];
  if (project && project.size) {
    const rawTotal = project.size;
    const mainSize = res.size - (res.tracks || []).reduce((a, t) => a + t.size, 0);
    if (rawTotal > mainSize) parts.push(`${Math.round((1 - mainSize / rawTotal) * 100)}% menor que a gravação bruta`);
  }
  const notes = [];
  if (res.tracks && res.tracks.length) notes.push(`Também salvos: ${res.tracks.map((t) => (t.key === 'camera' ? 'câmera' : 'tela')).join(' e ')} separadas, com os mesmos cortes e áudio.`);
  if (res.sourceTrashed) notes.push('A gravação bruta foi para a Lixeira (dá para recuperar de lá).');
  if (lesson.mdeStarted) notes.push('Enviando para a Comunidade MDE: acompanhe na barra do topo ou na Galeria.');
  openResultModal({
    mde: lesson.folder && !lesson.mdeStarted ? { folder: lesson.folder, file: res.path, title: lesson.title } : null,
    title: 'Vídeo pronto',
    meta: parts.join(' · '),
    notes: notes.join(' '),
    url: res.url,
    path: res.path,
    primary: 'Nova gravação',
  });
}

function showWatch(item) {
  const d = new Date(item.createdAt);
  const when = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const parts = [fmtTime(item.duration * 1000, false), fmtSize(item.size), when].filter(Boolean);
  openResultModal({
    title: item.title,
    meta: parts.join(' · '),
    notes: item.status === 'draft' ? 'Rascunho: esta gravação ainda não foi exportada. Clique em Editar para cortar e exportar.' : '',
    url: item.mainUrl,
    path: item.main,
    onEdit: () => editItem(item),
    primary: 'Fechar',
  });
}

function editItem(item) {
  if (R.state !== 'idle' || busyElsewhere()) {
    toast('Termine a gravação ou a exportação atual primeiro.');
    return;
  }
  const e = item.edit;
  closeModals();
  cutter.open({
    folder: item.kind === 'project' ? item.folder : null,
    title: item.title,
    path: e.source,
    url: e.url,
    size: item.size,
    finalPath: e.finalPath,
    original: e.original,
    editingFinal: e.editingFinal,
    introApplied: e.introApplied,
    removed: e.removed,
    screenCrop: e.screenCrop || null,
    inserts: e.inserts || [],
    audioDelay: Number.isFinite(e.audioDelay) ? e.audioDelay : undefined,
    tracks: e.tracks,
    stereo: item.stereo,
    hasAudio: item.hasAudio,
    orientation: item.orientation,
    width: item.width,
    height: item.height,
    duration: e.duration,
  });
}

async function openVideoFile() {
  if (R.state !== 'idle' || busyElsewhere()) return;
  try {
    const v = await api.openVideo(prefs.outDir);
    if (!v) return;
    closeModals();
    cutter.open({
      path: v.path,
      url: v.url,
      size: v.size,
      finalPath: v.finalPath,
      original: / \(original\)\.mp4$/i.test(v.path),
      stereo: true,
      hasAudio: v.hasAudio,
      duration: v.duration,
      width: v.width,
      height: v.height,
      orientation: v.height > v.width ? 'v' : 'h',
      tracks: [],
      removed: [],
    });
  } catch (err) {
    toast(`Não foi possível abrir esse vídeo. ${cleanError(err)}`, 'error');
  }
}

// ================================================================== render loop

let tickCount = 0;
let lastStatus = 0;
const miniMeter = $('#chip-mic .mini-meter span');
const modalMeter = $('#mic-meter .fill');

const ticker = createTicker((now) => {
  const recordingNow = R.state === 'recording' || R.state === 'paused';
  // While editing, exporting or browsing nothing is being recorded: leave the CPU to them.
  if ((busyElsewhere() || gallery.isOpen) && !recordingNow) return;
  compositor.draw(now);
  if (R.state === 'recording') compositor.pushFrame();

  tickCount += 1;
  if (tickCount % 2 === 0) {
    const lvl = mixer.level();
    const pctLvl = `${Math.round(lvl * 100)}%`;
    miniMeter.style.height = pctLvl;
    if (!$('#sources-modal').hidden) modalMeter.style.width = pctLvl;
  }
  if (recordingNow && now - lastStatus > 100) {
    // A mic that stays silent for 8 s probably is the wrong one (or muted).
    if (streams.mic && R.state === 'recording') {
      R.micQuiet = (mixer.smoothed || 0) < 0.06 ? R.micQuiet + (now - lastStatus) : 0;
      const warn = R.micQuiet > 8000;
      if (warn && !R.micWarn) toast('Não estou captando som no microfone. Confira o microfone escolhido e o volume.', 'error', 9000);
      R.micWarn = warn;
    }
    lastStatus = now;
    sendBarStatus();
    const t = elapsed();
    $('#rec-time').textContent = fmtTime(t);
    $('#live-time').textContent = R.state === 'paused' ? `Pausado · ${fmtTime(t, false)}` : fmtTime(t, false);
  }
});
ticker.setFps(prefs.fps);

// ================================================================== stage sizing

function fitStage() {
  const area = $('#stage-area');
  const hint = $('#stage-hint');
  const cs = getComputedStyle(area);
  const availW = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - hint.offsetHeight - 14;
  const d = dims();
  const ratio = d.h / d.w;
  let w = availW;
  let h = w * ratio;
  if (h > availH) {
    h = availH;
    w = h / ratio;
  }
  const stage = $('#stage');
  stage.style.width = `${Math.max(120, Math.floor(w))}px`;
  stage.style.height = `${Math.max(120, Math.floor(h))}px`;
}
new ResizeObserver(fitStage).observe($('#stage-area'));

// ================================================================== events

function bindStudio() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  $('#orient-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-o]');
    if (b) setOrientation(b.dataset.o);
  });
  $('#rec-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b || R.state !== 'idle') return;
    prefs.recordMode = b.dataset.v;
    persist();
    renderRecMode();
    if (prefs.recordMode === 'all') toast('Além do vídeo final, a câmera e a tela serão salvas em arquivos separados, cada um com o áudio.', 'info', 5000);
  });

  const grid = $('#layout-grid');
  grid.addEventListener('click', (e) => {
    if (e.target.closest('.lname-input')) return;
    const more = e.target.closest('[data-menu]');
    if (more) {
      e.stopPropagation();
      openLayoutMenu(more.dataset.menu, more);
      return;
    }
    if (e.target.closest('[data-add]')) {
      addLayout();
      return;
    }
    const card = e.target.closest('[data-layout]');
    if (card) {
      closeLayoutMenu();
      setActiveLayout(card.dataset.layout);
    }
  });
  grid.addEventListener('dblclick', (e) => {
    const name = e.target.closest('[data-rename]');
    if (name) startRename(name.dataset.rename);
  });
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-layout]');
    if (!card) return;
    e.preventDefault();
    openLayoutMenu(card.dataset.layout, card.querySelector('[data-menu]'));
  });
  $('#btn-reset-layout').addEventListener('click', () => resetLayout(S.active[S.orientation]));
  $('#layout-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu-act]');
    if (!b || !menuFor) return;
    const id = menuFor;
    const act = b.dataset.menuAct;
    closeLayoutMenu();
    if (act === 'rename') startRename(id);
    else if (act === 'duplicate') duplicateLayout(id);
    else if (act === 'reset') resetLayout(id);
    else if (act === 'delete') deleteLayout(id);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#layout-menu, [data-menu]')) closeLayoutMenu();
  });
  $('#inspector').addEventListener('scroll', closeLayoutMenu);

  $('#layers').addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      const name = eye.dataset.eye;
      editLayer(name, { visible: !scene()[name].visible });
      if (!scene()[name].visible && editor.selected === name) editor.select(null);
      renderLayers();
      return;
    }
    const row = e.target.closest('[data-layer]');
    if (row) {
      const name = row.dataset.layer;
      if (!scene()[name].visible) editLayer(name, { visible: true });
      editor.select(editor.selected === name ? null : name);
    }
  });

  $('#bg-swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bg]');
    if (!b) return;
    beginChange();
    S.bg = { key: b.dataset.bg };
    applyBackground();
    commitChange(true);
    renderBackgrounds();
  });
  $('#bg-swatches').addEventListener('input', (e) => {
    if (e.target.id !== 'bg-custom') return;
    beginChange();
    S.bg = { key: 'custom', color: e.target.value };
    applyBackground();
    const label = e.target.closest('.swatch');
    label.style.background = e.target.value;
    $$('#bg-swatches .swatch').forEach((s) => s.classList.toggle('on', s === label));
  });
  $('#bg-swatches').addEventListener('change', (e) => {
    if (e.target.id === 'bg-custom') commitChange(true);
  });

  $$('.chip').forEach((c) => c.addEventListener('click', openSources));
  $('#btn-sources').addEventListener('click', openSources);
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-open-video').addEventListener('click', openVideoFile);
  $('#btn-open-dir').addEventListener('click', openOutDir);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);

  $('#btn-record').addEventListener('click', startRecording);
  $('#btn-stop').addEventListener('click', () => stopRecording());
  $('#btn-pause').addEventListener('click', togglePause);
  $('#exp-cancel').addEventListener('click', () => api.exporter.cancel());

  document.addEventListener('keydown', (e) => {
    if (cutter.isOpen) return; // the editor has its own shortcuts
    const typing = e.target.matches('input[type=text], input[type=number], select, textarea');
    const modalOpen = $$('.backdrop').some((b) => !b.hidden);
    if (e.key === 'Escape') {
      if (modalOpen) closeModals();
      else if (!$('#layout-menu').hidden) closeLayoutMenu();
      else editor.select(null);
      return;
    }
    if (typing || modalOpen || gallery.isOpen) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (!e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const l = layouts()[Number(e.key) - 1];
      if (l) setActiveLayout(l.id);
      return;
    }
    const name = editor.selected;
    if (name && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const l = scene()[name];
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      editLayer(name, { x: l.x + dx, y: l.y + dy });
    }
  });

  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
}

function bindRecordingEvents() {
  api.rec.onGo(beginRecording);
  api.rec.onCancel(cancelCountdown);
  api.rec.onError((msg) => toast(`Erro ao gravar no disco: ${msg}`, 'error', 8000));
  api.exporter.onProgress(setExportProgress);

  api.ui.onHotkey((name) => {
    if (name === 'record') {
      if (R.state === 'idle') startRecording();
      else if (R.state === 'countdown') cancelCountdown();
      else stopRecording();
    } else if (name === 'stop') {
      stopRecording();
    } else if (name === 'pause') {
      togglePause();
    } else if (name.startsWith('layout:')) {
      const l = layouts()[Number(name.split(':')[1])];
      if (l) setActiveLayout(l.id);
    }
  });

  api.ui.onBarAction((a) => {
    if (a.type === 'pause' || a.type === 'resume') togglePause();
    else if (a.type === 'stop') stopRecording();
    else if (a.type === 'discard') stopRecording({ discard: true });
    else if (a.type === 'layout') {
      const l = layouts()[a.index];
      if (l) setActiveLayout(l.id);
    }
  });
}

// ================================================================== boot

{
  const d = dims();
  compositor.setSize(d.w, d.h);
  editor.setDims(d.w, d.h);
}
applyBackground();
compositor.setScene(scene());
bindProps();
bindSources();
bindSettings();
bindModals();
bindStudio();
bindRecordingEvents();
renderAll();
renderOrientation();
renderRecMode();
renderOutput();
renderSettings();
updateUndoButtons();
setRecUI();
fitStage();

await refreshDevices();
openSources();
const initialScreen = matchSavedScreen(await api.listSources().then((l) => (sourceList = l)).catch(() => []));
await Promise.all([
  setScreen(initialScreen),
  setCamera(pickInitialCamera()),
  setMic(pickInitialMic()),
]);
if (prefs.systemAudio) setSystemAudio(true);
renderDeviceSelects();
renderThumbs();
renderSourcesHint();
renderChips();
persist();
bindMde();
refreshMdeInfo();
bindExtras();
applyLogo();
renderAreaRow();

window.__app = {
  S, R, prefs, compositor, mixer, feeds, cutter, gallery, startRecording, stopRecording, togglePause, setActiveLayout, setOrientation, setView, exportProject,
};
