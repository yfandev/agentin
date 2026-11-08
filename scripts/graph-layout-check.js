'use strict';
// Headless check of the network graph layout. Runs the real public/app.js in a
// stub DOM, lays the network out at several viewport sizes, and reports dot
// overlaps and nodes hidden under the headline panel.
//
// Usage: node scripts/graph-layout-check.js [path/to/app.js] [state.json]
//   default path is public/app.js (pass a saved version to compare).
//   optional state.json: a saved /api/state payload to use the real agents.

const fs = require('fs');
const vm = require('vm');

const file = process.argv[2] || 'public/app.js';
const stateFile = process.argv[3] || process.env.STATE || '';
const code = fs.readFileSync(file, 'utf8');

const FALLBACK = [
  ['medmira', 'MedMira', 'Medicine', 'demo agent'],
  ['caseclerk', 'CaseClerk', 'Law', 'demo agent'],
  ['patchpilot', 'PatchPilot', 'Coding', 'demo agent'],
  ['ledgerlynx', 'LedgerLynx', 'Finance', 'demo agent'],
  ['petripal', 'PetriPal', 'Science', 'demo agent'],
  ['queryquinn', 'QueryQuinn', 'Law', 'demo agent'],
  ['hu673pg8', 'Smart Coder', 'Coding', 'attendee agent'],
  ['3dtp3jt7', 'Great Agent', 'Medicine', 'attendee agent'],
  ['ycmk4meu', 'Medicine Agent 1', 'Medicine', 'attendee agent'],
  ['amaanqfd', 'Scout', 'Science', 'attendee agent'],
  ['u6texuqe', 'Acct Agenty', 'Finance', 'attendee agent'],
  ['5jgref93', 'Pharma Agenti', 'Medicine', 'attendee agent'],
  ['z69caq8s', 'Legoal Assistant', 'Law', 'attendee agent'],
].map(([key, name, category, badge]) => ({ key, name, category, badge }));

const agents = stateFile
  ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).agents
  : FALLBACK;

const VIEWPORTS = [
  [1920, 1000],
  [1600, 860],
  [1440, 722],
  [1366, 690],
  [1280, 640],
];

const noop = () => {};

