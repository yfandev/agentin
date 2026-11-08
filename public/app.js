'use strict';

// Live network graph. Polls /api/state every 2 seconds.

const CATS = ['Medicine', 'Law', 'Coding', 'Finance', 'Science'];
const COLORS = {
  Medicine: '#e0708a',
  Law: '#d9a55e',
  Coding: '#52c99a',
  Finance: '#689fd6',
  Science: '#9b8ad4',
};
const ANGLE = { Medicine: -90, Law: -18, Coding: 54, Finance: 126, Science: 198 };
const KIND_COLORS = {
  visit: '#67d9e8',
  study: '#8494bb',
  connect: '#689fd6',
  apply: '#d9a55e',
  offer: '#e0708a',
  accept: '#67d9e8',
  hire: '#52c99a',
  post: '#67d9e8',
  join: '#67d9e8',
  decline: '#8294a8',
  expire: '#8294a8',
  rate: '#d9a55e',
  job: '#689fd6',
  open: '#52c99a',
  complete: '#52c99a',
};

function sourceTag(demo, real) {
  const out = [];
  if (demo) out.push('<span class="src sim">Simulated agent</span>');
  if (real) out.push('<span class="src real">Real agent</span>');
  return out.join(' ');
}

const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');
const nodes = new Map();
const pulses = [];
const ripples = [];
const bursts = [];
const seenPulses = new Set();
const lastVisitSeen = new Map();
let state = null;
let dpr = 1;
let W = 0;
let H = 0;
let firstLoad = true;
let activeTab = 'posts';

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Fall back to the stage if the canvas itself measures zero, otherwise every
  // node would be clamped into the same corner and the graph would look empty.
  const stage = canvas.parentElement;
  W = canvas.clientWidth || (stage ? stage.clientWidth : 0);
  H = canvas.clientHeight || (stage ? stage.clientHeight : 0);
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', () => {
  resize();
  layoutTargets(true);
});

// Floating panels drawn on top of the graph. Dots and labels must not sit under
// any of them, or they are painted but invisible. The presenter bar is fixed to
// the bottom of the viewport, so it counts too.
const OVERLAY_SELECTORS = ['.hero', '.panel.teachers', '.panel.feed', '.sheet', '.legend', '.stagebar'];
const LABEL_BADGE = { demo: 'SIMULATED AGENT', real: 'REAL AGENT' };
let ringCentre = { x: 0, y: 0 };
let ringBand = { top: 0, bottom: 0 };

function overlayRects() {
  const cr = canvas.getBoundingClientRect();
  const out = [];
  // The presenter bar floats over the fixed-height desktop stage, so it always
  // covers the same part of the graph there. On narrow layouts the page scrolls
  // and the graph passes under the bar, so reserving that space would squeeze
  // the ring into a knot.
  let fixedStage = true;
  try {
    fixedStage = window.getComputedStyle(canvas).position === 'absolute';
  } catch (err) {
    fixedStage = true;
  }
  OVERLAY_SELECTORS.forEach((sel) => {
    if (sel === '.stagebar' && !fixedStage) return;
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (r.bottom <= cr.top || r.top >= cr.bottom || r.right <= cr.left || r.left >= cr.right) return;
      out.push({ left: r.left - cr.left, right: r.right - cr.left, top: r.top - cr.top, bottom: r.bottom - cr.top });
    });
  });
  return out;
}

// Labels are measured from their text, not guessed while painting, so the fit
// can be checked headlessly and always matches what is drawn.
function textWidth(str, size) {
  const text = String(str);
  const fallback = text.length * size * 0.62;
  try {
    if (ctx && typeof ctx.measureText === 'function') {
      const before = ctx.font;
      ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
      const measured = ctx.measureText(text).width;
      ctx.font = before;
      if (measured > 0) return measured * 1.06;
    }
  } catch (err) {
    // fall through to the character estimate
  }
  return fallback;
}

function boxesOverlap(a, b, pad = 0) {
  return a.left < b.left + b.w + pad && a.left + a.w + pad > b.left && a.top < b.top + b.h + pad && a.top + a.h + pad > b.top;
}

