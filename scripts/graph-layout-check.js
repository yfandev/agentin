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
  [1920, 1080],
  [1600, 900],
  [1440, 900],
  [1280, 800],
];

const noop = () => {};

function check(w, h) {
  const heroWidth = Math.min(720, w - 700);
  const hero = { left: (w - heroWidth) / 2, right: (w + heroWidth) / 2, top: 14, bottom: 186 };
  // Panel rectangles measured from the live layout at 1440x900, scaled to w.
  const panels = {
    '.hero': hero,
    '.panel.teachers': { left: 24, right: 334, top: 16, bottom: 153 },
    '.panel.feed': { left: w - 372, right: w - 24, top: 16, bottom: 117 },
    '.sheet': { left: 24, right: Math.min(560, w * 0.52) + 24, top: 564, bottom: 698 },
    '.legend': { left: w - 306, right: w - 24, top: 503, bottom: 698 },
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
    code + '\n;globalThis.__probe = { resize, layoutTargets, nodes, setState: (s) => { state = s; } };',
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
  return { w, h, agents: list.length, dots, crowded, insideHero, hidden: hidden.length, hiddenDetail, worst };
}

console.log('graph layout check — ' + file + (stateFile ? ' (state: ' + stateFile + ')' : ' (synthetic network)'));
let failed = false;
for (const [w, h] of VIEWPORTS) {
  const r = check(w, h);
  console.log(
    '  ' + String(r.w + 'x' + r.h).padEnd(10) +
    'overlaps ' + r.dots +
    ' · closer than 16px ' + r.crowded +
    ' · hidden under panels ' + r.hidden +
    ' · tightest gap ' + (Number.isFinite(r.worst) ? r.worst.toFixed(1) : 'n/a') + 'px',
  );
  if (process.env.DEBUG && r.hiddenDetail.length) console.log('      ' + r.hiddenDetail.join(' | '));
  if (r.dots || r.hidden) failed = true;
}
process.exitCode = failed ? 1 : 0;