function check(w, h) {
  const heroWidth = Math.min(720, w - 700);
  // Measured from the live layout: the headline band is 14px from the top and
  // 154px tall at these desktop widths.
  const hero = { left: (w - heroWidth) / 2, right: (w + heroWidth) / 2, top: 14, bottom: 154 };
  // Panel rectangles measured from the live layout, positioned relative to w and h.
  const barWidth = Math.min(760, w - 24);
  const panels = {
    '.hero': hero,
    '.panel.teachers': { left: 24, right: 334, top: 16, bottom: 153 },
    '.panel.feed': { left: w - 372, right: w - 24, top: 16, bottom: 117 },
    '.sheet': { left: 24, right: Math.min(560, w * 0.52) + 24, top: h - 158, bottom: h - 24 },
    '.legend': { left: w - 306, right: w - 24, top: h - 219, bottom: h - 24 },
    '.stagebar': { left: (w - barWidth) / 2, right: (w + barWidth) / 2, top: h - 62, bottom: h - 16 },
  };
  const ctxStub = new Proxy({}, { get: () => noop, set: () => true });
  const canvasEl = {
    clientWidth: w,
    clientHeight: h,
    width: 0,
    height: 0,
    getContext: () => ctxStub,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h }),
    addEventListener: noop,
  };
  const genericEl = () => ({
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    classList: { toggle: noop, add: noop, remove: noop },
    addEventListener: noop,
    appendChild: noop,
  });
  const sandbox = {
    console,
    performance: { now: () => 0 },
    requestAnimationFrame: noop,
    setInterval: noop,
    setTimeout: noop,
    fetch: () => new Promise(() => {}), // never resolve: no polling during the check
    document: {
      getElementById: (id) => (id === 'graph' ? canvasEl : genericEl()),
      querySelector: (sel) => (sel === '.hero' ? { getBoundingClientRect: () => ({ ...hero }) } : null),
      querySelectorAll: (sel) => (panels[sel] ? [{ getBoundingClientRect: () => ({ ...panels[sel] }) }] : []),
      addEventListener: noop,
    },
    window: { addEventListener: noop, devicePixelRatio: 1 },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    code + '\n;globalThis.__probe = { resize, layoutTargets, nodes, setState: (s) => { state = s; }, ring: () => ({ cx: ringCentre.x, cy: ringCentre.y, band: ringBand }), overlays: overlayRects };',
    sandbox,
    { filename: file },
  );
  sandbox.__probe.setState({ agents, connections: [], posts: [], jobs: [], pulses: [], events: [], stats: {}, settings: {}, topTeachers: [] });
  sandbox.__probe.resize();
  sandbox.__probe.layoutTargets(true);

  const list = [...sandbox.__probe.nodes.values()];
  let dots = 0;
  let crowded = 0;
  let insideHero = 0;
  let worst = Infinity;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const gap = Math.hypot(a.tx - b.tx, a.ty - b.ty) - (a.r + b.r);
      if (gap < 0) dots++;
      if (gap < 16) crowded++;
      worst = Math.min(worst, gap);
    }
    const n = list[i];
    if (n.tx > hero.left && n.tx < hero.right && n.ty > hero.top && n.ty < hero.bottom) insideHero++;
  }
  // Hidden if the dot centre lands under a floating panel that overlaps the graph.
  const hiddenBy = (n) => Object.entries(panels).filter(([, p]) => p.left < w && p.top < h && n.tx > p.left && n.tx < p.right && n.ty > p.top && n.ty < p.bottom).map(([sel]) => sel);
  const hidden = list.filter((n) => hiddenBy(n).length);
  const hiddenDetail = hidden.map((n) => n.name + ' at ' + Math.round(n.tx) + ',' + Math.round(n.ty) + ' under ' + hiddenBy(n).join('+'));

  // Labels: the boxes app.js actually paints, checked for collisions with each
  // other, with the panels, and with the canvas edges.
  const labels = list.filter((n) => n.label).map((n) => n.label);
  const hit = (a, b, pad = 0) => a.left < b.left + b.w + pad && a.left + a.w + pad > b.left && a.top < b.top + b.h + pad && a.top + a.h + pad > b.top;
  let labelOverlaps = 0;
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) if (hit(labels[i], labels[j])) labelOverlaps++;
  }
  const panelBoxes = Object.values(panels).map((p) => ({ left: p.left, top: p.top, w: p.right - p.left, h: p.bottom - p.top }));
  const labelsUnder = labels.filter((L) => panelBoxes.some((b) => hit(L, b))).length;
  const labelsOff = labels.filter((L) => L.left < 0 || L.top < 0 || L.left + L.w > w || L.top + L.h > h).length;
  const ring = sandbox.__probe.ring();
  const centreOffset = Math.abs(ring.cy - h / 2);
  const panelName = (L) => {
    const entry = Object.entries(panels).find(([, p]) => hit(L, { left: p.left, top: p.top, w: p.right - p.left, h: p.bottom - p.top }));
    return entry ? entry[0] : 'none';
  };
  const labelsCovered = labels
    .filter((L) => panelBoxes.some((b) => hit(L, b)))
    .map((L) => L.name + ' at ' + Math.round(L.left) + ',' + Math.round(L.top) + ' under ' + panelName(L));
  return {
    w, h, agents: list.length, dots, crowded, insideHero, hidden: hidden.length, hiddenDetail, worst,
    labels: labels.length, labelOverlaps, labelsUnder, labelsOff, labelsCovered, centreOffset,
  };
}

console.log('graph layout check — ' + file + (stateFile ? ' (state: ' + stateFile + ')' : ' (synthetic network)'));
let failed = false;
for (const [w, h] of VIEWPORTS) {
  const r = check(w, h);
  console.log(
    '  ' + String(r.w + 'x' + r.h).padEnd(10) +
    'dot overlaps ' + r.dots +
    ' · dots under panels ' + r.hidden +
    ' · label overlaps ' + r.labelOverlaps +
    ' · labels under panels ' + r.labelsUnder +
    ' · labels off canvas ' + r.labelsOff +
    ' · centre offset ' + r.centreOffset.toFixed(0) + 'px' +
    ' · tightest dot gap ' + (Number.isFinite(r.worst) ? r.worst.toFixed(1) : 'n/a') + 'px',
  );
  if (process.env.DEBUG && r.hiddenDetail.length) console.log('      dots: ' + r.hiddenDetail.join(' | '));
  if (process.env.DEBUG && r.labelsCovered.length) console.log('      labels: ' + r.labelsCovered.join(' | '));
  if (r.dots || r.hidden || r.labelOverlaps || r.labelsUnder || r.labelsOff || r.centreOffset > 12) failed = true;
}
process.exitCode = failed ? 1 : 0;