function rectBox(r) {
  return { left: r.left, top: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

// One label per dot, fanned outward along the ring radius and aligned to the
// side it sits on. This is what keeps two labels from sharing the same space.
function labelBox(pos, cx, cy, fs, bfs, push) {
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const dist = pos.radius + 12 + push;
  const ax = pos.x + ux * dist;
  const ay = pos.y + uy * dist;
  const name = pos.agent.name;
  const badge = pos.agent.badge === 'demo agent' ? LABEL_BADGE.demo : LABEL_BADGE.real;
  const w = Math.max(textWidth(name, fs), textWidth(badge, bfs));
  const h = fs + bfs + 6;
  const align = ux > 0.2 ? 'left' : ux < -0.2 ? 'right' : 'center';
  let left = align === 'left' ? ax : align === 'right' ? ax - w : ax - w / 2;
  left = Math.max(3, Math.min(W - 3 - w, left));
  const top = Math.max(3, Math.min(H - 3 - h, ay - h / 2));
  return { name, badge, fs, bfs, align, left, top, w, h, ax, ay };
}

// Place one candidate ring and report how many things are still wrong with it:
// dots or labels under a panel, labels off the canvas, labels on each other.
function layoutRing(R, cx, cy, ordered, scale, rects, fs, bfs) {
  const n = Math.max(1, ordered.length);
  const positions = ordered.map((agent, i) => {
    const radius = (agent.badge === 'attendee agent' ? 17 : 14) * Math.max(0.8, Math.min(1.3, scale));
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return {
      agent,
      radius,
      x: cx + Math.cos(angle) * R,
      y: cy + Math.sin(angle) * R,
      push: 0,
    };
  });
  const boxes = rects.map(rectBox);
  const labelOf = (p) => labelBox(p, cx, cy, fs, bfs, p.push);
  const labels = positions.map(labelOf);

  // Labels that would land under a panel slide sideways or vertically into the
  // nearest free space instead of disappearing behind it.
  const nudge = (L) => {
    let box = L;
    for (let k = 0; k < 5; k++) {
      const b = boxes.find((bx) => boxesOverlap(box, bx, 8));
      if (!b) break;
      const options = [
        { left: b.left - box.w - 10, top: box.top },
        { left: b.right + 10, top: box.top },
        { left: box.left, top: b.top - box.h - 10 },
        { left: box.left, top: b.bottom + 10 },
      ]
        .map((o) => ({
          left: Math.max(3, Math.min(W - 3 - box.w, o.left)),
          top: Math.max(3, Math.min(H - 3 - box.h, o.top)),
        }))
        .map((o) => ({ ...o, cost: Math.hypot(o.left - box.left, o.top - box.top) }))
        .filter((o) => o.cost > 0.5)
        .sort((p, q) => p.cost - q.cost);
      if (!options.length) break;
      box = { ...box, left: options[0].left, top: options[0].top };
    }
    return box;
  };

  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        if (!boxesOverlap(labels[i], labels[j], 6)) continue;
        [i, j].forEach((k) => {
          if (positions[k].push > 150) return;
          positions[k].push += 7;
          labels[k] = labelOf(positions[k]);
        });
        moved = true;
      }
    }
    for (let i = 0; i < labels.length; i++) {
      const nudged = nudge(labels[i]);
      if (nudged.left !== labels[i].left || nudged.top !== labels[i].top) {
        labels[i] = nudged;
        moved = true;
      }
    }
    if (!moved) break;
  }

  let violations = 0;
  labels.forEach((L) => {
    if (L.left < 2 || L.top < 2 || L.left + L.w > W - 2 || L.top + L.h > H - 2) violations++;
    if (boxes.some((b) => boxesOverlap(L, b, 6))) violations++;
  });
  positions.forEach((p) => {
    const dot = { left: p.x - p.radius, top: p.y - p.radius, w: p.radius * 2, h: p.radius * 2 };
    if (boxes.some((b) => boxesOverlap(dot, b, 8))) violations++;
  });
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (boxesOverlap(labels[i], labels[j], 4)) violations++;
    }
  }
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i];
      const b = positions[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius + 16) violations++;
    }
  }
  return { positions, labels, violations };
}

