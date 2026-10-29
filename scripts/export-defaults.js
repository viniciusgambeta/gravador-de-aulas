// Builds build/defaults (bundled into the installer) from this computer's
// settings: layouts, intro/transition clips, logo and preferences become the
// starting point for every new user. Personal data is left out: MDE API key,
// devices, chosen screen/area, output folder and the script text.
//   node scripts/export-defaults.js
const fs = require('fs');
const path = require('path');

const userData = path.join(process.env.APPDATA, 'Gravador de Aulas');
const src = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
const out = path.join(__dirname, '..', 'build', 'defaults');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const SLOT = { intro: 'horizontal', introV: 'vertical', transition: 'transicao-horizontal', transitionV: 'transicao-vertical', logo: 'logo' };
const prefs = { ...(src.prefs || {}) };
delete prefs.outDir; // each person uses their own Videos folder
delete prefs.syncByCamera; // measured per camera on each PC
for (const [key, slot] of Object.entries(SLOT)) {
  const it = prefs[key];
  if (!it || !it.path || !fs.existsSync(it.path)) { prefs[key] = null; continue; }
  const rel = `intro/${slot}/${path.basename(it.path)}`;
  fs.mkdirSync(path.join(out, path.dirname(rel)), { recursive: true });
  fs.copyFileSync(it.path, path.join(out, rel));
  const { path: _p, url: _u, ...rest } = it;
  prefs[key] = { ...rest, file: rel };
}

const defaults = {
  prefs,
  layoutSets: src.layoutSets,
  active: src.active,
  bg: src.bg,
  orientation: src.orientation,
  screenAspect: src.screenAspect,
};
fs.writeFileSync(path.join(out, 'settings.json'), JSON.stringify(defaults, null, 2));
console.log('defaults written:', Object.entries(SLOT).filter(([k]) => prefs[k]).map(([k]) => k).join(', ') || 'no media',
  '| layouts:', Object.entries(defaults.layoutSets || {}).map(([o, l]) => `${o}=${l.length}`).join(' '));
