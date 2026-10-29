const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listSources: () => ipcRenderer.invoke('sources:list'),
  chooseFolder: (current) => ipcRenderer.invoke('dialog:folder', current),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  media: {
    probe: (file) => ipcRenderer.invoke('media:probe', file),
    waveform: (file) => ipcRenderer.invoke('media:waveform', file),
    measureSync: (buf) => ipcRenderer.invoke('sync:measure', buf),
    url: (file) => ipcRenderer.invoke('media:url', file),
    previewVideo: (file) => ipcRenderer.invoke('media:previewVideo', file),
    proxyVideo: (file) => ipcRenderer.invoke('media:proxyVideo', file),
  },
  gallery: {
    list: (dir) => ipcRenderer.invoke('gallery:list', dir),
    rename: (item, title) => ipcRenderer.invoke('gallery:rename', item, title),
    trash: (item) => ipcRenderer.invoke('gallery:trash', item),
  },
  saveProject: (folder, patch) => ipcRenderer.invoke('project:save', folder, patch),
  mde: {
    info: () => ipcRenderer.invoke('mde:info'),
    setKey: (key) => ipcRenderer.invoke('mde:setKey', key),
    clearKey: () => ipcRenderer.invoke('mde:clearKey'),
    test: () => ipcRenderer.invoke('mde:test'),
    send: (folder, opts) => ipcRenderer.invoke('mde:send', folder, opts),
    cancel: (folder) => ipcRenderer.invoke('mde:cancel', folder),
    open: (url) => ipcRenderer.invoke('mde:open', url),
    onStatus: on('mde:status'),
  },
  pickIntro: (slot) => ipcRenderer.invoke('dialog:intro', slot),
  selectRegion: (displayId) => ipcRenderer.invoke('region:select', displayId),
  region: { done: (rect) => ipcRenderer.send('region:done', rect) },
  script: {
    toggle: () => ipcRenderer.invoke('script:toggle'),
    get: () => ipcRenderer.invoke('script:get'),
    set: (patch) => ipcRenderer.send('script:set', patch),
    close: () => ipcRenderer.send('script:close'),
    onState: on('script:state'),
  },
  openVideo: (dir) => ipcRenderer.invoke('dialog:openVideo', dir),
  trash: (file) => ipcRenderer.invoke('file:trash', file),
  exporter: {
    run: (job) => ipcRenderer.invoke('export:run', job),
    cancel: () => ipcRenderer.invoke('export:cancel'),
    onProgress: on('export:progress'),
  },

  rec: {
    prepare: (opts) => ipcRenderer.invoke('rec:prepare', opts),
    chunk: (key, buf) => ipcRenderer.invoke('rec:chunk', key, buf),
    finish: (opts) => ipcRenderer.invoke('rec:finish', opts),
    discard: () => ipcRenderer.invoke('rec:discard'),
    status: (s) => ipcRenderer.send('rec:status', s),
    onGo: on('rec:go'),
    onCancel: on('rec:cancel'),
    onError: on('rec:error'),
  },

  ui: {
    startCountdown: (opts) => ipcRenderer.invoke('ui:startCountdown', opts),
    recordingStarted: (payload) => ipcRenderer.invoke('ui:recordingStarted', payload),
    recordingEnded: () => ipcRenderer.invoke('ui:recordingEnded'),
    finalized: () => ipcRenderer.invoke('ui:finalized'),
    onHotkey: on('hotkey'),
    onBarAction: on('bar:action'),
  },

  // Used by the floating recording bar.
  bar: {
    onMode: on('bar:mode'),
    onStatus: on('bar:status'),
    countdownDone: () => ipcRenderer.send('bar:countdownDone'),
    cancel: () => ipcRenderer.send('bar:cancel'),
    action: (a) => ipcRenderer.send('bar:action', a),
    openStudio: () => ipcRenderer.send('bar:openStudio'),
    resize: (width) => ipcRenderer.send('bar:resize', width),
    script: () => ipcRenderer.send('bar:script'),
  },
});
