// Cut editor. Removed spans really disappear: the timeline shows the final
// video (kept pieces back to back, plus "a few moments later" transitions).
// Each seam is a marker you can click to restore what was cut there or to add
// a transition. Playback uses two <video> elements in turns so seams play
// without a stall, and the audio can be delayed to fix lip sync.

import { icon } from './icons.js';

const $ = (s, root = document) => root.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RULER = 24;
const MAX_PPS = 400;
const BIN = 0.02; // waveform resolution (s)
const SPEEDS = [1, 1.5, 2, 3, 4];

function fmt(t) {
  const s = Math.max(0, Math.floor(t + 1e-6));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

function fmtLen(t) {
  if (t < 60) return `${t.toFixed(1).replace('.', ',')} s`;
  return fmt(t);
}

export class Cutter {
  constructor(opts) {
    Object.assign(this, opts); // api, toast, confirm, getIntro, getTransition, getFps, getAudioDelay, onExport, onClose, onSetupIntro, onSetupTransition
    this.el = $('#cutter');
    this.players = [$('#cut-video'), $('#cut-video-b')];
    this.clip = $('#cut-video-t');
    // Sound comes from one <audio> element that trails the picture by the
    // lip-sync delay; the video players stay muted. (Routing several players
    // through Web Audio made Chromium drop most frames and stall.)
    this.audio = $('#cut-audio');
    for (const v of this.players) v.muted = true;
    this.thumbVideo = $('#cut-thumb-video');
    this.scroller = $('#cut-scroller');
    this.inner = $('#cut-inner');
    this.canvas = $('#cut-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.bubble = $('#cut-bubble');
    this.hoverBox = $('#cut-hover');
    this.thumbCanvas = $('#cut-hover canvas');
    this.pop = $('#cut-pause-pop');
    this.syncPop = $('#cut-sync-pop');
    this.p = null;
    this.pps = 10;
    this.fitMode = true;
    this.speedIdx = 0;
    this.playing = false;
    this.seq = [];
    this.seams = [];
    this.outDur = 0;
    this.bind();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  get active() {
    return this.players[this.cur];
  }

  // ---------------------------------------------------------------- open / close

  async open(project) {
    this.p = project;
    this.history = [];
    this.future = [];
    this.sel = null;
    this.focus = -1;
    this.candidates = null;
    this.hover = null;
    this.drag = null;
    this.t = 0;
    this.cur = 0;
    this.item = 0;
    this.playing = false;
    this.fps = this.getFps() || 30;
    this.duration = project.duration || 0;
    this.wave = null;
    this.db = null;
    this.sdb = null;
    this.waveState = 'loading';
    const { intro, enabled } = this.getIntro(project);
    this.introApplied = !!project.introApplied;
    this.intro = this.introApplied ? null : intro;
    this.useIntro = !!this.intro && enabled;
    this.trans = this.getTransition(project);
    this.audioDelay = Number.isFinite(project.audioDelay) ? project.audioDelay : this.getAudioDelay();
    this.fitMode = true;
    this.speedIdx = 0;

    const tracks = (project.tracks || []).length;
    const notes = [];
    if (tracks) notes.push(`+ ${tracks === 2 ? 'câmera e tela separadas' : 'arquivo separado'} com os mesmos cortes`);
    if (project.editingFinal) notes.push('editando o vídeo final (os originais já foram descartados)');
    $('#cut-title-input').value = project.title || project.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    $('#cut-file').textContent = notes.join(' · ');
    $('#cut-file').title = project.path;
    $('.cut-player').style.aspectRatio = `${project.width || 16} / ${project.height || 9}`;
    $('#cut-discard').hidden = !project.original;
    $('#cut-speed').textContent = '1×';
    this.closePops();
    this.el.hidden = false;
    document.body.classList.add('editing');

    this.videoUrl = null;
    for (const v of [...this.players, this.thumbVideo, this.audio]) v.src = project.url;
    if (this.trans) this.clip.src = this.trans.url;
    else this.clip.removeAttribute('src');
    for (const v of [...this.players, this.clip, this.audio]) v.playbackRate = 1;
    const A = this.players[0];
    await new Promise((res) => {
      if (A.readyState >= 1) res();
      else A.addEventListener('loadedmetadata', res, { once: true });
      A.addEventListener('error', res, { once: true });
    });
    if (!this.duration && Number.isFinite(A.duration)) this.duration = A.duration;
    this.removed = this.normalize(project.removed || []);
    this.inserts = [...(project.inserts || [])];
    this.applyDelay();
    this.buildSeq();
    this.resize();
    this.show(0);
    this.seek(0);
    this.renderAll();
    this.loadWaveform();
    this.pendingPreview = null;
    const useWhenReady = (url) => {
      if (this.p !== project || !url) return;
      this.pendingPreview = url;
      if (!this.playing) this.usePreview();
    };
    this.api.media.previewVideo(project.path).then(useWhenReady)
      .then(() => this.api.media.proxyVideo(project.path)).then(useWhenReady).catch(() => {});
  }

  usePreview() {
    const url = this.pendingPreview;
    if (!url) return;
    this.pendingPreview = null;
    this.videoUrl = url;
    for (const v of [...this.players, this.thumbVideo]) v.src = url;
    this.players[0].addEventListener('loadedmetadata', () => this.seek(this.t), { once: true });
  }

  close() {
    this.pause();
    for (const v of [...this.players, this.clip, this.thumbVideo, this.audio]) {
      v.removeAttribute('src');
      v.load();
    }
    this.closePops();
    this.el.hidden = true;
    document.body.classList.remove('editing');
    this.p = null;
  }

  // Windows keeps files open by a <video> locked: let go of them while the
  // export replaces the final file or moves the originals to the Recycle Bin.
  releaseMedia() {
    this.pause();
    for (const v of [...this.players, this.clip, this.thumbVideo, this.audio]) {
      v.removeAttribute('src');
      v.load();
    }
  }

  restoreMedia() {
    if (!this.p) return;
    for (const v of [this.thumbVideo, this.audio]) v.src = this.p.url;
    for (const v of this.players) v.src = this.videoUrl || this.p.url;
    if (this.trans) this.clip.src = this.trans.url;
    this.players[0].addEventListener('loadedmetadata', () => this.seek(this.t), { once: true });
  }

  refreshIntro() {
    if (!this.p) return;
    if (!this.introApplied) {
      const { intro, enabled } = this.getIntro(this.p);
      const changed = (intro && intro.url) !== (this.intro && this.intro.url);
      this.intro = intro;
      if (!intro) this.useIntro = false;
      else if (changed) this.useIntro = enabled;
    }
    const trans = this.getTransition(this.p);
    if ((trans && trans.url) !== (this.trans && this.trans.url)) {
      this.trans = trans;
      if (trans) this.clip.src = trans.url;
      this.buildSeq();
      this.resize();
    }
    $('#cut-intro').dataset.sig = '';
    this.renderAll();
  }

  async loadWaveform() {
    const project = this.p;
    if (project.hasAudio === false) {
      this.waveState = 'none';
      this.renderAll();
      return;
    }
    try {
      const buf = await this.api.media.waveform(project.path);
      if (this.p !== project) return;
      this.wave = new Float32Array(buf);
      this.db = new Float32Array(this.wave.length);
      for (let i = 0; i < this.wave.length; i++) this.db[i] = 20 * Math.log10(Math.max(this.wave[i], 1e-7));
      this.waveState = 'ready';
    } catch {
      this.waveState = 'none';
    }
    this.renderAll();
  }

  // ---------------------------------------------------------------- audio (lip sync preview)

  // Keeps the sound with the picture that is actually on screen (frame
  // callbacks say when each frame is shown). Small drifts are absorbed by
  // nudging the audio's speed, which is inaudible; only big jumps seek.
  syncAudio(force = false) {
    const it = this.seq[this.item];
    const au = this.audio;
    if (!this.playing || !it || it.t !== 's') {
      if (!au.paused) au.pause();
      return;
    }
    const rate = SPEEDS[this.speedIdx];
    const now = performance.now();
    const f = this.lastFrame;
    const shown = f && f.v === this.active && now - f.at < 250 ? f.media + ((now - f.at) / 1000) * rate : this.active.currentTime;
    const want = shown - this.audioDelay / 1000;
    if (want < 0) {
      if (!au.paused) au.pause(); // the first moments: the delayed audio has not started yet
      return;
    }
    const drift = au.currentTime - want;
    if (force || Math.abs(drift) > 0.15) {
      au.currentTime = want;
      au.playbackRate = rate;
    } else {
      au.playbackRate = Math.abs(drift) < 0.01 ? rate : rate * (1 - clamp(drift * 2, -0.06, 0.06));
    }
    if (au.paused) au.play().catch(() => {});
  }

  applyDelay() {
    if (this.seq && this.seq.length && this.p) setTimeout(() => this.seek(this.t), 0);
    if (this.playing) this.syncAudio(true);
    const ms = this.audioDelay;
    const label = ms ? `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms` : '0 ms';
    $('#cut-sync').innerHTML = `${icon('speaker', 15)} ${ms ? label : 'Sincronia'}`;
    const input = $('#cut-sync-ms');
    input.value = ms;
    input.style.setProperty('--p', `${((ms - input.min) / (input.max - input.min)) * 100}%`);
    $('#cut-sync-val').textContent = label;
  }

  // ---------------------------------------------------------------- time math

  snap(t) {
    return clamp(Math.round(t * this.fps) / this.fps, 0, this.duration);
  }

  normalize(list) {
    const minLen = 1 / this.fps;
    const sorted = list
      .map(([a, b]) => [clamp(Math.min(a, b), 0, this.duration), clamp(Math.max(a, b), 0, this.duration)])
      .filter(([a, b]) => b - a >= minLen * 0.5)
      .sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + minLen) last[1] = Math.max(last[1], r[1]);
      else out.push([...r]);
    }
    return out;
  }

  keptRanges() {
    const out = [];
    let cur = 0;
    for (const [a, b] of this.removed) {
      if (a > cur) out.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (cur < this.duration) out.push([cur, this.duration]);
    return out.filter(([a, b]) => b - a >= 1 / this.fps);
  }

  transDur() {
    return this.trans ? Math.min(3, this.trans.duration) : 0;
  }

  // Output sequence: [{ t:'s', a, b, o0, o1 } | { t:'x', at, o0, o1 }]
  buildSeq() {
    const half = 0.5 / this.fps;
    const T = this.transDur();
    const ins = [...this.inserts].sort((x, y) => x - y);
    const items = [];
    let o = 0;
    for (const [a, b] of this.keptRanges()) {
      let start = a;
      const splits = ins.filter((p) => p > a + half && p < b - half);
      for (const p of [...splits, b]) {
        items.push({ t: 's', a: start, b: p, o0: o, o1: o + (p - start) });
        o += p - start;
        if (T && ins.some((x) => Math.abs(x - p) < half)) {
          items.push({ t: 'x', at: p, o0: o, o1: o + T });
          o += T;
        }
        start = p;
      }
    }
    while (items.length && items[items.length - 1].t === 'x') {
      o -= T;
      items.pop();
    }
    this.seq = items;
    this.outDur = o;
    // Seams: where one piece ends and the next item begins.
    this.seams = [];
    items.forEach((it, i) => {
      if (it.t !== 's' || i === items.length - 1) return;
      const removedIdx = this.removed.findIndex(([x]) => Math.abs(x - it.b) < half);
      this.seams.push({
        o: it.o1,
        at: it.b,
        removedIdx,
        transIdx: items[i + 1].t === 'x' ? i + 1 : -1,
        split: removedIdx < 0, // a seam made only by a transition
      });
    });
  }

  itemIndexAt(t) {
    const s = this.seq;
    if (!s.length) return -1;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid].o0 <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  srcOf(t) {
    const it = this.seq[this.itemIndexAt(t)];
    if (!it || it.t !== 's') return null;
    return it.a + clamp(t - it.o0, 0, it.b - it.a);
  }

  outOfSrc(src) {
    for (const it of this.seq) if (it.t === 's' && src >= it.a && src < it.b) return it.o0 + (src - it.a);
    return null;
  }

  introDur() {
    return this.useIntro && this.intro ? this.intro.duration : 0;
  }

  finalDuration() {
    return this.introDur() + this.outDur;
  }

  // ---------------------------------------------------------------- edits (with undo)

  snapshot() {
    return JSON.stringify({ removed: this.removed, inserts: this.inserts });
  }

  restoreSnapshot(json) {
    const s = JSON.parse(json);
    this.removed = s.removed;
    this.inserts = s.inserts;
    this.sel = null;
    this.focus = -1;
    this.afterEdit(this.t);
  }

  afterEdit(t) {
    this.buildSeq();
    const keepFit = this.fitMode;
    if (keepFit) this.setPps(this.fitPps(), 0);
    else this.setPps(this.pps, this.scroller.scrollLeft);
    this.seek(Math.min(t, this.outDur));
    this.renderAll();
  }

  apply(next, message, t = this.t) {
    const removed = this.normalize(next.removed);
    const keptLen = this.duration - removed.reduce((s, [a, b]) => s + (b - a), 0);
    if (keptLen < 0.5) {
      this.toast('Não dá para remover o vídeo inteiro.', 'error');
      return false;
    }
    this.history.push(this.snapshot());
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.removed = removed;
    this.inserts = next.inserts;
    this.sel = null;
    this.focus = -1;
    this.afterEdit(t);
    if (message) this.toast(message, 'ok', 2500);
    return true;
  }

  // Removes an output span (it may cross several pieces and transitions).
  removeOut(oa, ob, message) {
    const removed = [...this.removed];
    let inserts = [...this.inserts];
    for (const it of this.seq) {
      const a = Math.max(oa, it.o0);
      const b = Math.min(ob, it.o1);
      if (b - a <= 1e-6) continue;
      if (it.t === 's') removed.push([this.snap(it.a + (a - it.o0)), this.snap(it.a + (b - it.o0))]);
      else inserts = inserts.filter((x) => Math.abs(x - it.at) > 0.5 / this.fps);
    }
    this.apply({ removed, inserts }, message, oa);
  }

  removeSelection() {
    if (this.sel) this.removeOut(this.sel.a, this.sel.b);
  }

  removeBefore() {
    if (this.t <= 0) return;
    this.removeOut(0, this.t, `Início cortado (${fmtLen(this.t)}).`);
  }

  removeAfter() {
    if (this.t >= this.outDur) return;
    this.removeOut(this.t, this.outDur, `Final cortado (${fmtLen(this.outDur - this.t)}).`);
  }

  restoreSeam(seam) {
    if (!seam || seam.removedIdx < 0) return;
    const [a, b] = this.removed[seam.removedIdx];
    this.apply({ removed: this.removed.filter((_, i) => i !== seam.removedIdx), inserts: this.inserts }, `Trecho de ${fmtLen(b - a)} restaurado.`, seam.o);
  }

  toggleTransition(seam) {
    if (!this.trans) {
      this.toast('Defina primeiro o vídeo de transição em Configurações.', 'info', 6000, { label: 'Configurar', onClick: () => this.onSetupTransition() });
      return;
    }
    const half = 0.5 / this.fps;
    const has = this.inserts.some((x) => Math.abs(x - seam.at) < half);
    const inserts = has ? this.inserts.filter((x) => Math.abs(x - seam.at) >= half) : [...this.inserts, seam.at];
    this.apply({ removed: this.removed, inserts }, null, seam.o ?? this.t);
  }

  // "Transição" button / T key: on a seam toggles it, elsewhere splits at the playhead.
  transitionAtPlayhead() {
    const near = this.seams.find((s) => Math.abs(s.o - this.t) * this.pps < 8 || Math.abs(s.o - this.t) < 0.05);
    if (near) {
      this.toggleTransition(near);
      return;
    }
    const src = this.srcOf(this.t);
    if (src != null) this.toggleTransition({ at: this.snap(src), o: this.t });
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(this.snapshot());
    this.restoreSnapshot(this.history.pop());
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(this.snapshot());
    this.restoreSnapshot(this.future.pop());
  }

  // ---------------------------------------------------------------- pause detection

  // Loudness over a 240 ms window: short dips between syllables don't count as
  // pauses, and quiet background (room noise, a faint video) does.
  smoothedDb() {
    if (this.sdb) return this.sdb;
    const rms = this.wave;
    const n = rms.length;
    const half = 6;
    const acc = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) acc[i + 1] = acc[i] + rms[i] * rms[i];
    this.sdb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(n, i + half);
      this.sdb[i] = 10 * Math.log10(Math.max((acc[b] - acc[a]) / (b - a), 1e-14));
    }
    return this.sdb;
  }

  detectPauses(minPause) {
    if (!this.wave || this.wave.length < 10) return [];
    const db = this.smoothedDb();
    const sorted = Float32Array.from(db).sort();
    const noise = sorted[Math.floor(sorted.length * 0.1)];
    const speech = sorted[Math.floor(sorted.length * 0.9)];
    if (speech - noise < 10) return [];
    const thr = Math.max(noise + 8, speech - 14);
    const pad = 0.2;
    const out = [];
    let start = -1;
    const n = db.length;
    for (let i = 0; i <= n; i++) {
      const loud = i < n && db[i] > thr;
      if (!loud && start < 0 && i < n) start = i;
      if ((loud || i === n) && start >= 0) {
        const t0 = start * BIN;
        const t1 = Math.min(i * BIN, this.duration);
        if (t1 - t0 >= minPause) {
          // Word endings (a final "s", breath-out) trail off quietly: keep 300 ms
          // after speech and 150 ms before it starts again.
          const a = t0 <= 0.05 ? 0 : t0 + pad + 0.1;
          const b = t1 >= this.duration - 0.05 ? this.duration : t1 - 0.15;
          if (b - a >= 0.2) out.push([this.snap(a), this.snap(b)]);
        }
        start = -1;
      }
    }
    return out.filter(([a, b]) => !this.removed.some(([x, y]) => a >= x && b <= y));
  }

  openPausePop() {
    if (this.waveState !== 'ready') {
      this.toast(this.waveState === 'loading' ? 'Aguarde: analisando o áudio…' : 'Este vídeo não tem áudio para detectar pausas.');
      return;
    }
    this.syncPop.hidden = true;
    this.pop.hidden = false;
    this.updatePop();
  }

  closePops() {
    this.pop.hidden = true;
    this.syncPop.hidden = true;
    this.candidates = null;
    this.requestDraw();
  }

  updatePop() {
    const input = $('#cut-pause-min');
    const min = Number(input.value);
    input.style.setProperty('--p', `${((min - 0.5) / 2.5) * 100}%`);
    $('#cut-pause-val').textContent = `${min.toFixed(1).replace('.', ',')} s`;
    this.candidates = this.detectPauses(min);
    const total = this.candidates.reduce((s, [a, b]) => s + (b - a), 0);
    $('#cut-pause-result').innerHTML = this.candidates.length
      ? `<b>${this.candidates.length}</b> ${this.candidates.length === 1 ? 'pausa encontrada' : 'pausas encontradas'} · <b>−${fmtLen(total)}</b>`
      : 'Nenhuma pausa desse tamanho.';
    $('#cut-pause-apply').disabled = !this.candidates.length;
    this.requestDraw();
  }

  applyPauses() {
    const list = this.candidates || [];
    if (!list.length) return;
    const total = list.reduce((s, [a, b]) => s + (b - a), 0);
    this.closePops();
    this.apply(
      { removed: [...this.removed, ...list], inserts: this.inserts },
      `${list.length} ${list.length === 1 ? 'pausa removida' : 'pausas removidas'} (−${fmtLen(total)}). Ctrl+Z desfaz.`,
      0,
    );
  }

  // ---------------------------------------------------------------- playback (two players in turns)

  show(el) {
    const target = typeof el === 'number' ? this.players[el] : el;
    for (const v of [...this.players, this.clip]) v.classList.toggle('on', v === target);
  }

  // Cuts live in audio time (the waveform). The camera delivers frames late by
  // the lip-sync delay, so the picture is read that much ahead of the sound.
  get vOff() {
    return this.audioDelay / 1000;
  }

  vt(src) {
    return Math.max(0, src + this.vOff);
  }

  // Cue the idle player at the start of the next piece, so the seam is instant.
  prepareNext() {
    const idle = this.players[1 - this.cur];
    const cur = this.seq[this.item];
    for (let i = this.item + 1; i < this.seq.length; i++) {
      const it = this.seq[i];
      if (it.t !== 's') continue;
      if (cur && cur.t === 's' && Math.abs(it.a - cur.b) < 1 / this.fps) return; // continuous: same player
      if (Math.abs(idle.currentTime - this.vt(it.a)) > 0.04) idle.currentTime = this.vt(it.a);
      return;
    }
  }

  seek(t) {
    this.stopReverse();
    if (this.prerolled) { this.prerolled.pause(); this.prerolled = null; }
    this.t = clamp(t, 0, this.outDur);
    const idx = Math.max(0, this.itemIndexAt(Math.min(this.t, Math.max(0, this.outDur - 1e-3))));
    const it = this.seq[idx];
    this.item = idx;
    if (it) {
      if (it.t === 's') {
        const v = this.active;
        v.currentTime = this.vt(it.a + clamp(this.t - it.o0, 0, it.b - it.a));
        this.show(v);
        if (this.playing) {
          this.clip.pause();
          v.play().catch(() => {});
        }
      } else {
        this.clip.currentTime = clamp(this.t - it.o0, 0, it.o1 - it.o0);
        this.show(this.clip);
        if (this.playing) {
          this.active.pause();
          this.clip.play().catch(() => {});
        }
      }
      this.prepareNext();
      if (this.playing) {
        this.watchFrames();
        this.syncAudio(true);
      }
    }
    this.renderTime();
    this.requestDraw(false);
  }

  togglePlay() {
    if (this.playing || this.reverseTimer) this.pause();
    else this.play();
  }

  play() {
    if (!this.seq.length) return;
    this.stopReverse();
    if (this.t >= this.outDur - 0.05) this.seek(0);
    this.playing = true;
    const it = this.seq[this.item];
    (it && it.t === 'x' ? this.clip : this.active).play().catch(() => {});
    this.syncAudio(true);
    this.watchFrames();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 40);
    this.renderPlay();
  }

  pause() {
    this.stopReverse();
    this.playing = false;
    this.prerolled = null;
    clearInterval(this.timer);
    for (const v of [...this.players, this.clip, this.audio]) v.pause();
    this.clip.volume = 1;
    this.renderPlay();
    this.renderTime();
    if (this.pendingPreview) this.usePreview();
  }

  // ---- J / K / L (shuttle): L plays faster on each press, J plays backwards, K stops.
  setSpeed(idx, flash = true) {
    this.speedIdx = clamp(idx, 0, SPEEDS.length - 1);
    const rate = SPEEDS[this.speedIdx];
    for (const v of [...this.players, this.clip, this.audio]) v.playbackRate = rate;
    $('#cut-speed').textContent = `${String(rate).replace('.', ',')}×`;
    if (flash) this.flashRate(`${String(rate).replace('.', ',')}×`);
  }

  flashRate(text) {
    const el = $('#cut-rate-flag');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { el.hidden = true; }, 900);
  }

  shuttleForward() {
    if (this.reverseTimer) { this.stopReverse(); this.setSpeed(0); this.play(); return; }
    if (!this.playing) { this.setSpeed(0); this.play(); return; }
    this.setSpeed(this.speedIdx + 1);
  }

  shuttleBack() {
    if (this.playing) this.pause();
    this.reverseRate = this.reverseTimer ? Math.min(8, this.reverseRate * 2) : 2;
    this.flashRate(`◀◀ ${this.reverseRate}×`);
    if (this.reverseTimer) return;
    this.reverseTimer = setInterval(() => {
      const t = this.t - 0.1 * this.reverseRate;
      if (t <= 0) { this.seek(0); return; }
      const keep = this.reverseTimer;
      this.reverseTimer = null; // seek() would stop the shuttle
      this.seek(t);
      this.reverseTimer = keep;
    }, 100);
    this.renderPlay();
  }

  stopReverse() {
    if (!this.reverseTimer) return;
    clearInterval(this.reverseTimer);
    this.reverseTimer = null;
    this.renderPlay();
  }

  // Frame-accurate seams: switch right after the last kept frame is shown.
  watchFrames() {
    const v = this.active;
    if (!v.requestVideoFrameCallback || this.watching === v) return;
    this.watching = v;
    const onFrame = (_now, meta) => {
      if (!this.playing || v !== this.active) { this.watching = null; return; }
      this.lastFrame = { v, media: meta.mediaTime, at: meta.expectedDisplayTime };
      const it = this.seq[this.item];
      if (it && it.t === 's' && meta.mediaTime - this.vOff >= it.b - 1.5 / this.fps) {
        this.watching = null;
        this.advance();
        return;
      }
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  advance() {
    const nextIdx = this.item + 1;
    const cur = this.seq[this.item];
    const nx = this.seq[nextIdx];
    if (!nx) {
      this.pause();
      this.t = this.outDur;
      return;
    }
    if (nx.t === 's') {
      if (cur.t === 's' && Math.abs(nx.a - cur.b) < 1 / this.fps) {
        this.item = nextIdx; // continuous: keep playing on the same player
      } else {
        const idle = this.players[1 - this.cur];
        if (Math.abs(idle.currentTime - this.vt(nx.a)) > 0.04) idle.currentTime = this.vt(nx.a);
        idle.play().catch(() => {});
        this.prerolled = null;
        this.show(idle);
        this.active.pause();
        this.clip.pause();
        this.cur = 1 - this.cur;
        this.item = nextIdx;
        this.watchFrames();
      }
      this.syncAudio(true);
    } else {
      this.clip.currentTime = 0;
      this.clip.volume = 1;
      this.clip.play().catch(() => {});
      this.prerolled = null;
      this.show(this.clip);
      this.active.pause();
      this.item = nextIdx;
      this.syncAudio();
    }
    this.prepareNext();
  }

  // Wake the next player shortly before the seam (Chromium lets idle players
  // sleep): play it briefly at the first frame of the next piece and park it
  // there, so it starts instantly when the current piece ends.
  preroll(it, remaining) {
    const lead = 0.4 + 0.5 * SPEEDS[this.speedIdx];
    if (this.prerolled || remaining > lead) return;
    const nx = this.seq[this.item + 1];
    if (nx && nx.t === 'x') {
      this.prerolled = this.clip;
      this.clip.volume = 0;
      this.clip.currentTime = 0;
      this.clip.play().catch(() => {});
      return;
    }
    if (!nx || nx.t !== 's' || Math.abs(nx.a - it.b) < 1 / this.fps) return;
    const idle = this.players[1 - this.cur];
    const start = this.vt(nx.a);
    this.prerolled = idle;
    if (remaining < 0.25) {
      if (Math.abs(idle.currentTime - start) > 0.04) idle.currentTime = start; // no time to warm: just cue
      return;
    }
    idle.currentTime = start;
    idle.play().catch(() => {});
    const park = () => {
      if (this.prerolled !== idle || idle === this.active) return;
      idle.pause();
      idle.currentTime = start;
    };
    if (idle.requestVideoFrameCallback) idle.requestVideoFrameCallback(park);
    else setTimeout(park, 120);
  }

  // Runs on a timer (keeps going even if the window is covered); the
  // frame callback above handles seams precisely while the video is visible.
  tick() {
    if (!this.playing || !this.isOpen) return;
    const it = this.seq[this.item];
    if (it) {
      if (it.t === 's') {
        const src = this.active.currentTime - this.vOff;
        this.t = it.o0 + clamp(src - it.a, 0, it.b - it.a);
        if (src >= it.b - 0.5 / this.fps || this.active.ended) this.advance();
        else {
          this.syncAudio();
          this.preroll(it, (it.b - src) / SPEEDS[this.speedIdx]);
        }
      } else {
        this.t = it.o0 + this.clip.currentTime;
        if (this.clip.currentTime >= it.o1 - it.o0 - 0.03 || this.clip.ended) this.advance();
      }
    }
    const x = (this.t - this.viewStart) * this.pps;
    if (x > this.viewW - 40 || x < 0) this.scroller.scrollLeft = Math.max(0, this.t * this.pps - this.viewW * 0.2);
    this.renderTime();
    this.requestDraw(false);
  }

  // ---------------------------------------------------------------- zoom / layout

  resize() {
    const w = this.scroller.clientWidth;
    const h = this.canvas.parentElement.clientHeight || 120;
    const dpr = window.devicePixelRatio || 1;
    this.viewW = w;
    this.viewH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.fitMode || this.pps < this.fitPps()) this.setPps(this.fitPps(), 0);
    else this.setPps(this.pps, this.t * this.pps - w / 2);
  }

  fitPps() {
    return this.outDur > 0 ? Math.max(0.01, (this.viewW - 2) / this.outDur) : 10;
  }

  setPps(pps, scrollLeft) {
    this.pps = clamp(pps, this.fitPps(), Math.max(MAX_PPS, this.fitPps()));
    this.fitMode = Math.abs(this.pps - this.fitPps()) < 1e-6;
    this.inner.style.width = `${Math.ceil(this.outDur * this.pps)}px`;
    this.scroller.scrollLeft = scrollLeft;
    this.onScroll();
  }

  zoomAt(factor, x) {
    const t = this.viewStart + x / this.pps;
    const pps = clamp(this.pps * factor, this.fitPps(), MAX_PPS);
    this.setPps(pps, t * pps - x);
  }

  onScroll() {
    this.viewStart = this.scroller.scrollLeft / this.pps;
    this.canvas.style.left = `${this.scroller.scrollLeft}px`;
    this.requestDraw();
    this.renderBubble();
  }

  xOf(t) {
    return (t - this.viewStart) * this.pps;
  }

  tOf(x) {
    return clamp(this.viewStart + x / this.pps, 0, this.outDur);
  }

  snapOut(t) {
    return clamp(Math.round(t * this.fps) / this.fps, 0, this.outDur);
  }

  seamAt(x) {
    let best = -1;
    let dist = 7;
    this.seams.forEach((s, i) => {
      const d = Math.abs(this.xOf(s.o) - x);
      if (d < dist) { dist = d; best = i; }
    });
    if (best >= 0) return best;
    // clicking a transition block focuses its seam
    const t = this.tOf(x);
    return this.seams.findIndex((s) => s.transIdx >= 0 && t >= this.seq[s.transIdx].o0 && t <= this.seq[s.transIdx].o1);
  }

  // ---------------------------------------------------------------- events

  bind() {
    this.scroller.addEventListener('scroll', () => this.onScroll());
    new ResizeObserver(() => { if (this.isOpen) this.resize(); }).observe(this.scroller);
    for (const v of [...this.players, this.clip]) v.addEventListener('click', () => this.togglePlay());

    const c = this.scroller;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.hoverBox.hidden = true; this.requestDraw(); } });
    c.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.zoomAt(Math.exp(-e.deltaY * 0.002), this.local(e).x);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !this.fitMode) {
        e.preventDefault();
        c.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    this.thumbVideo.addEventListener('seeked', () => {
      this.thumbCanvas.getContext('2d').drawImage(this.thumbVideo, 0, 0, this.thumbCanvas.width, this.thumbCanvas.height);
      if (this.pendingThumb != null) {
        const t = this.pendingThumb;
        this.pendingThumb = null;
        this.thumbVideo.currentTime = t;
      }
    });

    this.bubble.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bubble.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const seam = this.seams[this.focus];
      if (act === 'remove') this.removeSelection();
      else if (act === 'clear') { this.sel = null; this.renderAll(); }
      else if (act === 'restore') this.restoreSeam(seam);
      else if (act === 'transition' && seam) this.toggleTransition(seam);
    });

    $('#cut-play').addEventListener('click', () => this.togglePlay());
    $('#cut-speed').addEventListener('click', () => {
      this.setSpeed((this.speedIdx + 1) % SPEEDS.length);
    });
    $('#cut-sync').addEventListener('click', () => {
      const open = this.syncPop.hidden;
      this.closePops();
      this.syncPop.hidden = !open;
    });
    $('#cut-sync-ms').addEventListener('input', (e) => {
      this.audioDelay = Number(e.target.value);
      this.applyDelay();
    });
    $('#cut-sync-reset').addEventListener('click', () => {
      this.audioDelay = 0;
      this.applyDelay();
    });
    $('#cut-remove').addEventListener('click', () => this.removeSelection());
    $('#cut-trim-start').addEventListener('click', () => this.removeBefore());
    $('#cut-trim-end').addEventListener('click', () => this.removeAfter());
    $('#cut-transition').addEventListener('click', () => this.transitionAtPlayhead());
    $('#cut-pauses').addEventListener('click', () => (this.pop.hidden ? this.openPausePop() : this.closePops()));
    $('#cut-pause-min').addEventListener('input', () => this.updatePop());
    $('#cut-pause-apply').addEventListener('click', () => this.applyPauses());
    $('#cut-pause-cancel').addEventListener('click', () => this.closePops());
    $('#cut-undo').addEventListener('click', () => this.undo());
    $('#cut-redo').addEventListener('click', () => this.redo());
    $('#cut-zoom-in').addEventListener('click', () => this.zoomAt(1.8, this.xOf(this.t)));
    $('#cut-zoom-out').addEventListener('click', () => this.zoomAt(1 / 1.8, this.xOf(this.t)));
    $('#cut-zoom-fit').addEventListener('click', () => this.setPps(this.fitPps(), 0));

    $('#cut-export').addEventListener('click', () => this.exportNow());
    $('#cut-back').addEventListener('click', () => this.leave());
    $('#cut-discard').addEventListener('click', () => this.discard());
    $('#cut-intro').addEventListener('click', (e) => {
      if (e.target.closest('[data-intro-setup]')) { this.onSetupIntro(); return; }
      const sw = e.target.closest('input[type=checkbox]');
      if (sw) { this.useIntro = sw.checked; this.renderAll(); }
    });

    document.addEventListener('keydown', (e) => this.key(e));
  }

  local(e) {
    const r = this.scroller.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  down(e) {
    if (e.button !== 0 || !this.outDur) return;
    const { x, y } = this.local(e);
    if (y > this.viewH) return; // native scrollbar
    this.closePops();
    const t = this.tOf(x);
    if (y < RULER) {
      this.drag = { mode: 'scrub' };
      this.seek(t);
    } else if (this.sel && Math.abs(x - this.xOf(this.sel.a)) < 7) {
      this.drag = { mode: 'edge', edge: 'a' };
    } else if (this.sel && Math.abs(x - this.xOf(this.sel.b)) < 7) {
      this.drag = { mode: 'edge', edge: 'b' };
    } else {
      this.drag = { mode: 'select', anchor: this.snapOut(t), startX: x, moved: false };
    }
    this.scroller.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  move(e) {
    const { x, y } = this.local(e);
    const t = this.tOf(x);
    this.hover = { x, t };
    this.showThumb(x, t);
    const d = this.drag;
    if (!d) {
      const nearEdge = this.sel && y >= RULER && (Math.abs(x - this.xOf(this.sel.a)) < 7 || Math.abs(x - this.xOf(this.sel.b)) < 7);
      const nearSeam = y >= RULER && this.seamAt(x) >= 0;
      this.scroller.style.cursor = y < RULER ? 'pointer' : nearEdge ? 'ew-resize' : nearSeam ? 'pointer' : 'text';
      this.requestDraw(false);
      return;
    }
    if (d.mode === 'scrub') {
      this.seek(t);
    } else if (d.mode === 'edge') {
      const v = this.snapOut(t);
      if (d.edge === 'a') this.sel.a = v;
      else this.sel.b = v;
      if (this.sel.a > this.sel.b) {
        [this.sel.a, this.sel.b] = [this.sel.b, this.sel.a];
        d.edge = d.edge === 'a' ? 'b' : 'a';
      }
      this.renderSelection();
    } else if (d.mode === 'select') {
      if (!d.moved && Math.abs(x - d.startX) < 4) return;
      d.moved = true;
      const v = this.snapOut(t);
      this.sel = { a: Math.min(d.anchor, v), b: Math.max(d.anchor, v) };
      this.focus = -1;
      if (this.playing) this.pause();
      this.seek(v);
      this.renderSelection();
    }
  }

  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.scroller.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (d.mode === 'select' && !d.moved) {
      const { x } = this.local(e);
      this.sel = null;
      this.focus = this.seamAt(x);
      this.seek(this.focus >= 0 ? this.seams[this.focus].o : this.tOf(x));
    } else if (this.sel && this.sel.b - this.sel.a < 1 / this.fps) {
      this.sel = null;
    }
    this.renderAll();
  }

  key(e) {
    if (!this.isOpen) return;
    if (document.querySelector('.backdrop:not([hidden]), .busy:not([hidden])')) return;
    if (e.target.matches('input[type=text], textarea, select')) return;
    const k = e.key;
    const lower = k.toLowerCase();
    const frame = 1 / this.fps;
    let handled = true;
    // A focused button would also "click" on Space; the editor owns that key.
    if (e.target instanceof HTMLButtonElement) e.target.blur();
    if (k === ' ') this.togglePlay();
    else if (!e.ctrlKey && lower === 'l') this.shuttleForward();
    else if (!e.ctrlKey && lower === 'k') { this.pause(); this.setSpeed(0, false); }
    else if (!e.ctrlKey && lower === 'j') this.shuttleBack();
    else if (k === 'ArrowLeft') this.seek(this.t - (e.shiftKey ? 5 : 1));
    else if (k === 'ArrowRight') this.seek(this.t + (e.shiftKey ? 5 : 1));
    else if (k === ',') this.seek(this.t - frame);
    else if (k === '.') this.seek(this.t + frame);
    else if (k === 'Home') this.seek(0);
    else if (k === 'End') this.seek(this.outDur);
    else if (k === 'Delete' || k === 'Backspace') {
      if (this.sel) this.removeSelection();
      else if (this.focus >= 0) this.restoreSeam(this.seams[this.focus]);
    } else if (e.ctrlKey && lower === 'z' && !e.shiftKey) this.undo();
    else if (e.ctrlKey && (lower === 'y' || (lower === 'z' && e.shiftKey))) this.redo();
    else if (!e.ctrlKey && lower === 'q') this.removeBefore();
    else if (!e.ctrlKey && lower === 'w') this.removeAfter();
    else if (!e.ctrlKey && lower === 't') this.transitionAtPlayhead();
    else if (!e.ctrlKey && lower === 'i') this.markSel('a');
    else if (!e.ctrlKey && lower === 'o') this.markSel('b');
    else if (k === 'Escape') {
      if (!this.pop.hidden || !this.syncPop.hidden) this.closePops();
      else { this.sel = null; this.focus = -1; this.renderAll(); }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  markSel(edge) {
    const t = this.snapOut(this.t);
    if (!this.sel) this.sel = edge === 'a' ? { a: t, b: this.outDur } : { a: 0, b: t };
    else this.sel[edge] = t;
    if (this.sel.a > this.sel.b) [this.sel.a, this.sel.b] = [this.sel.b, this.sel.a];
    this.focus = -1;
    this.renderAll();
  }

  showThumb(x, t) {
    if (!this.outDur) return;
    const box = this.hoverBox;
    box.hidden = false;
    const w = 168;
    box.style.left = `${clamp(x - w / 2, 0, this.viewW - w)}px`;
    const src = this.srcOf(t);
    $('#cut-hover-time').textContent = src == null ? `${fmt(t)} · transição` : fmt(t);
    if (src == null || this.playing) return; // seeking a second decoder while playing costs frames
    const now = performance.now();
    if (this.thumbVideo.seeking || now - (this.lastThumb || 0) < 90) { this.pendingThumb = this.vt(src); return; }
    this.lastThumb = now;
    this.thumbVideo.currentTime = this.vt(src);
  }

  // ---------------------------------------------------------------- actions

  title() {
    return $('#cut-title-input').value.trim().slice(0, 180) || this.p.title || 'Aula';
  }

  exportSeq() {
    return this.seq.map((it) => (it.t === 's'
      ? { t: 's', a: Number(it.a.toFixed(4)), b: Number(it.b.toFixed(4)) }
      : { t: 'x' }));
  }

  async exportNow() {
    this.releaseMedia();
    const ok = await this.onExport(this.p, {
      seq: this.exportSeq(),
      removed: this.removed,
      inserts: this.inserts,
      audioDelay: this.audioDelay,
      title: this.title(),
      intro: this.useIntro ? this.intro : null,
      transition: this.seq.some((it) => it.t === 'x') ? this.trans : null,
    });
    if (!ok && this.isOpen) this.restoreMedia();
  }

  async leave() {
    // Recordings keep their edits as a draft: nothing to lose, no question asked.
    if (this.p.folder) {
      await this.api.saveProject(this.p.folder, { removed: this.removed, inserts: this.inserts, audioDelay: this.audioDelay, title: this.title() }).catch(() => {});
      this.close();
      this.onClose('draft');
      return;
    }
    const ok = await this.confirm({
      title: 'Sair sem exportar?',
      text: 'Os cortes serão perdidos. O vídeo original continua intacto.',
      ok: 'Sair sem exportar',
      cancel: 'Continuar editando',
    });
    if (!ok) return;
    this.close();
    this.onClose('left');
  }

  async discard() {
    const ok = await this.confirm({
      title: 'Descartar esta gravação?',
      text: 'Os arquivos vão para a Lixeira do Windows.',
      ok: 'Descartar',
      cancel: 'Cancelar',
      danger: true,
    });
    if (!ok) return;
    const { path: file, folder } = this.p;
    this.close();
    if (folder) await this.api.gallery.trash({ kind: 'project', folder }).catch(() => {});
    else await this.api.trash(file).catch(() => {});
    this.onClose('discarded');
  }

  // ---------------------------------------------------------------- rendering

  renderAll() {
    this.renderTime();
    this.renderPlay();
    this.renderSelection();
    this.renderSummary();
    this.renderIntro();
    $('#cut-undo').disabled = !this.history.length;
    $('#cut-redo').disabled = !this.future.length;
    $('#cut-transition').classList.toggle('muted', !this.trans);
    this.requestDraw();
  }

  renderPlay() {
    $('#cut-play').innerHTML = icon(this.playing || this.reverseTimer ? 'pause' : 'play', 18);
    $('#cut-play').title = this.playing ? 'Pausar (Espaço)' : 'Reproduzir (Espaço)';
  }

  renderTime() {
    if (!this.p) return;
    $('#cut-time').textContent = `${fmt(this.introDur() + this.t)} / ${fmt(this.finalDuration())}`;
  }

  renderSummary() {
    const rem = this.removed.reduce((s, [a, b]) => s + (b - a), 0);
    const nT = this.seq.filter((it) => it.t === 'x').length;
    const parts = [`Duração final <b>${fmt(this.finalDuration())}</b>`];
    if (rem > 0) parts.push(`<span class="neg">−${fmtLen(rem)} cortados</span>`);
    if (nT) parts.push(`${nT} ${nT === 1 ? 'transição' : 'transições'}`);
    if (this.introDur()) parts.push(`intro ${fmtLen(this.introDur())}`);
    $('#cut-summary').innerHTML = parts.join(' · ');
  }

  renderSelection() {
    $('#cut-remove').disabled = !this.sel;
    this.renderBubble();
    this.requestDraw();
  }

  renderBubble() {
    const b = this.bubble;
    const seam = this.seams && this.seams[this.focus];
    if (this.sel && !(this.drag && this.drag.mode === 'scrub')) {
      b.innerHTML = `
        <span class="bub-len">${fmtLen(this.sel.b - this.sel.a)}</span>
        <button class="bub danger" data-act="remove">${icon('scissors', 14)} Remover trecho <kbd>Del</kbd></button>
        <button class="bub-x" data-act="clear" title="Cancelar seleção (Esc)">${icon('x', 14)}</button>`;
      this.placeBubble((this.xOf(this.sel.a) + this.xOf(this.sel.b)) / 2);
    } else if (seam) {
      const hasT = seam.transIdx >= 0;
      const removed = seam.removedIdx >= 0 ? this.removed[seam.removedIdx] : null;
      b.innerHTML = `
        ${removed ? `<span class="bub-len">Cortados ${fmtLen(removed[1] - removed[0])}</span>
        <button class="bub" data-act="restore">${icon('undo', 14)} Restaurar</button>` : ''}
        <button class="bub ${hasT ? '' : 'accent'}" data-act="transition">${icon(hasT ? 'x' : 'plus', 14)} ${hasT ? 'Tirar transição' : 'Transição'}</button>`;
      this.placeBubble(this.xOf(seam.o));
    } else {
      b.hidden = true;
    }
  }

  placeBubble(cx) {
    const b = this.bubble;
    if (cx < -20 || cx > this.viewW + 20) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    const w = b.offsetWidth || 260;
    b.style.left = `${clamp(cx - w / 2, 0, Math.max(0, this.viewW - w))}px`;
  }

  renderIntro() {
    const box = $('#cut-intro');
    if (!this.p) return;
    if (this.introApplied) {
      box.className = 'cut-intro empty';
      box.dataset.sig = '';
      box.innerHTML = `<div class="intro-add" title="A intro já faz parte deste vídeo">${icon('check', 16)}<span>Intro já incluída</span></div>`;
      return;
    }
    if (!this.intro) {
      box.className = 'cut-intro empty';
      box.dataset.sig = '';
      box.innerHTML = `<button class="intro-add" data-intro-setup title="Definir uma intro em Configurações">${icon('plus', 16)}<span>Intro</span></button>`;
      return;
    }
    const sig = `${this.intro.url}|${this.useIntro}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.className = `cut-intro ${this.useIntro ? 'on' : 'off'}`;
    const media = this.intro.isImage
      ? `<img src="${this.intro.url}" alt="" />`
      : `<video src="${this.intro.url}#t=0.5" muted preload="metadata"></video>`;
    box.innerHTML = `
      <div class="intro-media">${media}</div>
      <label class="intro-row"><input type="checkbox" class="switch sm" ${this.useIntro ? 'checked' : ''} /><span>Intro · ${fmtLen(this.intro.duration)}</span></label>`;
  }

  requestDraw(base = true) {
    if (base) this.baseDirty = true;
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  // Static layer (ruler, waveform, seams, selection) is cached; each frame only
  // the hover line and the playhead are drawn on top.
  draw() {
    if (!this.isOpen || !this.viewW) return;
    const dpr = window.devicePixelRatio || 1;
    if (!this.base) this.base = document.createElement('canvas');
    const base = this.base;
    if (base.width !== this.canvas.width || base.height !== this.canvas.height) {
      base.width = this.canvas.width;
      base.height = this.canvas.height;
      this.baseDirty = true;
    }
    if (this.baseDirty || this.baseView !== `${this.viewStart}|${this.pps}`) {
      const bctx = base.getContext('2d');
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawBase(bctx);
      this.baseDirty = false;
      this.baseView = `${this.viewStart}|${this.pps}`;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = RULER + 4;
    const th = this.viewH - top - 6;
    if (this.hover && !this.drag) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(Math.round(this.hover.x), top, 1, th);
    }
    const px = Math.round((this.t - this.viewStart) * this.pps);
    if (px >= -8 && px <= this.viewW + 8) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px - 1, 2, 2, this.viewH - 4);
      ctx.beginPath();
      ctx.moveTo(px - 6, 2);
      ctx.lineTo(px + 6, 2);
      ctx.lineTo(px, 10);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawBase(ctx) {
    const W = this.viewW;
    const H = this.viewH;
    const pps = this.pps;
    const v0 = this.viewStart;
    const top = RULER + 4;
    const th = H - top - 6;
    const mid = top + th / 2;
    const font = '"Segoe UI Variable Text", "Segoe UI", sans-serif';
    ctx.clearRect(0, 0, W, H);

    // ruler (final-video time)
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const step = steps.find((s) => s * pps >= 80) || 3600;
    ctx.fillStyle = '#626a7a';
    ctx.font = `11px ${font}`;
    ctx.textBaseline = 'middle';
    const first = Math.floor(v0 / step) * step;
    for (let t = first; t <= v0 + W / pps + step; t += step) {
      const x = Math.round((t - v0) * pps) + 0.5;
      if (x < -50 || x > W + 50) continue;
      ctx.fillRect(x, RULER - 7, 1, 7);
      ctx.fillText(fmt(t), x + 4, RULER / 2 - 1);
      for (let k = 1; k < 5; k++) ctx.fillRect(Math.round((t + (k * step) / 5 - v0) * pps) + 0.5, RULER - 3, 1, 3);
    }

    ctx.fillStyle = '#16191f';
    ctx.beginPath();
    ctx.roundRect(0, top, W, th, 8);
    ctx.fill();

    // pieces: waveform (mapped back to the source audio) and transition blocks
    const wave = new Path2D();
    const db = this.db;
    for (const it of this.seq) {
      const x0 = Math.max(0, Math.floor((it.o0 - v0) * pps));
      const x1 = Math.min(W, Math.ceil((it.o1 - v0) * pps));
      if (x1 <= 0 || x0 >= W) continue;
      if (it.t === 'x') {
        ctx.fillStyle = 'rgba(123,128,255,0.25)';
        ctx.beginPath();
        ctx.roundRect(x0 + 1, top + 3, Math.max(2, x1 - x0 - 2), th - 6, 6);
        ctx.fill();
        if (x1 - x0 > 50) {
          ctx.fillStyle = '#c6c8ff';
          ctx.font = `600 11px ${font}`;
          ctx.fillText('Transição', x0 + 8, mid);
        }
        continue;
      }
      if (this.waveState !== 'ready') continue;
      for (let x = x0; x < x1; x++) {
        const s0 = it.a + (v0 + x / pps - it.o0);
        const i0 = Math.floor(s0 / BIN);
        const i1 = Math.max(i0 + 1, Math.ceil((s0 + 1 / pps) / BIN));
        let peak = -200;
        for (let i = i0; i < i1 && i < db.length; i++) if (db[i] > peak) peak = db[i];
        const h = Math.max(1, clamp((peak + 54) / 54, 0, 1) * (th / 2 - 6));
        wave.rect(x, mid - h, 1, h * 2);
      }
    }
    ctx.fillStyle = '#8b90ff';
    ctx.fill(wave);
    if (this.waveState !== 'ready') {
      ctx.fillStyle = '#9aa1b1';
      ctx.font = `12px ${font}`;
      ctx.fillText(this.waveState === 'loading' ? 'Analisando o áudio…' : 'Sem áudio', 12, mid - 12);
    }

    // pause candidates (while "Remover pausas" is open)
    if (this.candidates) {
      for (const [a, b] of this.candidates) {
        const o = this.outOfSrc(a);
        if (o == null) continue;
        const x0 = (o - v0) * pps;
        const x1 = (o + (b - a) - v0) * pps;
        if (x1 < 0 || x0 > W) continue;
        ctx.fillStyle = 'rgba(245,184,74,0.24)';
        ctx.fillRect(x0, top, Math.max(1, x1 - x0), th);
        ctx.fillStyle = '#f5b84a';
        ctx.fillRect(x0, top, Math.max(1, x1 - x0), 3);
      }
    }

    // seams: where something was cut (red) or a transition was inserted (blue)
    this.seams.forEach((s, i) => {
      const x = Math.round((s.o - v0) * pps);
      if (x < -10 || x > W + 10) return;
      const on = i === this.focus;
      ctx.fillStyle = s.split ? '#7b80ff' : '#ff3b55';
      ctx.globalAlpha = on ? 1 : 0.85;
      ctx.fillRect(x - (on ? 1.5 : 1), top, on ? 3 : 2, th);
      ctx.beginPath();
      ctx.arc(x, top + 9, on ? 7 : 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 2.5, top + 8.25, 5, 1.5);
    });

    // selection (to be removed)
    if (this.sel) {
      const x0 = (this.sel.a - v0) * pps;
      const x1 = (this.sel.b - v0) * pps;
      ctx.fillStyle = 'rgba(255,59,85,0.18)';
      ctx.fillRect(x0, top, x1 - x0, th);
      ctx.fillStyle = '#ff5c72';
      ctx.fillRect(x0 - 1, top, 2, th);
      ctx.fillRect(x1 - 1, top, 2, th);
      for (const x of [x0, x1]) {
        ctx.beginPath();
        ctx.roundRect(x - 4, mid - 12, 8, 24, 3);
        ctx.fill();
      }
    }

  }
}
