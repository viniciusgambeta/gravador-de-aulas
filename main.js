const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell,
  globalShortcut, session, safeStorage, powerSaveBlocker,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { Mde, publicState } = require('./mde');

const MDE_DEFAULT_URL = 'https://wzdnpbinsxcbdosyaksz.supabase.co/functions/v1/lesson-upload-api';

app.setAppUserModelId('com.agenciadebolso.gravadordeaulas');
// The level meters and the audio mix must run before the user clicks anything.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Chromium's "window is covered" detection sometimes misfires (multi-monitor,
// overlay windows) and drops the editor preview to ~1 fps.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const ICON = path.join(__dirname, 'build', 'icon.png');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

let mainWin = null;
let barWin = null;
let recording = false;     // true from the countdown until the file is finalized
let quitAfterFinish = false;

// ---------------------------------------------------------------- settings

let settingsCache = null;
let settingsTimer = null;

function readSettings() {
  if (settingsCache) return settingsCache;
  try {
    settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

function writeSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    fsp.writeFile(SETTINGS_FILE(), JSON.stringify(settingsCache, null, 2)).catch(() => {});
  }, 300);
}

function defaultOutDir() {
  return path.join(app.getPath('videos'), 'Gravador de Aulas');
}

// ---------------------------------------------------------------- windows

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0c0d11',
    title: 'Gravador de Aulas',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d11', symbolColor: '#a9afbd', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  // Keep the studio itself out of the recording (and out of its own preview).
  mainWin.setContentProtection(true);
  mainWin.removeMenu();
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => {
    mainWin.maximize();
    mainWin.show();
  });

  mainWin.on('close', (e) => {
    if (!recording) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'warning',
      buttons: ['Parar e salvar', 'Continuar gravando'],
      defaultId: 0,
      cancelId: 1,
      title: 'Gravação em andamento',
      message: 'Uma gravação está em andamento.',
      detail: 'Deseja parar e salvar o vídeo antes de sair?',
    });
    if (choice === 0) {
      quitAfterFinish = true;
      sendMain('hotkey', 'stop');
    }
  });

  mainWin.on('closed', () => {
    mainWin = null;
    if (scriptWin && !scriptWin.isDestroyed()) scriptWin.destroy();
    if (keepAwakeId != null) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = null; }
    if (barWin && !barWin.isDestroyed()) barWin.destroy();
  });
}

function sendMain(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function sendBar(channel, payload) {
  if (barWin && !barWin.isDestroyed()) barWin.webContents.send(channel, payload);
}

function activeDisplay() {
  if (mainWin && !mainWin.isDestroyed()) {
    return screen.getDisplayMatching(mainWin.getBounds());
  }
  return screen.getPrimaryDisplay();
}

const BAR_SIZE = { width: 820, height: 96 };
const COUNTDOWN_SIZE = { width: 300, height: 300 };

function ensureBarWindow() {
  if (barWin && !barWin.isDestroyed()) return barWin;
  barWin = new BrowserWindow({
    ...COUNTDOWN_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  barWin.setAlwaysOnTop(true, 'screen-saver');
  barWin.setContentProtection(true);
  barWin.loadFile(path.join(__dirname, 'src', 'toolbar.html'));
  barWin.on('closed', () => { barWin = null; });
  return barWin;
}

function placeBar(mode) {
  const wa = activeDisplay().workArea;
  if (mode === 'countdown') {
    barWin.setBounds({
      x: Math.round(wa.x + (wa.width - COUNTDOWN_SIZE.width) / 2),
      y: Math.round(wa.y + (wa.height - COUNTDOWN_SIZE.height) / 2),
      ...COUNTDOWN_SIZE,
    });
  } else {
    barWin.setBounds({
      x: Math.round(wa.x + (wa.width - BAR_SIZE.width) / 2),
      y: Math.round(wa.y + wa.height - BAR_SIZE.height - 16),
      ...BAR_SIZE,
    });
  }
}

async function showBar(mode, payload) {
  const win = ensureBarWindow();
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  placeBar(mode);
  sendBar('bar:mode', { mode, ...payload });
  win.showInactive();
}

function hideBar() {
  if (barWin && !barWin.isDestroyed()) barWin.hide();
}

// ---------------------------------------------------------------- shortcuts

const SHORTCUTS = [
  ['Alt+Shift+R', 'record'],
  ['Alt+Shift+P', 'pause'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`Alt+Shift+${n}`, `layout:${n - 1}`]),
];

function registerShortcuts() {
  for (const [accel, name] of SHORTCUTS) {
    try {
      globalShortcut.register(accel, () => sendMain('hotkey', name));
    } catch { /* another app owns it; the in-app buttons still work */ }
  }
}

// ---------------------------------------------------------------- recording files

let rec = null; // { tempPath, finalPath, stream, writing }

function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Aula ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  return 'ffmpeg';
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `ffmpeg saiu com código ${code}`))));
  });
}

function closeStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.closed) return resolve();
    stream.end(resolve);
  });
}

// ---------------------------------------------------------------- media + export

const createdFiles = new Set();
let exportProc = null;
let exportCancelled = false;

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;

function probe(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => resolve({ duration: 0, hasAudio: false, hasVideo: false }));
    proc.on('close', () => {
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      const v = /Stream #\d+:\d+[^\n]*: Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(err);
      resolve({
        duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
        hasVideo: !!v,
        hasAudio: /Stream #\d+:\d+[^\n]*: Audio:/.test(err),
        width: v ? Number(v[1]) : 0,
        height: v ? Number(v[2]) : 0,
        isImage: IMAGE_EXT.test(file),
      });
    });
  });
}

// RMS of the audio every 20 ms (mono, 8 kHz), for the editor's waveform and
// pause detection.
function waveform(file) {
  return new Promise((resolve, reject) => {
    const BIN = 320; // 20 ms at 16 kHz: high enough to "hear" sibilants like a final "s"
    const proc = spawn(ffmpegPath(), ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    const out = [];
    let acc = 0;
    let n = 0;
    let rest = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      for (let i = 0; i < usable; i += 4) {
        const v = buf.readFloatLE(i);
        acc += v * v;
        n += 1;
        if (n === BIN) {
          out.push(Math.sqrt(acc / BIN));
          acc = 0;
          n = 0;
        }
      }
      rest = buf.subarray(usable);
    });
    proc.on('error', reject);
    proc.on('close', () => {
      if (n) out.push(Math.sqrt(acc / n));
      resolve(new Float32Array(out).buffer);
    });
  });
}