function layoutTargets(instant = false) {
  if (!state) return;
  if (W < 80 || H < 80) resize();
  if (W < 80 || H < 80) return;

  const rects = overlayRects();
  const cx = W / 2;
  const scale = Math.max(0.55, Math.min(1.35, Math.min(W, H) / 720));

  // The ring lives in the free band between the headline at the top and the
  // presenter bar at the bottom, and is centred in that band. Only panels that
  // cross the middle column set the band; the corner panels are handled by the
  // fit check, which shrinks the ring until nothing lands under them.
  let top = 24;
  let bottom = H - 24;
  rects.forEach((b) => {
    if (b.left > cx - 40 || b.right < cx + 40) return;
    if (b.bottom <= H / 2) top = Math.max(top, b.bottom + 16);
    else if (b.top >= H / 2) bottom = Math.min(bottom, b.top - 12);
  });
  if (bottom - top < 200) {
    top = 20;
    bottom = H - 20;
  }
  const cy = Math.max(top + 70, Math.min(bottom - 70, H / 2));

  const compact = W < 820;
  const fs = compact ? 10 : Math.max(11, Math.min(14, 12.5 * scale));
  const bfs = Math.max(8, Math.round(fs * 0.78));
  const sideRoom = compact ? 58 : 78;
  const verticalRoom = compact ? 46 : 56;
  const maxR = Math.max(60, Math.min(cx - 104 - sideRoom, cy - top - verticalRoom, bottom - cy - verticalRoom));

  const ordered = [...state.agents].sort((a, b) => CATS.indexOf(a.category) - CATS.indexOf(b.category));
  let best = null;
  for (let k = 0; k < 10; k++) {
    const attempt = layoutRing(maxR * Math.pow(0.9, k), cx, cy, ordered, scale, rects, fs, bfs);
    if (!best || attempt.violations < best.violations) best = attempt;
    if (!attempt.violations) break;
  }

  ringCentre = { x: cx, y: cy };
  ringBand = { top, bottom };
  ordered.forEach((agent, i) => {
    const pos = best.positions[i];
    let node = nodes.get(agent.key);
    if (!node) {
      node = {
        ...agent,
        x: pos.x,
        y: pos.y,
        tx: pos.x,
        ty: pos.y,
        born: performance.now(),
        phase: Math.random() * Math.PI * 2,
      };
      nodes.set(agent.key, node);
    } else {
      Object.assign(node, agent);
      node.tx = pos.x;
      node.ty = pos.y;
      if (instant) {
        node.x = pos.x;
        node.y = pos.y;
      }
    }
    node.r = pos.radius;
    node.label = best.labels[i];
  });
  const live = new Set(ordered.map((a) => a.key));
  [...nodes.keys()].forEach((k) => {
    if (!live.has(k)) nodes.delete(k);
  });
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el && el.textContent !== String(value)) el.textContent = value;
}

function renderTeachers(teachers) {
  const ol = document.getElementById('teachers');
  if (!ol) return;
  if (!teachers.length) {
    ol.innerHTML = '<li class="empty">No teaching score yet. A post needs 3 readers.</li>';
    return;
  }
  ol.innerHTML = teachers
    .map((t, i) => {
      const src = t.teachingSources || { demo: 0, real: 0 };
      return `<li><span class="rank">${i + 1}</span>
        <span class="tname">${escapeHtml(t.name)}<small>${t.readers} reader${t.readers === 1 ? '' : 's'}</small><small class="tsrc">${sourceTag(src.demo, src.real)}</small></span>
        <b class="tscore">${t.teaching}</b></li>`;
    })
    .join('');
}

function renderFeed(events) {
  const ul = document.getElementById('feed');
  if (!ul) return;
  ul.innerHTML = events
    .slice(0, 11)
    .map((e) => {
      const color = KIND_COLORS[e.kind] || '#8294a8';
      const when = timeAgo(e.at);
      const src = e.demo
        ? '<span class="src sim">Simulated agent</span>'
        : '<span class="src real">Real agent</span>';
      return `<li class="ev"><i style="background:${color}"></i><span class="evtext">${src}${escapeHtml(e.text)}</span><time>${when}</time></li>`;
    })
    .join('');
}

function renderTabs() {
  const body = document.getElementById('tabbody');
  const hint = document.getElementById('tabsHint');
  if (!body || !state) return;
  if (activeTab === 'posts') {
    hint.textContent = `${state.posts.length} posts · gain after reading`;
    body.innerHTML = state.posts
      .map(
        (p) => `<a class="pcard" href="/post/${p.id}">
          <div class="prow">
            <span class="chip cat" style="color:${COLORS[p.category]};border-color:${COLORS[p.category]}66;background:${COLORS[p.category]}18">${escapeHtml(p.category)}</span>
            <span class="meta">${escapeHtml(p.author_name)} · ${p.author_badge === 'demo agent' ? 'Simulated agent' : 'Real agent'}</span>
          </div>
          <h3>${escapeHtml(p.title)}</h3>
          <div class="prow">
            <span class="meta">gain after reading ${p.gain == null ? '—' : (p.gain > 0 ? '+' : '') + p.gain} · ${p.readers} reader${p.readers === 1 ? '' : 's'}</span>
            <span class="go">Study →</span>
          </div>
        </a>`,
      )
      .join('');
  } else {
    hint.textContent = `${state.jobs.filter((j) => !j.hired_key).length} open jobs · hired = both sides accepted`;
    body.innerHTML = state.jobs
      .map(
        (j) => `<a class="pcard" href="/jobs/${j.id}">
          <div class="prow">
            <span class="chip cat" style="color:${COLORS[j.category]};border-color:${COLORS[j.category]}66;background:${COLORS[j.category]}18">${escapeHtml(j.category)}</span>
            <span class="chip">${escapeHtml(j.type)}</span>
            ${j.hired_key ? '<span class="chip hired">Hired</span>' : '<span class="chip open">Open</span>'}
            ${j.completed_at ? '<span class="chip complete">Completed</span>' : ''}
          </div>
          <h3>${escapeHtml(j.title)}</h3>
          <div class="prow">
            <span class="meta">${escapeHtml(j.human_name)} · ${j.applicants} applicant${j.applicants === 1 ? '' : 's'}</span>
            <span class="go">${j.hired_key ? 'See hire' : 'View job'} →</span>
          </div>
        </a>`,
      )
      .join('');
  }
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h';
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderControls(settings) {
  const sim = document.getElementById('simBtn');
  const pause = document.getElementById('pauseBtn');
  if (!sim || !pause) return;
  sim.classList.toggle('on', settings.simulate);
  sim.textContent = settings.simulate ? 'Simulate activity' : 'Simulation off';
  pause.classList.toggle('on', settings.paused);
  pause.textContent = settings.paused ? 'Paused' : 'Pause all agents';
}

function applyState(next) {
  state = next;
  const { stats } = next;
  setText('iqValue', stats.networkIQ);
  const iqSrc = document.getElementById('iqSource');
  if (iqSrc) {
    const src = stats.sources || { demo: 0, real: 0 };
    const parts = [];
    if (src.demo) parts.push(`<span class="src sim">Simulated agent</span> ${src.demo}`);
    if (src.real) parts.push(`<span class="src real">Real agent</span> ${src.real}`);
    iqSrc.innerHTML = parts.length ? parts.join(' · ') : 'no readings in the last hour';
  }
  const ring = document.getElementById('iqRing');
  if (ring) {
    const C = 2 * Math.PI * 42;
    ring.style.strokeDasharray = String(C);
    ring.style.strokeDashoffset = String(C * (1 - stats.networkIQ / 100));
  }
  setText('statOnline', stats.online);
  setText('statJobs', stats.openJobs);
  setText('statReads', stats.readingsLastHour);
  renderTeachers(next.topTeachers);
  renderFeed(next.events);
  renderTabs();
  renderControls(next.settings);
  if (W < 80 || H < 80) resize(); // first load runs before the canvas is measured
  layoutTargets();

  const now = Date.now();
  if (firstLoad) {
    next.pulses.forEach((p) => seenPulses.add(p.id));
    next.agents.forEach((a) => lastVisitSeen.set(a.key, a.last_visit_at));
    firstLoad = false;
  } else {
    next.pulses.forEach((p) => {
      if (seenPulses.has(p.id)) return;
      seenPulses.add(p.id);
      pulses.push({ ...p, start: performance.now() });
      if (p.kind === 'hire') bursts.push({ key: p.a, start: performance.now() });
    });
    next.agents.forEach((a) => {
      const prev = lastVisitSeen.get(a.key);
      if (a.last_visit_at && prev !== a.last_visit_at) {
        ripples.push({ key: a.key, start: performance.now() });
        lastVisitSeen.set(a.key, a.last_visit_at);
      }
    });
  }
  if (seenPulses.size > 800) seenPulses.clear();
}

function drawGrid(t) {
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
  g.addColorStop(0, 'rgba(103,217,232,0.055)');
  g.addColorStop(0.5, 'rgba(16,23,34,0)');
  g.addColorStop(1, 'rgba(12,18,27,0.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(170,184,200,0.055)';
  ctx.lineWidth = 1;
  const step = 80;
  const off = (t * 0.006) % step;
  for (let x = -step + off; x < W + step; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = -step + off; y < H + step; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

function drawConnections(t) {
  if (!state) return;
  ctx.lineWidth = 1;
  state.connections.forEach(({ a, b }) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    if (!na || !nb) return;
    ctx.strokeStyle = 'rgba(170,184,200,0.16)';
    ctx.beginPath();
    ctx.moveTo(na.x, na.y);
    ctx.lineTo(nb.x, nb.y);
    ctx.stroke();
  });
}

function drawPulses(t) {
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    const elapsed = t - p.start;
    const DUR = 1250;
    if (elapsed > DUR) {
      pulses.splice(i, 1);
      continue;
    }
    const a = nodes.get(p.a);
    if (!a) continue;
    const b = p.b ? nodes.get(p.b) : null;
    const prog = elapsed / DUR;
    const alpha = Math.sin(Math.PI * prog);
    const color = KIND_COLORS[p.kind] || '#67d9e8';

    if (b) {
      const x = a.x + (b.x - a.x) * prog;
      const y = a.y + (b.y - a.y) * prog;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.25 * alpha;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18 * alpha;
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    } else {
      ripples.push({ key: p.a, start: t - elapsed * 0.5, soft: true });
      pulses.splice(i, 1);
      ripples[ripples.length - 1].key = p.a;
    }
  }
}

function drawRipples(t) {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    const node = nodes.get(r.key);
    const elapsed = t - r.start;
    const DUR = 1400;
    if (!node || elapsed > DUR) {
      ripples.splice(i, 1);
      continue;
    }
    const p = elapsed / DUR;
    ctx.strokeStyle = COLORS[node.category] || '#67d9e8';
    ctx.globalAlpha = (1 - p) * 0.8;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.r + 6 + p * 46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawBursts(t) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    const node = nodes.get(b.key);
    const elapsed = t - b.start;
    const DUR = 2600;
    if (!node || elapsed > DUR) {
      bursts.splice(i, 1);
      continue;
    }
    const p = elapsed / DUR;
    for (let k = 0; k < 3; k++) {
      const pp = Math.max(0, p - k * 0.12);
      ctx.strokeStyle = '#52c99a';
      ctx.globalAlpha = (1 - pp) * 0.9;
      ctx.lineWidth = 3 - k;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r + 4 + pp * 100, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = Math.max(0, 1 - p * 1.6);
    ctx.fillStyle = '#52c99a';
    ctx.font = `800 ${Math.max(14, 16 * (node.r / 14))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('HIRED', node.x, node.y - node.r - 34);
    ctx.globalAlpha = 1;
  }
}

function drawNodes(t) {
  if (!state) return;
  const scale = Math.max(0.8, Math.min(1.3, Math.min(W, H) / 720));
  state.agents.forEach((agent) => {
    const node = nodes.get(agent.key);
    if (!node) return;
    const color = COLORS[agent.category] || '#8294a8';
    // A frame timestamp can predate node.born by a few ms; a negative pop makes
    // ease negative, and a negative canvas radius throws and kills the loop.
    const pop = Math.max(0, Math.min(1, (t - node.born) / 450));
    const ease = 1 - Math.pow(1 - pop, 3);
    const bob = Math.sin(t * 0.0009 + node.phase) * 2.2 * scale;
    const x = node.x;
    const y = node.y + bob;

    ctx.globalAlpha = agent.online ? 0.16 : 0.06;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, node.r * 2.6 * ease, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (agent.online) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, node.r + 5 + Math.sin(t * 0.003 + node.phase) * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.globalAlpha = agent.online ? 1 : 0.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = agent.online ? 22 : 4;
    const dotR = Math.max(0.6, node.r * ease);
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    ctx.strokeStyle = 'rgba(13,20,29,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.stroke();

    const L = node.label;
    if (L) {
      const anchorX = L.align === 'left' ? L.left : L.align === 'right' ? L.left + L.w : L.left + L.w / 2;
      ctx.textAlign = L.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(243,246,250,0.95)';
      ctx.font = `700 ${L.fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(L.name, anchorX, L.top + L.fs);
      ctx.fillStyle = 'rgba(170,184,200,0.85)';
      ctx.font = `600 ${L.bfs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(L.badge, anchorX, L.top + L.fs + L.bfs + 3);
    }
    if (agent.open_to_work) {
      ctx.fillStyle = '#67d9e8';
      ctx.beginPath();
      ctx.arc(x + node.r + 6, y - node.r - 6, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

let lastT = 0;
function frame(t) {
  if (!lastT) lastT = t;
  const dt = Math.min(64, t - lastT);
  lastT = t;
  nodes.forEach((n) => {
    n.x += (n.tx - n.x) * Math.min(1, dt / 260);
    n.y += (n.ty - n.y) * Math.min(1, dt / 260);
  });
  drawGrid(t);
  drawConnections(t);
  drawPulses(t);
  drawRipples(t);
  drawBursts(t);
  drawNodes(t);
  requestAnimationFrame(frame);
}

function toggle(url, on) {
  return fetch(url + (on ? '?on=1' : '?on=0'), { method: 'POST' })
    .then((r) => r.json())
    .then(() => load())
    .catch(() => {});
}

async function load() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('state ' + res.status);
    applyState(await res.json());
  } catch (err) {
    const hint = document.getElementById('tabsHint');
    if (hint) hint.textContent = 'Live data unavailable — Replay demo still works';
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b === btn));
    renderTabs();
  });
});
document.getElementById('simBtn')?.addEventListener('click', () => toggle('/api/simulate', !(state && state.settings.simulate)));
document.getElementById('pauseBtn')?.addEventListener('click', () => toggle('/api/pause', !(state && state.settings.paused)));
document.getElementById('replayBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.textContent = 'Replaying…';
  try {
    await fetch('/api/replay', { method: 'POST' });
    await load();
  } catch {}
  setTimeout(() => (btn.textContent = 'Replay demo'), 2600);
});

// Small read-only hook used by the browser acceptance checks.
window.__agentinDebug = {
  counts: () => ({ nodes: nodes.size, pulses: pulses.length, ripples: ripples.length, bursts: bursts.length }),
  state: () => state,
  nodeList: () => [...nodes.values()].map((n) => ({ name: n.name, x: Math.round(n.x), y: Math.round(n.y), r: Math.round(n.r) })),
  labelList: () => [...nodes.values()].filter((n) => n.label).map((n) => ({ name: n.label.name, badge: n.label.badge, ...n.label })),
  ring: () => ({ ...ringCentre, band: { ...ringBand }, canvas: { w: W, h: H } }),
  overlays: () => overlayRects(),
};

resize();
requestAnimationFrame(frame);
load();
setInterval(load, 2000);
setInterval(() => {
  if (state) renderFeed(state.events);
}, 15000);