// Lip-sync calibration. The person claps a few times in front of the camera:
// each clap is a sharp click in the audio and, on video, the frame where the
// hands meet (the motion stops at once). The median gap between the two is
// the camera's delay exactly as it ends up in a recorded file.
async function measureSync(file) {
  const W = 64;
  const H = 36;
  const SR = 8000;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gravador-sync-'));
  const aFile = path.join(dir, 'a.f32');
  const vFile = path.join(dir, 'v.gray');
  try {
    // Both outputs share the file's timeline: the audio is padded to start at 0,
    // and showinfo prints each frame's time on that same clock.
    const log = await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath(), ['-hide_banner', '-y', '-i', file,
        '-map', '0:a:0', '-af', `aresample=${SR}:async=1:first_pts=0`, '-ac', '1', '-f', 'f32le', aFile,
        '-map', '0:v:0', '-vf', `scale=${W}:${H},format=gray,showinfo`, '-fps_mode', 'passthrough', '-f', 'rawvideo', vFile,
      ], { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(lastLines(err)))));
    });
    const pts = [...log.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const aBuf = await fsp.readFile(aFile);
    const a = new Float32Array(aBuf.buffer.slice(aBuf.byteOffset, aBuf.byteOffset + aBuf.length - (aBuf.length % 4)));
    const v = await fsp.readFile(vFile);
    const px = W * H;
    const n = Math.min(pts.length, Math.floor(v.length / px));
    if (n < 30 || a.length < SR) throw new Error('A gravação de teste ficou curta demais.');

    // Claps: 5 ms blocks far louder than the background and than what came just before.
    const B = SR / 200;
    const peaks = [];
    for (let i = 0; i + B <= a.length; i += B) {
      let m = 0;
      for (let j = i; j < i + B; j++) m = Math.max(m, Math.abs(a[j]));
      peaks.push(m);
    }
    const sorted = [...peaks].sort((x, y) => x - y);
    const floor = sorted[Math.floor(sorted.length / 2)];
    const top = sorted[sorted.length - 1];
    if (top < 0.05 || top < floor * 8) throw new Error('Não ouvi as palmas. Bata palmas mais forte, perto do microfone.');
    const claps = [];
    const order = peaks.map((_, i) => i).filter((i) => peaks[i] >= Math.max(top * 0.3, floor * 8)).sort((x, y) => peaks[y] - peaks[x]);
    for (const i of order) {
      if (claps.some((c) => Math.abs(c - i * B) < SR * 0.3)) continue;
      const p = peaks[i];
      let on = Math.max(0, i * B - SR * 0.03);
      while (on < i * B + B && Math.abs(a[on]) < p * 0.3) on++;
      let pre = 0;
      const p0 = Math.max(0, on - SR * 0.06);
      const p1 = Math.max(p0 + 1, on - SR * 0.01);
      for (let j = p0; j < p1; j++) pre += Math.abs(a[j]);
      if (p > (pre / (p1 - p0)) * 8) claps.push(on); // a clap starts out of (near) silence; speech does not
    }

    // Motion: mean change from one frame to the next.
    const E = new Float64Array(n);
    for (let k = 1; k < n; k++) {
      let s = 0;
      for (let j = 0, o = k * px, q = o - px; j < px; j++) s += Math.abs(v[o + j] - v[q + j]);
      E[k] = s / px;
    }
    // For each clap, the frame after which the motion stops most sharply is
    // the first one showing the hands together; they met half a frame earlier.
    const gaps = [];
    for (const on of claps) {
      const ta = on / SR;
      let best = -1;
      let drop = 0;
      for (let k = 1; k < n - 1; k++) {
        if (pts[k] < ta - 0.03 || pts[k] > ta + 0.45) continue;
        const d = E[k] - E[k + 1];
        if (d > drop) { drop = d; best = k; }
      }
      if (best > 0 && drop > 1.5) gaps.push(pts[best] - (pts[best] - pts[best - 1]) / 2 - ta);
    }
    gaps.sort((x, y) => x - y);
    const med = gaps[Math.floor(gaps.length / 2)];
    const agree = gaps.filter((g) => Math.abs(g - med) < 0.06);
    if (agree.length < 2) throw new Error('Não consegui ver as palmas na câmera. Deixe as mãos bem visíveis e bata palmas devagar, com pausas.');
    const ms = Math.round((agree.reduce((s, g) => s + g, 0) / agree.length) * 1000);
    return { ms: Math.max(0, ms), claps: agree.length };
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function lastLines(text, n = 6) {
  return text.trim().split(/\r?\n/).filter((l) => !/^\s*(frame|size)=/.test(l)).slice(-n).join('\n');
}

// Runs ffmpeg reporting progress (0..1) from `-progress pipe:1`.
function ffmpegRun(args, { total, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    exportProc = proc;
    let err = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && total && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / total));
      }
    });
    proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-30000); });
    proc.on('error', (e) => { exportProc = null; reject(e); });
    proc.on('close', (code) => {
      exportProc = null;
      if (exportCancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve(err);
      else reject(new Error(lastLines(err) || `ffmpeg saiu com código ${code}`));
    });
  });
}

// Audio leveling: a measured gain brings the take near -16 LUFS, a fast
// compressor evens out loud passages (no slow gain rides, so no fades), then a
// second measurement sets the final gain and a limiter keeps peaks under -2 dBFS.
const TARGET_LUFS = -16;
const HIGHPASS = 'highpass=f=70';
// Fast compressor: tames loud peaks without slow gain rides (no fades or pumping).
const COMPRESSOR = 'acompressor=threshold=-22dB:ratio=3:attack=8:release=180:knee=6';
const LIMITER = 'alimiter=limit=0.794:attack=5:release=60:level=false'; // -2 dBFS: AAC overshoot stays under -1 dBTP
const AUDIO_IN = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

function gainFor(lufs) {
  if (!Number.isFinite(lufs) || lufs < -60) return 0; // basically silent: don't pump noise
  return Math.max(-12, Math.min(24, TARGET_LUFS - lufs));
}

async function measureLoudness(inputArgs, chain, total, onProgress) {
  const err = await ffmpegRun(
    ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...inputArgs, '-filter_complex', chain, '-map', '[a]', '-f', 'null', '-'],
    { total, onProgress },
  );
  const m = [...err.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  return m ? Number(m[1]) : NaN;
}

// Kept ranges -> select expression on a frame grid. Cut points are multiples of
// 1/fps and audio is processed in blocks of exactly one video frame, so video
// and audio drop exactly the same spans and never drift apart.
function selectExpr(keep, fps) {
  const half = 0.5 / fps;
  return keep.map(([a, b]) => `between(t,${(a - half).toFixed(4)},${(b - half).toFixed(4)})`).join('+');
}

const TRACK_FILE = { camera: 'camera.mp4', screen: 'tela.mp4' };
const TRACK_LABEL = { camera: 'câmera', screen: 'tela' };

async function readProject(folder) {
  try {
    return JSON.parse(await fsp.readFile(path.join(folder, 'projeto.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function writeProject(folder, patch) {
  const cur = (await readProject(folder)) || {};
  const next = { ...cur, ...patch };
  await fsp.writeFile(path.join(folder, 'projeto.json'), JSON.stringify(next, null, 2));
  return next;
}

// Replace `target` with the freshly exported `partial` (the old one goes to the Recycle Bin).
async function swapIn(partial, target) {
  if (fs.existsSync(target)) await shell.trashItem(target).catch(() => fsp.rm(target, { force: true }));
  await fsp.rename(partial, target);
}

async function makeThumb(video, at, dest) {
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', video,
    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', dest]).catch(() => {});
}

// Adds the inputs for an extra clip (intro or transition): a video or a still
// image, plus silence when it has no audio. Returns its video/audio pads.
function clipInputs(inputs, clip, fps, duration, nextIndex) {
  let i = nextIndex;
  if (clip.isImage) inputs.push('-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', clip.path);
  else inputs.push('-i', clip.path);
  const v = `${i}:v`;
  let aPad = clip.hasAudio && !clip.isImage ? `${i}:a` : null;
  i += 1;
  if (!aPad) {
    inputs.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');
    aPad = `${i}:a`;
    i += 1;
  }
  return { v, a: aPad, next: i };
}

async function runExport(job) {
  const fps = job.fps || 30;
  const crf = job.crf || 26;
  const W = job.width || 1920;
  const H = job.height || 1080;
  const ns = Math.round(48000 / fps);
  const half = 0.5 / fps;
  const trans = job.transition || null;
  // seq: lesson pieces ({t:'s', a, b} in source seconds) and transitions ({t:'x'}), in output order.
  let seq = job.seq && job.seq.length ? job.seq : [{ t: 's', a: 0, b: job.duration }];
  if (!trans) seq = seq.filter((it) => it.t === 's');
  seq = seq.filter((it) => it.t === 'x' || it.b - it.a >= 1 / fps);
  const segs = seq.filter((it) => it.t === 's');
  if (!segs.length) throw new Error('Não sobrou nenhum trecho para exportar.');
  const keptDur = segs.reduce((sum, it) => sum + (it.b - it.a), 0);
  const transDur = trans ? Math.min(3, trans.duration) : 0;
  const nTrans = seq.length - segs.length;
  const intro = job.intro || null;
  const introDur = intro ? intro.duration : 0;
  const total = introDur + keptDur + nTrans * transDur;
  const level = job.level !== false;
  const tracks = (job.tracks || []).filter((t) => t.source && fs.existsSync(t.source));
  // Lip sync: cameras deliver frames late, so the audio is delayed to match.
  const delayMs = Math.round(job.audioDelay || 0);
  // Cuts are in audio time (what the waveform shows), so no syllable is lost;
  // the camera delivers frames late, so the video is read that much ahead.
  const vOff = delayMs / 1000;

  // Progress is reported per phase and as one overall number.
  const weights = [];
  if (level && job.hasAudio !== false) weights.push(['audio', 0.08 * keptDur]);
  weights.push(['video', total]);
  for (const t of tracks) weights.push([t.key, (t.key === 'screen' ? 0.8 : 0.5) * keptDur]);
  const sum = weights.reduce((acc, [, w]) => acc + w, 0) || 1;
  const send = (phase, pct) => {
    let done = 0;
    for (const [name, w] of weights) {
      if (name === phase) { done += w * pct; break; }
      done += w;
    }
    sendMain('export:progress', { phase, pct, overall: Math.min(1, done / sum) });
  };

  exportCancelled = false;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gravador-'));
  const outPath = job.output;
  const partial = outPath.replace(/\.mp4$/i, ' (exportando).mp4');
  const partials = [partial];

  try {
    const hasAudio = job.hasAudio !== false;
    const sel = selectExpr(segs.map((it) => [it.a, it.b]), fps);
    const aSel = `asetnsamples=n=${ns}:p=0,aselect='${sel}',asetpts=N/SR/TB`;

    // ---- pass 1: loudness of the lesson audio (as recorded, then after the compressor)
    let levelOn = false;
    let preGain = 0;
    let gain = 0;
    let introGain = 0;
    let transGain = 0;
    if (level && hasAudio) {
      const measure = async (chain, from, to) => {
        const f = path.join(tmp, 'measure.txt');
        await fsp.writeFile(f, `[0:a]${AUDIO_IN},${aSel},${chain},ebur128=framelog=quiet[a]`);
        const out = await ffmpegRun(
          ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', job.source, '-filter_complex_script', f, '-map', '[a]', '-f', 'null', '-'],
          { total: keptDur, onProgress: (pct) => send('audio', from + pct * (to - from)) },
        );
        const m = [...out.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
        return m ? Number(m[1]) : NaN;
      };
      send('audio', 0);
      const raw = await measure(HIGHPASS, 0, 0.5);
      levelOn = Number.isFinite(raw) && raw > -60; // a silent take is left alone
      if (levelOn) {
        preGain = gainFor(raw);
        gain = gainFor(await measure(`${HIGHPASS},volume=${preGain.toFixed(2)}dB,${COMPRESSOR}`, 0.5, 1));
      }
      const clipGain = async (clip) => (clip && clip.hasAudio && !clip.isImage
        ? gainFor(await measureLoudness(['-i', clip.path], `[0:a]${AUDIO_IN},ebur128=framelog=quiet[a]`, clip.duration, null))
        : 0);
      introGain = await clipGain(intro);
      if (nTrans) transGain = await clipGain(trans);
    }
    const lev = levelOn
      ? `,${HIGHPASS},volume=${preGain.toFixed(2)}dB,${COMPRESSOR},volume=${gain.toFixed(2)}dB,${LIMITER}`
      : '';
    const clipLevel = (g) => (level ? `,volume=${g.toFixed(2)}dB,${LIMITER}` : '');
    const audioArgs = ['-c:a', 'aac', '-b:a', job.stereo ? '128k' : '96k', '-ac', job.stereo ? '2' : '1', '-ar', '48000'];
    const videoArgs = (preset, q) => [
      '-c:v', 'libx264', '-preset', preset, '-crf', String(q), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-x264-params', `keyint=${fps * 10}:min-keyint=${fps}`, '-r', String(fps),
    ];

    // Lesson pieces of one input: every kept span is trimmed on the frame grid
    // (video) and to the sample (audio), so cuts are exact and never drift.
    const pieces = (vIn, aIn, p, vFilter) => {
      const n = segs.length;
      const vl = segs.map((_, i) => `[${p}v${i}]`).join('');
      const al = segs.map((_, i) => `[${p}a${i}]`).join('');
      const lines = [
        `[${vIn}]fps=${fps}${n > 1 ? `,split=${n}` : ''}${vl}`,
        `[${aIn}]${AUDIO_IN}${n > 1 ? `,asplit=${n}` : ''}${al}`,
      ];
      segs.forEach((it, i) => {
        const len = it.b - it.a;
        const va = Math.max(0, it.a + vOff - half);
        lines.push(`[${p}v${i}]trim=start=${va.toFixed(4)}:end=${(va + len).toFixed(4)},setpts=PTS-STARTPTS,${vFilter}[${p}sv${i}]`);
        // 6 ms micro-fades at each seam: no clicks, inaudible otherwise.
        const fades = n > 1 && len > 0.05 ? `,afade=t=in:d=0.006,afade=t=out:st=${(len - 0.006).toFixed(4)}:d=0.006` : '';
        lines.push(`[${p}a${i}]atrim=start=${it.a.toFixed(4)}:end=${it.b.toFixed(4)},asetpts=PTS-STARTPTS${fades}${lev}[${p}sa${i}]`);
      });
      return lines;
    };

    // ---- pass 2: final video = intro + pieces + transitions, leveled and compressed
    const FIT = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    const inputs = ['-i', job.source];
    let next = 1;
    let mainA = '0:a';
    if (!hasAudio) {
      inputs.push('-f', 'lavfi', '-t', String(job.duration), '-i', 'anullsrc=r=48000:cl=stereo');
      mainA = `${next}:a`;
      next += 1;
    }
    const graph = pieces('0:v', mainA, 'm', `${FIT},format=yuv420p`);
    const order = [];
    if (intro) {
      const c = clipInputs(inputs, intro, fps, intro.duration, next);
      next = c.next;
      const D = intro.duration.toFixed(3);
      graph.push(`[${c.v}]${FIT},fps=${fps},format=yuv420p,trim=duration=${D},setpts=PTS-STARTPTS[iv]`);
      graph.push(`[${c.a}]${AUDIO_IN},apad,atrim=duration=${D},asetpts=PTS-STARTPTS${intro.hasAudio ? clipLevel(introGain) : ''}[ia]`);
      order.push('[iv][ia]');
    }
    if (nTrans) {
      const c = clipInputs(inputs, trans, fps, transDur, next);
      next = c.next;
      const D = transDur.toFixed(3);
      const tv = Array.from({ length: nTrans }, (_, j) => `[tv${j}]`).join('');
      const ta = Array.from({ length: nTrans }, (_, j) => `[ta${j}]`).join('');
      graph.push(`[${c.v}]${FIT},fps=${fps},format=yuv420p,trim=duration=${D},setpts=PTS-STARTPTS${nTrans > 1 ? `,split=${nTrans}` : ''}${tv}`);
      graph.push(`[${c.a}]${AUDIO_IN},apad,atrim=duration=${D},asetpts=PTS-STARTPTS${trans.hasAudio ? clipLevel(transGain) : ''}${nTrans > 1 ? `,asplit=${nTrans}` : ''}${ta}`);
    }
    let si = 0;
    let ti = 0;
    for (const it of seq) {
      if (it.t === 's') { order.push(`[msv${si}][msa${si}]`); si += 1; } else { order.push(`[tv${ti}][ta${ti}]`); ti += 1; }
    }
    graph.push(`${order.join('')}concat=n=${order.length}:v=1:a=1[v][a]`);
    const f2 = path.join(tmp, 'export.txt');
    await fsp.writeFile(f2, graph.join(';\n'));

    send('video', 0);
    await ffmpegRun([
      '-hide_banner', '-nostats', '-y', '-progress', 'pipe:1',
      ...inputs,
      '-filter_complex_script', f2,
      '-map', '[v]', '-map', '[a]',
      ...videoArgs('slow', crf),
      ...audioArgs,
      '-movflags', '+faststart',
      partial,
    ], { total, onProgress: (pct) => send('video', pct) });

    // ---- separate camera / screen files: same cuts and audio, no intro or transitions
    const trackOut = [];
    for (const t of tracks) {
      const tp = t.output.replace(/\.mp4$/i, ' (exportando).mp4');
      partials.push(tp);
      const ft = path.join(tmp, `${t.key}.txt`);
      const c = t.key === 'screen' && job.screenCrop;
      const cropF = c ? `crop=trunc(iw*${c.w.toFixed(4)}/2)*2:trunc(ih*${c.h.toFixed(4)}/2)*2:iw*${c.x.toFixed(4)}:ih*${c.y.toFixed(4)},` : '';
      const tg = pieces('0:v', '0:a', 't', `${cropF}scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p`);
      tg.push(`${segs.map((_, i) => `[tsv${i}][tsa${i}]`).join('')}concat=n=${segs.length}:v=1:a=1[v][a]`);
      await fsp.writeFile(ft, tg.join(';\n'));
      send(t.key, 0);
      await ffmpegRun([
        '-hide_banner', '-nostats', '-y', '-progress', 'pipe:1',
        '-i', t.source,
        '-filter_complex_script', ft,
        '-map', '[v]', '-map', '[a]',
        ...videoArgs('medium', Math.max(16, crf - 2)),
        ...audioArgs,
        '-movflags', '+faststart',
        tp,
      ], { total: keptDur, onProgress: (pct) => send(t.key, pct) });
      trackOut.push({ key: t.key, partial: tp, output: t.output });
    }

    // ---- put the files in place
    await swapIn(partial, outPath);
    const result = { path: outPath, url: pathToFileURL(outPath).href, size: (await fsp.stat(outPath)).size, duration: total, tracks: [] };
    for (const t of trackOut) {
      await swapIn(t.partial, t.output);
      result.tracks.push({ key: t.key, path: t.output, size: (await fsp.stat(t.output)).size });
    }

    let sourceTrashed = false;
    if (job.folder) {
      await makeThumb(outPath, introDur + Math.min(1.5, keptDur / 2), path.join(job.folder, 'capa.jpg'));
      const originalsDir = path.join(job.folder, 'originais');
      const patch = {
        exports: {
          main: path.basename(outPath),
          ...Object.fromEntries(result.tracks.map((t) => [t.key, path.basename(t.path)])),
        },
        exportedAt: new Date().toISOString(),
        removed: job.removed || [],
        inserts: job.inserts || [],
        audioDelay: delayMs,
        finalDuration: total,
        introApplied: !!intro || !!job.introApplied,
      };
      if (job.trashOriginals && fs.existsSync(originalsDir) && job.source.startsWith(originalsDir)) {
        await shell.trashItem(originalsDir).then(() => { sourceTrashed = true; }).catch(() => {});
        if (sourceTrashed) patch.originals = null;
      }
      await writeProject(job.folder, patch);
    } else if (job.trashOriginals && createdFiles.has(job.source)) {
      await shell.trashItem(job.source).then(() => { sourceTrashed = true; createdFiles.delete(job.source); }).catch(() => {});
    }
    result.sourceTrashed = sourceTrashed;
    result.size += result.tracks.reduce((acc, t) => acc + t.size, 0);
    return result;
  } catch (err) {
    for (const f of partials) await fsp.rm(f, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- gallery

const durationCache = new Map();
async function cachedDuration(file, mtimeMs) {
  const key = `${file}|${mtimeMs}`;
  if (!durationCache.has(key)) durationCache.set(key, (await probe(file)).duration);
  return durationCache.get(key);
}

async function thumbFor(video, folder, mtimeMs) {
  let dest;
  if (folder) {
    dest = path.join(folder, 'capa.jpg');
  } else {
    const dir = path.join(app.getPath('userData'), 'capas');
    await fsp.mkdir(dir, { recursive: true });
    const hash = require('crypto').createHash('sha1').update(`${video}|${mtimeMs}`).digest('hex').slice(0, 16);
    dest = path.join(dir, `${hash}.jpg`);
  }
  if (!fs.existsSync(dest)) await makeThumb(video, 1.5, dest);
  return fs.existsSync(dest) ? `${pathToFileURL(dest).href}?v=${Math.round(fs.statSync(dest).mtimeMs)}` : null;
}

const isVideo = (name) => /\.(mp4|mov|mkv|webm|m4v)$/i.test(name) && !/\((gravando|exportando)\)/i.test(name);

async function galleryItemFromFolder(folder) {
  const proj = await readProject(folder);
  const abs = (rel) => (rel ? path.join(folder, rel) : null);
  if (proj) {
    const exportsAbs = proj.exports ? Object.fromEntries(Object.entries(proj.exports).map(([k, v]) => [k, abs(v)])) : null;
    const originalsAbs = proj.originals ? Object.fromEntries(Object.entries(proj.originals).map(([k, v]) => [k, abs(v)])) : null;
    const exists = (f) => f && fs.existsSync(f);
    const main = exists(exportsAbs && exportsAbs.main) ? exportsAbs.main : (exists(originalsAbs && originalsAbs.main) ? originalsAbs.main : null);
    if (!main) return null;
    const files = [exportsAbs && exportsAbs.main, exportsAbs && exportsAbs.camera, exportsAbs && exportsAbs.screen].filter(exists);
    let size = 0;
    for (const f of files.length ? files : [main]) size += (await fsp.stat(f)).size;
    const stat = await fsp.stat(main);
    const title = proj.title || path.basename(folder);
    const fromOriginals = originalsAbs && exists(originalsAbs.main);
    const editSource = fromOriginals ? originalsAbs.main : main;
    const edit = {
      source: editSource,
      url: pathToFileURL(editSource).href,
      duration: fromOriginals ? proj.duration : (proj.finalDuration || proj.duration),
      original: !!fromOriginals,
      editingFinal: !fromOriginals,
      introApplied: fromOriginals ? false : !!proj.introApplied,
      removed: fromOriginals ? (proj.removed || []) : [],
      screenCrop: proj.screenCrop || null,
      inserts: fromOriginals ? (proj.inserts || []) : [],
      audioDelay: fromOriginals ? proj.audioDelay : 0,
      finalPath: fromOriginals ? path.join(folder, `${title}.mp4`) : main,
      tracks: fromOriginals
        ? ['camera', 'screen'].filter((k) => exists(originalsAbs[k])).map((k) => ({
          key: k, source: originalsAbs[k], output: path.join(folder, `${title} - ${TRACK_LABEL[k]}.mp4`),
        }))
        : [],
    };
    return {
      edit,
      mde: publicState(proj.mde),
      id: folder,
      kind: 'project',
      folder,
      title: proj.title || path.basename(folder),
      createdAt: proj.createdAt || stat.mtime.toISOString(),
      orientation: proj.orientation || 'h',
      width: proj.width || 1920,
      height: proj.height || 1080,
      duration: proj.finalDuration || proj.duration || 0,
      sourceDuration: proj.duration || 0,
      status: exists(exportsAbs && exportsAbs.main) ? 'ready' : 'draft',
      main,
      mainUrl: pathToFileURL(main).href,
      originals: originalsAbs && exists(originalsAbs.main) ? originalsAbs : null,
      exports: exportsAbs,
      trackCount: [exportsAbs && exportsAbs.camera, exportsAbs && exportsAbs.screen].filter(exists).length
        || (originalsAbs ? [originalsAbs.camera, originalsAbs.screen].filter(exists).length : 0),
      size,
      thumb: await thumbFor(main, folder, stat.mtimeMs),
      removed: proj.removed || [],
      introApplied: !!proj.introApplied,
      stereo: !!proj.stereo,
      hasAudio: proj.hasAudio !== false,
      fps: proj.fps || 30,
    };
  }
  // A folder without a project file: show its biggest video.
  const names = (await fsp.readdir(folder)).filter(isVideo);
  if (!names.length) return null;
  const stats = await Promise.all(names.map(async (n) => ({ n, st: await fsp.stat(path.join(folder, n)) })));
  stats.sort((a, b) => b.st.size - a.st.size);
  return galleryItemFromFile(path.join(folder, stats[0].n), stats[0].st, folder);
}

async function galleryItemFromFile(file, st, folder = null) {
  const stat = st || (await fsp.stat(file));
  const info = await probe(file);
  const base = path.basename(file, path.extname(file));
  return {
    edit: {
      source: file,
      url: pathToFileURL(file).href,
      duration: info.duration,
      original: false,
      editingFinal: false,
      introApplied: false,
      removed: [],
      finalPath: uniquePath(path.dirname(file), `${base} (editado)`, '.mp4'),
      tracks: [],
    },
    id: file,
    kind: 'file',
    folder,
    title: path.basename(file, path.extname(file)),
    createdAt: stat.mtime.toISOString(),
    orientation: info.height > info.width ? 'v' : 'h',
    width: info.width,
    height: info.height,
    duration: info.duration,
    sourceDuration: info.duration,
    status: 'ready',
    main: file,
    mainUrl: pathToFileURL(file).href,
    originals: null,
    exports: null,
    trackCount: 0,
    size: stat.size,
    thumb: await thumbFor(file, null, stat.mtimeMs),
    removed: [],
    introApplied: false,
    stereo: true,
    hasAudio: info.hasAudio,
    fps: 30,
  };
}

async function listGallery(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const it = await galleryItemFromFolder(full);
        if (it) items.push(it);
      } else if (e.isFile() && isVideo(e.name)) {
        items.push(await galleryItemFromFile(full));
      }
    } catch { /* unreadable entry: skip */ }
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

const safeName = (name) => String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);

async function renameItem(item, title) {
  const clean = safeName(title);
  if (!clean) throw new Error('Nome inválido.');
  if (item.kind === 'file') {
    const dest = path.join(path.dirname(item.main), clean + path.extname(item.main));
    if (dest !== item.main) {
      if (fs.existsSync(dest)) throw new Error('Já existe um arquivo com esse nome.');
      await fsp.rename(item.main, dest);
    }
    return galleryItemFromFile(dest);
  }
  const proj = (await readProject(item.folder)) || {};
  const parent = path.dirname(item.folder);
  const newFolder = path.join(parent, clean);
  if (newFolder !== item.folder && fs.existsSync(newFolder)) throw new Error('Já existe uma aula com esse nome.');
  // Rename the exported files to match the new title.
  const exportsRel = { ...(proj.exports || {}) };
  for (const [key, rel] of Object.entries(exportsRel)) {
    if (!rel) continue;
    const suffix = key === 'main' ? '' : ` - ${TRACK_LABEL[key] || key}`;
    const nextRel = `${clean}${suffix}.mp4`;
    const from = path.join(item.folder, rel);
    if (fs.existsSync(from) && rel !== nextRel) await fsp.rename(from, path.join(item.folder, nextRel));
    exportsRel[key] = nextRel;
  }
  await writeProject(item.folder, { title: clean, exports: proj.exports ? exportsRel : proj.exports });
  if (newFolder !== item.folder) await fsp.rename(item.folder, newFolder);
  return galleryItemFromFolder(newFolder);
}

// With fractional scaling, DIP x scale factor lands a pixel or two off the real
// resolution (2561x1081 for a 2560x1080 monitor). Snap to the usual values.
const STD_W = [1280, 1360, 1366, 1440, 1536, 1600, 1680, 1920, 2048, 2160, 2256, 2560, 2736, 2880, 3000, 3200, 3440, 3840, 5120];
const STD_H = [720, 768, 800, 864, 900, 960, 1024, 1050, 1080, 1152, 1200, 1280, 1440, 1504, 1600, 1800, 1824, 1920, 2000, 2160, 2880];
function snapRes(v, list) {
  const near = list.find((c) => Math.abs(c - v) <= 3);
  return near || v;
}

// ---------------------------------------------------------------- IPC

// ---------------------------------------------------------------- recording helpers

let keepAwakeId = null;

// Draw a rectangle on the real screen (like the Snipping Tool): only that area
// of the screen is recorded. Returns it as fractions of the screen.
let regionWin = null;
async function selectRegion(displayId) {
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  if (regionWin && !regionWin.isDestroyed()) regionWin.destroy();
  const restoreMain = mainWin && !mainWin.isDestroyed() && !mainWin.isMinimized();
  if (restoreMain) mainWin.minimize();
  regionWin = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  regionWin.setAlwaysOnTop(true, 'screen-saver');
  regionWin.setContentProtection(true);
  regionWin.setBounds(display.bounds);
  await regionWin.loadFile(path.join(__dirname, 'src', 'region.html'));
  regionWin.focus();
  return new Promise((resolve) => {
    let settled = false;
    const done = (rect) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners('region:done');
      if (regionWin && !regionWin.isDestroyed()) regionWin.destroy();
      regionWin = null;
      if (restoreMain && mainWin && !mainWin.isDestroyed()) {
        mainWin.restore();
        mainWin.focus();
      }
      resolve(rect);
    };
    ipcMain.on('region:done', (_e, rect) => done(rect));
    regionWin.on('closed', () => done(null));
  });
}

// Floating "Roteiro" (script) window: always on top and left out of the recording.
let scriptWin = null;
function toggleScript(show) {
  if (scriptWin && !scriptWin.isDestroyed()) {
    if (show === true) { scriptWin.show(); scriptWin.focus(); } else scriptWin.close();
    return;
  }
  if (show === false) return;
  const b = readSettings().scriptBounds || {};
  const wa = activeDisplay().workArea;
  scriptWin = new BrowserWindow({
    width: b.width || 440,
    height: b.height || 560,
    x: b.x ?? wa.x + wa.width - 480,
    y: b.y ?? wa.y + 80,
    minWidth: 300,
    minHeight: 220,
    frame: false,
    backgroundColor: '#121419',
    alwaysOnTop: true,
    title: 'Roteiro',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  scriptWin.setAlwaysOnTop(true, 'floating');
  scriptWin.setContentProtection(true);
  scriptWin.loadFile(path.join(__dirname, 'src', 'script.html'));
  const saveBounds = () => {
    if (!scriptWin || scriptWin.isDestroyed()) return;
    settingsCache = { ...readSettings(), scriptBounds: scriptWin.getBounds() };
    writeSettingsSoon();
  };
  scriptWin.on('moved', saveBounds);
  scriptWin.on('resized', saveBounds);
  scriptWin.on('closed', () => { scriptWin = null; sendMain('script:state', false); });
  sendMain('script:state', true);
}

function registerExtrasIpc() {
  ipcMain.handle('region:select', (_e, displayId) => selectRegion(displayId));
  ipcMain.handle('script:toggle', () => toggleScript());
  ipcMain.on('bar:script', () => toggleScript());
  ipcMain.on('script:close', () => toggleScript(false));
  ipcMain.handle('script:get', () => {
    const st = readSettings();
    return { text: st.scriptText || '', size: st.scriptSize || 30, speed: st.scriptSpeed || 35 };
  });
  ipcMain.on('script:set', (_e, patch) => {
    const next = {};
    if (typeof patch.text === 'string') next.scriptText = patch.text.slice(0, 200000);
    if (Number.isFinite(patch.size)) next.scriptSize = patch.size;
    if (Number.isFinite(patch.speed)) next.scriptSpeed = patch.speed;
    settingsCache = { ...readSettings(), ...next };
    writeSettingsSoon();
  });
}

// First run of a new user: start from the team's settings bundled with the app
// (layouts, intro/transition clips, logo, preferences). Personal things (MDE
// key, devices, output folder) are never bundled.
function defaultsDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'defaults') : path.join(__dirname, 'build', 'defaults');
}

async function applyBundledDefaults() {
  if (fs.existsSync(SETTINGS_FILE())) return;
  const dir = defaultsDir();
  const file = path.join(dir, 'settings.json');
  if (!fs.existsSync(file)) return;
  try {
    const def = JSON.parse(await fsp.readFile(file, 'utf8'));
    const prefs = { ...(def.prefs || {}) };
    for (const key of ['intro', 'introV', 'transition', 'transitionV', 'logo']) {
      const it = prefs[key];
      if (!it || !it.file) { prefs[key] = it && it.path ? null : it; continue; }
      const src = path.join(dir, it.file);
      if (!fs.existsSync(src)) { prefs[key] = null; continue; }
      const dest = path.join(app.getPath('userData'), it.file);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      const { file: _rel, ...rest } = it;
      prefs[key] = { ...rest, path: dest, url: pathToFileURL(dest).href };
    }
    settingsCache = { ...def, prefs };
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    await fsp.writeFile(SETTINGS_FILE(), JSON.stringify(settingsCache, null, 2));
  } catch { /* a broken bundle just means factory defaults */ }
}

// ---------------------------------------------------------------- MDE (lesson upload)

// The API key is encrypted with Windows DPAPI and never sent back to the page.
function mdeKey() {
  const enc = readSettings().mdeKeyEnc;
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

function mdeConfig() {
  const prefs = readSettings().prefs || {};
  return { baseUrl: prefs.mdeBaseUrl || MDE_DEFAULT_URL, apiKey: mdeKey() };
}

const mde = new Mde({
  getConfig: mdeConfig,
  readProject,
  writeProject,
  notify: (status) => sendMain('mde:status', status),
});

function mdeInfo() {
  const key = mdeKey();
  return { hasKey: !!key, last4: key ? key.slice(-4) : '', baseUrl: mdeConfig().baseUrl, defaultUrl: MDE_DEFAULT_URL };
}

async function resumeMdeUploads() {
  const dir = (readSettings().prefs || {}).outDir || defaultOutDir();
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const folders = entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
    .filter((f) => fs.existsSync(path.join(f, 'projeto.json')));
  if (mdeKey()) mde.resumeAll(folders);
}

function registerMdeIpc() {
  ipcMain.handle('mde:info', () => mdeInfo());
  ipcMain.handle('mde:setKey', async (_e, key) => {
    const clean = String(key || '').trim();
    if (!clean) return { ok: false, message: 'Cole a chave primeiro.' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'O Windows não permitiu guardar a chave com segurança.' };
    settingsCache = { ...readSettings(), mdeKeyEnc: safeStorage.encryptString(clean).toString('base64') };
    writeSettingsSoon();
    const res = await mde.test();
    return { ...res, ...mdeInfo() };
  });
  ipcMain.handle('mde:clearKey', () => {
    settingsCache = { ...readSettings() };
    delete settingsCache.mdeKeyEnc;
    writeSettingsSoon();
    return mdeInfo();
  });
  ipcMain.handle('mde:test', async () => ({ ...(await mde.test()), ...mdeInfo() }));
  ipcMain.handle('mde:send', async (_e, folder, opts) => {
    if (!mdeKey()) throw new Error('Cadastre sua chave de API do MDE em Configurações.');
    if (!folder || !fs.existsSync(path.join(folder, 'projeto.json'))) throw new Error('Só dá para enviar aulas gravadas por este app.');
    if (!opts || !opts.file || !fs.existsSync(opts.file)) throw new Error('O vídeo final não foi encontrado.');
    return mde.send(folder, opts);
  });
  ipcMain.handle('mde:cancel', (_e, folder) => mde.cancel(folder));
  ipcMain.handle('mde:open', (_e, url) => {
    if (/^https:\/\//.test(url || '')) shell.openExternal(url);
  });
}

function registerIpc() {
  registerMdeIpc();
  registerExtrasIpc();
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    defaultOutDir: defaultOutDir(),
  }));

  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    settingsCache = { ...readSettings(), ...patch };
    writeSettingsSoon();
    return true;
  });

  ipcMain.handle('sources:list', async () => {
    const own = new Set(
      [mainWin, barWin].filter((w) => w && !w.isDestroyed()).map((w) => w.getMediaSourceId()),
    );
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 640, height: 360 },
      fetchWindowIcons: true,
    });
    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    return sources
      .filter((s) => !own.has(s.id))
      .filter((s) => s.id.startsWith('screen') || !s.thumbnail.isEmpty())
      .map((s) => {
        const isScreen = s.id.startsWith('screen');
        const display = isScreen ? displays.find((d) => String(d.id) === String(s.display_id)) : null;
        const thumb = s.thumbnail.getSize();
        const px = display ? screen.dipToScreenRect(null, display.bounds) : null;
        return {
          id: s.id,
          name: s.name,
          type: isScreen ? 'screen' : 'window',
          displayId: s.display_id || '',
          primary: display ? display.id === primaryId : false,
          width: px ? snapRes(px.width, STD_W) : thumb.width,
          height: px ? snapRes(px.height, STD_H) : thumb.height,
          thumbnail: s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        };
      });
  });

  ipcMain.handle('dialog:folder', async (_e, current) => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: 'Escolha onde salvar as gravações',
      defaultPath: current || defaultOutDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

  // --- recording file lifecycle
  ipcMain.handle('rec:prepare', async (_e, { outDir, ext, tracks = [] }) => {
    const dir = outDir || defaultOutDir();
    await fsp.mkdir(dir, { recursive: true });
    let base = timestampName();
    let i = 2;
    while (fs.existsSync(path.join(dir, base))) {
      base = `${timestampName()} (${i})`;
      i += 1;
    }
    // Every recording gets its own folder; the raw takes live in "originais"
    // until the final video is exported.
    let freeGB = null;
    try {
      const fsInfo = await fsp.statfs(dir);
      freeGB = (fsInfo.bavail * fsInfo.bsize) / 1e9;
    } catch { /* unknown */ }
    if (freeGB != null && freeGB < 1.5) {
      throw new Error(`Pouco espaço em disco: só ${freeGB.toFixed(1).replace('.', ',')} GB livres na pasta dos vídeos.`);
    }
    const folder = path.join(dir, base);
    const originalsDir = path.join(folder, 'originais');
    await fsp.mkdir(originalsDir, { recursive: true });
    const streams = {};
    for (const key of ['main', ...tracks]) {
      const name = key === 'main' ? 'final' : (key === 'camera' ? 'camera' : 'tela');
      const tempPath = path.join(originalsDir, `${name} (gravando)${ext}`);
      const ws = fs.createWriteStream(tempPath);
      ws.on('error', (err) => sendMain('rec:error', err.message));
      streams[key] = { tempPath, path: path.join(originalsDir, `${name}.mp4`), ws };
    }
    rec = { folder, originalsDir, base, streams };
    return { folder, base, freeGB };
  });

  ipcMain.handle('rec:chunk', (_e, key, buf) => {
    const s = rec && rec.streams[key];
    if (!s) return false;
    const data = Buffer.from(buf);
    return new Promise((resolve) => {
      if (s.ws.write(data)) resolve(true);
      else s.ws.once('drain', () => resolve(true));
    });
  });

  ipcMain.handle('rec:discard', async () => {
    if (!rec) return true;
    const { streams, folder } = rec;
    rec = null;
    for (const s of Object.values(streams)) await closeStream(s.ws);
    await fsp.rm(folder, { recursive: true, force: true });
    return true;
  });

  // Turns each raw (fragmented) take into a regular, seekable MP4 — the
  // "originals" the editor works on. Nothing is re-encoded, so it is quick.
  ipcMain.handle('rec:finish', async (_e, { mime, meta = {} }) => {
    if (!rec) throw new Error('Nenhuma gravação ativa.');
    const { streams, folder, base } = rec;
    rec = null;
    const isH264 = /avc1|h264/i.test(mime);
    const isAac = /mp4a/i.test(mime);
    const warnings = [];
    const done = {};
    for (const [key, s] of Object.entries(streams)) {
      await closeStream(s.ws);
      if (!fs.existsSync(s.tempPath) || fs.statSync(s.tempPath).size === 0) {
        await fsp.rm(s.tempPath, { force: true });
        continue;
      }
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', s.tempPath];
      args.push(...(isH264 ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']));
      args.push(...(isAac ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
      args.push('-movflags', '+faststart', s.path);
      try {
        await runFfmpeg(args);
        await fsp.rm(s.tempPath, { force: true });
        done[key] = s.path;
      } catch (err) {
        warnings.push(`Não foi possível preparar um dos arquivos; a gravação bruta foi mantida. (${String(err.message).slice(0, 200)})`);
        done[key] = s.tempPath;
      }
      createdFiles.add(done[key]);
    }
    if (!done.main) throw new Error('A gravação ficou vazia.');
    const info = await probe(done.main);
    const rel = (f) => (f ? path.relative(folder, f) : null);
    await writeProject(folder, {
      version: 1,
      title: base,
      createdAt: new Date().toISOString(),
      orientation: meta.orientation || 'h',
      width: meta.width || info.width,
      height: meta.height || info.height,
      fps: meta.fps || 30,
      duration: info.duration,
      stereo: !!meta.stereo,
      screenCrop: meta.screenCrop || null,
      hasAudio: info.hasAudio,
      syncMs: meta.syncMs || 0, // camera delay already compensated while recording
      audioDelay: 0,
      originals: { main: rel(done.main), camera: rel(done.camera), screen: rel(done.screen) },
      exports: null,
      removed: [],
    });
    const stat = await fsp.stat(done.main);
    return {
      folder,
      title: base,
      path: done.main,
      url: pathToFileURL(done.main).href,
      size: stat.size,
      duration: info.duration,
      hasAudio: info.hasAudio,
      finalPath: path.join(folder, `${base}.mp4`),
      tracks: ['camera', 'screen'].filter((k) => done[k]).map((k) => ({
        key: k, source: done[k], output: path.join(folder, `${base} - ${TRACK_LABEL[k]}.mp4`),
      })),
      warning: warnings[0] || null,
    };
  });

  // --- gallery
  ipcMain.handle('gallery:list', (_e, dir) => listGallery(dir || defaultOutDir()));
  ipcMain.handle('gallery:rename', (_e, item, title) => renameItem(item, title));
  ipcMain.handle('gallery:trash', async (_e, item) => {
    const target = item.kind === 'project' ? item.folder : item.main;
    if (!target || !fs.existsSync(target)) return false;
    await shell.trashItem(target);
    return true;
  });
  ipcMain.handle('project:save', async (_e, folder, patch) => {
    if (!folder || !fs.existsSync(path.join(folder, 'projeto.json'))) return false;
    await writeProject(folder, patch);
    return true;
  });

  // --- media helpers for the editor
  ipcMain.handle('media:probe', (_e, file) => probe(file));
  ipcMain.handle('media:waveform', (_e, file) => waveform(file));
  ipcMain.handle('sync:measure', async (_e, buf) => {
    const file = path.join(os.tmpdir(), `gravador-sync-${Date.now()}.mp4`);
    await fsp.writeFile(file, Buffer.from(buf));
    try { return await measureSync(file); } finally { fsp.rm(file, { force: true }).catch(() => {}); }
  });
  ipcMain.handle('media:url', (_e, file) => pathToFileURL(file).href);
  // Video-only copy for the editor's players (no re-encode): a <video> with an
  // audio track opens a Windows audio stream on every play, which takes ~1 s.
  ipcMain.handle('media:proxyVideo', async (_e, file) => {
    const st = await fsp.stat(file);
    const dir = path.join(os.tmpdir(), 'gravador-previas');
    await fsp.mkdir(dir, { recursive: true });
    const hash = require('crypto').createHash('sha1').update(`proxy|${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    const out = path.join(dir, `${hash}-540p.mp4`);
    if (!fs.existsSync(out)) {
      const tmpOut = `${out}.part.mp4`;
      await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-an',
        '-vf', "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)':flags=fast_bilinear",
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-bf', '0',
        '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpOut]);
      await fsp.rename(tmpOut, out);
    }
    return pathToFileURL(out).href;
  });
  ipcMain.handle('media:previewVideo', async (_e, file) => {
    const st = await fsp.stat(file);
    const dir = path.join(os.tmpdir(), 'gravador-previas');
    await fsp.mkdir(dir, { recursive: true });
    const hash = require('crypto').createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
    const out = path.join(dir, `${hash}.mp4`);
    if (!fs.existsSync(out)) {
      const tmpOut = `${out}.part.mp4`;
      await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', tmpOut]);
      await fsp.rename(tmpOut, out);
    }
    return pathToFileURL(out).href;
  });

  ipcMain.handle('dialog:intro', async (_e, slot = 'h') => {
    const isLogo = slot === 'logo';
    const res = await dialog.showOpenDialog(mainWin, {
      title: isLogo ? 'Escolha a sua logo (PNG com fundo transparente fica melhor)' : 'Escolha o vídeo ou a imagem',
      properties: ['openFile'],
      filters: [isLogo
        ? { name: 'Imagem', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
        : { name: 'Vídeo ou imagem', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    const info = await probe(src);
    if (!info.hasVideo) throw new Error('Esse arquivo não tem imagem.');
    if (isLogo && !info.isImage) throw new Error('Escolha uma imagem (PNG, JPG ou WebP).');
    // Keep a private copy so the file survives if the original is moved.
    const SLOT_DIR = { h: 'horizontal', v: 'vertical', th: 'transicao-horizontal', tv: 'transicao-vertical', logo: 'logo' };
    const dir = path.join(app.getPath('userData'), 'intro', SLOT_DIR[slot] || 'horizontal');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, `intro${path.extname(src).toLowerCase()}`);
    await fsp.copyFile(src, dest);
    return {
      path: dest,
      url: `${pathToFileURL(dest).href}?v=${Date.now()}`,
      name: path.basename(src),
      isImage: info.isImage,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio && !info.isImage,
      // Transitions are short inserts: at most 3 s.
      duration: slot.startsWith('t') ? Math.min(3, info.isImage ? 2 : info.duration) : (info.isImage ? 3 : info.duration),
    };
  });

  ipcMain.handle('dialog:openVideo', async (_e, defaultPath) => {
    const res = await dialog.showOpenDialog(mainWin, {
      title: 'Abrir um vídeo para editar',
      defaultPath: defaultPath || defaultOutDir(),
      properties: ['openFile'],
      filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    const info = await probe(file);
    if (!info.hasVideo) throw new Error('Esse arquivo não tem vídeo.');
    if (/ \(original\)\.mp4$/i.test(file)) createdFiles.add(file); // a recording of ours from an earlier session
    const stat = await fsp.stat(file);
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file)).replace(/ \(original\)$/, '');
    let finalPath = path.join(dir, `${base}.mp4`);
    if (finalPath.toLowerCase() === file.toLowerCase() || fs.existsSync(finalPath)) {
      finalPath = uniquePath(dir, `${base} (editado)`, '.mp4');
    }
    return { path: file, url: pathToFileURL(file).href, size: stat.size, finalPath, ...info };
  });

  // Only files this app created (the "original" recordings) can be removed, and
  // they go to the Recycle Bin, never deleted outright.
  ipcMain.handle('file:trash', async (_e, file) => {
    if (!createdFiles.has(file)) return false;
    await shell.trashItem(file);
    createdFiles.delete(file);
    return true;
  });

  ipcMain.handle('export:run', (_e, job) => runExport(job));
  ipcMain.handle('export:cancel', () => {
    exportCancelled = true;
    if (exportProc) exportProc.kill();
    return true;
  });

  // --- recording UI orchestration (main window <-> floating bar)
  ipcMain.handle('ui:startCountdown', async (_e, { seconds, layouts, active, orientation }) => {
    recording = true;
    if (keepAwakeId == null) keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (mainWin && !mainWin.isMinimized()) mainWin.minimize();
    if (seconds > 0) {
      await showBar('countdown', { seconds, layouts, active, orientation });
    } else {
      sendMain('rec:go');
    }
    return true;
  });

  ipcMain.handle('ui:recordingStarted', async (_e, payload) => {
    await showBar('bar', payload);
    return true;
  });

  ipcMain.handle('ui:recordingEnded', () => {
    hideBar();
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
    return true;
  });

  ipcMain.handle('ui:finalized', () => {
    recording = false;
    if (keepAwakeId != null) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = null; }
    if (quitAfterFinish) app.quit();
    return true;
  });

  ipcMain.on('rec:status', (_e, status) => sendBar('bar:status', status));

  // --- floating bar -> studio
  ipcMain.on('bar:countdownDone', () => sendMain('rec:go'));
  ipcMain.on('bar:cancel', () => {
    hideBar();
    sendMain('rec:cancel');
  });
  ipcMain.on('bar:action', (_e, action) => sendMain('bar:action', action));
  ipcMain.on('bar:resize', (_e, width) => {
    if (!barWin || barWin.isDestroyed()) return;
    const b = barWin.getBounds();
    if (b.height !== BAR_SIZE.height) return; // still in countdown mode
    const w = Math.round(Math.min(1400, Math.max(420, width)));
    if (w === b.width) return;
    const wa = screen.getDisplayMatching(b).workArea;
    const cx = b.x + b.width / 2;
    const x = Math.round(Math.min(wa.x + wa.width - w, Math.max(wa.x, cx - w / 2)));
    barWin.setBounds({ x, y: b.y, width: w, height: BAR_SIZE.height });
  });
  ipcMain.on('bar:openStudio', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
}

// ---------------------------------------------------------------- app lifecycle

app.whenReady().then(async () => {
  // Old editor previews are only a cache.
  fsp.rm(path.join(os.tmpdir(), 'gravador-previas'), { recursive: true, force: true }).catch(() => {});
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => (
    ['media', 'display-capture'].includes(permission)
  ));

  await applyBundledDefaults();
  registerIpc();
  createMainWindow();
  registerShortcuts();
  setTimeout(resumeMdeUploads, 4000); // pick up uploads interrupted by a restart
});

app.on('second-instance', () => {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.focus();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

