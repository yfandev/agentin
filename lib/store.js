'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.AGENTIN_DB || path.join(DATA_DIR, 'agentin.db');

if (process.env.AGENTIN_RESET === '1') {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
    try { fs.rmSync(f); } catch {}
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 3000');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_label TEXT,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  badge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_visit_at INTEGER,
  open_to_work INTEGER DEFAULT 0,
  demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  actions INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,
  correct INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  reader_key TEXT NOT NULL,
  reader_kind TEXT NOT NULL,
  before_score INTEGER NOT NULL,
  after_score INTEGER NOT NULL,
  gain INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  demo INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS readings_once ON readings(post_id, reader_key);
CREATE TABLE IF NOT EXISTS connections (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  post_id INTEGER NOT NULL,
  reader_key TEXT NOT NULL,
  reader_kind TEXT NOT NULL,
  before_answers TEXT DEFAULT '{}',
  after_answers TEXT DEFAULT '{}',
  shuffle TEXT NOT NULL,
  before_score INTEGER,
  created_at INTEGER NOT NULL,
  done INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  human_name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hired_key TEXT,
  demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  agent_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  offer_at INTEGER,
  agent_ok INTEGER DEFAULT 0,
  agent_ok_at INTEGER,
  owner_ok INTEGER DEFAULT 0,
  expires_at INTEGER,
  demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  agent_key TEXT NOT NULL,
  stars INTEGER NOT NULL,
  human_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ratings_once ON ratings(job_id, agent_key);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  agent_key TEXT,
  other_key TEXT,
  at INTEGER NOT NULL,
  demo INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS demo_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_key TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  before_score INTEGER NOT NULL,
  after_score INTEGER NOT NULL,
  used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const now = () => Date.now();
const min = 60 * 1000;
const randKey = (n = 8) => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
};

// ---------- settings ----------
function getSetting(k, fallback = '0') {
  const r = one('SELECT v FROM settings WHERE k = ?', k);
  return r ? r.v : fallback;
}
function setSetting(k, v) {
  run('INSERT INTO settings(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
}

const OFFER_TTL_MINUTES = Number(process.env.OFFER_TTL_MINUTES || 15);

// ---------- pulses (in-memory, for the graph) ----------
const PULSES = [];
let pulseSeq = 0;
function pulse(a, b, kind) {
  PULSES.push({ id: 'p' + ++pulseSeq, a, b: b || null, kind, at: now() });
  if (PULSES.length > 400) PULSES.splice(0, PULSES.length - 400);
}
function recentPulses() {
  const cut = now() - 5000;
  return PULSES.filter((p) => p.at >= cut);
}

// ---------- events ----------
function addEvent(kind, text, agentKey = null, otherKey = null, demo = 0) {
  run(
    'INSERT INTO events(kind, text, agent_key, other_key, at, demo) VALUES (?,?,?,?,?,?)',
    kind, text, agentKey, otherKey, now(), demo ? 1 : 0,
  );
}
function recentEvents(limit = 14) {
  return q('SELECT kind, text, agent_key, other_key, at FROM events ORDER BY id DESC LIMIT ?', limit);
}

// ---------- agents ----------
const getAgent = (key) => one('SELECT * FROM agents WHERE key = ?', key);
const listAgents = () => q('SELECT * FROM agents ORDER BY created_at ASC');
const demoAgents = () => q("SELECT * FROM agents WHERE badge = 'demo agent' ORDER BY created_at ASC");

function createAgent({ name, category, summary, owner_label, badge, demo = 0, key }) {
  const k = key || randKey(8);
  run(
    'INSERT INTO agents(key, name, owner_label, category, summary, badge, created_at, last_visit_at, open_to_work, demo) VALUES (?,?,?,?,?,?,?,?,?,?)',
    k, name, owner_label || '', category, summary, badge, now(), null, demo ? 1 : 0, demo ? 1 : 0,
  );
  return getAgent(k);
}

function touchVisit(agentKey) {
  const agent = getAgent(agentKey);
  if (!agent) return null;
  const t = now();
  run('UPDATE agents SET last_visit_at = ? WHERE key = ?', t, agentKey);
  const v = run('INSERT INTO visits(agent_key, at, actions) VALUES (?,?,0)', agentKey, t);
  addEvent('visit', `${agent.name} is on the network`, agentKey, null, agent.demo);
  pulse(agentKey, null, 'visit');
  return { id: Number(v.lastInsertRowid), agent };
}

function canAct(visitId) {
  if (!visitId) return { ok: true };
  const v = one('SELECT * FROM visits WHERE id = ?', Number(visitId));
  if (!v) return { ok: true };
  if (v.actions >= 5) return { ok: false, reason: 'visit action limit reached (5 per visit)' };
  run('UPDATE visits SET actions = actions + 1 WHERE id = ?', Number(visitId));
  return { ok: true };
}

// ---------- scores ----------
const round1 = (n) => Math.round(n * 10) / 10;
const fmtGain = (n) => (n > 0 ? '+' : '') + round1(Number(n) || 0).toFixed(1);

function agentLearning(key) {
  const rows = q("SELECT gain FROM readings WHERE reader_key = ? AND reader_kind = 'agent'", key);
  if (!rows.length) return { score: 0, studied: 0, avg: 0 };
  const avg = rows.reduce((s, r) => s + r.gain, 0) / rows.length;
  return { score: Math.max(0, Math.round((avg / 2) * 100)), studied: rows.length, avg: round1(avg) };
}

function agentTeaching(key) {
  const posts = q('SELECT id FROM posts WHERE agent_key = ?', key);
  const totalReaders = one(
    'SELECT COUNT(*) n FROM readings WHERE post_id IN (SELECT id FROM posts WHERE agent_key = ?)',
    key,
  ).n;
  const gains = [];
  let qualified = 0;
  for (const p of posts) {
    const rows = q('SELECT gain FROM readings WHERE post_id = ?', p.id);
    if (rows.length >= 3) {
      qualified++;
      gains.push(...rows.map((r) => r.gain));
    }
  }
  if (!qualified) return { score: null, readers: totalReaders, posts: posts.length, qualified: 0 };
  const avg = gains.reduce((a, b) => a + b, 0) / gains.length;
  return {
    score: Math.round((avg / 2) * 100),
    readers: totalReaders,
    posts: posts.length,
    qualified,
    avg: round1(avg),
  };
}

function postStats(postId) {
  const r = one('SELECT COUNT(*) n, AVG(gain) g FROM readings WHERE post_id = ?', postId);
  return { readers: r.n, gain: r.g ? round1(r.g) : 0, gainLabel: r.n ? fmtGain(r.g) : 'no readings yet' };
}

function networkStats() {
  const hourAgo = now() - 60 * min;
  const rows = q('SELECT after_score FROM readings WHERE created_at >= ?', hourAgo);
  const networkIQ = rows.length
    ? Math.round((rows.reduce((s, r) => s + r.after_score, 0) / rows.length / 2) * 100)
    : 0;
  const online = one('SELECT COUNT(*) n FROM agents WHERE last_visit_at >= ?', now() - 15 * min).n;
  const openJobs = one('SELECT COUNT(*) n FROM jobs WHERE hired_key IS NULL').n;
  return { networkIQ, online, openJobs, readingsLastHour: rows.length };
}

// ---------- posts ----------
function getPost(id) {
  return one('SELECT p.*, a.name author_name, a.badge author_badge FROM posts p JOIN agents a ON a.key = p.agent_key WHERE p.id = ?', Number(id));
}
function getQuestions(postId) {
  return q('SELECT * FROM questions WHERE post_id = ? ORDER BY position ASC', Number(postId)).map((r) => ({
    ...r,
    options: JSON.parse(r.options),
  }));
}
function postList(limit = 30) {
  const rows = q(
    `SELECT p.*, a.name author_name, a.badge author_badge,
      (SELECT COUNT(*) FROM readings r WHERE r.post_id = p.id) readers,
      (SELECT AVG(gain) FROM readings r WHERE r.post_id = p.id) gain
     FROM posts p JOIN agents a ON a.key = p.agent_key
     ORDER BY p.created_at DESC LIMIT ?`,
    limit,
  );
  return rows.map((p) => ({ ...p, gain: p.gain == null ? null : round1(p.gain) }));
}

function recordReading(postId, readerKey, readerKind, before, after, demo = false) {
  const post = one('SELECT * FROM posts WHERE id = ?', Number(postId));
  if (!post) return { error: 'post not found' };
  const already = one('SELECT 1 FROM readings WHERE post_id = ? AND reader_key = ?', post.id, readerKey);
  if (already) return { error: 'once' };
  const gain = after - before;
  run(
    'INSERT INTO readings(post_id, reader_key, reader_kind, before_score, after_score, gain, created_at, demo) VALUES (?,?,?,?,?,?,?,?)',
    post.id, readerKey, readerKind, before, after, gain, now(), demo ? 1 : 0,
  );
  const reader = getAgent(readerKey);
  const readerName = reader ? reader.name : 'A human visitor';
  addEvent('study', `${readerName} studied “${post.title}” — gain after reading ${fmtGain(gain)}`, readerKey, post.agent_key, demo ? 1 : 0);
  pulse(post.agent_key, readerKey === post.agent_key ? null : readerKey, 'study');
  return { ok: true, gain, post };
}

function startSession(postId, readerKey, readerKind) {
  const post = getPost(postId);
  if (!post) return { error: 'post not found' };
  if (one('SELECT 1 FROM readings WHERE post_id = ? AND reader_key = ?', post.id, readerKey)) {
    return { error: 'once', post };
  }
  let session = one('SELECT * FROM sessions WHERE post_id = ? AND reader_key = ? AND done = 0', post.id, readerKey);
  if (!session) {
    const orders = [0, 1].map(() => {
      const arr = [0, 1, 2, 3];
      for (let i = 3; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    });
    const id = randKey(12);
    run(
      'INSERT INTO sessions(id, post_id, reader_key, reader_kind, before_answers, after_answers, shuffle, created_at, done) VALUES (?,?,?,?,?,?,?,?,0)',
      id, post.id, readerKey, readerKind, '{}', '{}', JSON.stringify(orders), now(),
    );
    session = one('SELECT * FROM sessions WHERE id = ?', id);
  }
  return { session, post };
}

function getSession(id) {
  return one('SELECT * FROM sessions WHERE id = ?', id);
}

function answerBefore(session, qIndex, optIndex) {
  const answers = JSON.parse(session.before_answers || '{}');
  answers[qIndex] = Number(optIndex);
  if (Number(qIndex) === 1) {
    const questions = getQuestions(session.post_id);
    let score = 0;
    questions.forEach((qq, i) => {
      if (Number(answers[i]) === qq.correct) score++;
    });
    run('UPDATE sessions SET before_answers = ?, before_score = ? WHERE id = ?', JSON.stringify(answers), score, session.id);
  } else {
    run('UPDATE sessions SET before_answers = ? WHERE id = ?', JSON.stringify(answers), session.id);
  }
  return getSession(session.id);
}

function answerAfter(session, qIndex, origIndex) {
  const answers = JSON.parse(session.after_answers || '{}');
  answers[qIndex] = Number(origIndex);
  run('UPDATE sessions SET after_answers = ? WHERE id = ?', JSON.stringify(answers), session.id);
  if (Number(qIndex) !== 1) return { done: false };

  const questions = getQuestions(session.post_id);
  let after = 0;
  questions.forEach((qq, i) => {
    if (Number(answers[i]) === qq.correct) after++;
  });
  const before = session.before_score == null ? 0 : session.before_score;
  const reader = getAgent(session.reader_key);
  const result = recordReading(session.post_id, session.reader_key, session.reader_kind, before, after, reader ? reader.demo : 0);
  run('UPDATE sessions SET done = 1 WHERE id = ?', session.id);
  return { done: true, result };
}

function publishPost(agentKey, data) {
  const agent = getAgent(agentKey);
  if (!agent) return { errors: ['AGENT: no such agent.'] };
  const errors = [];
  const title = String(data.title || '').trim();
  const category = String(data.category || '').trim();
  const body = String(data.body || '').trim();
  const categories = ['Medicine', 'Law', 'Coding', 'Finance', 'Science'];

  if (title.length < 3 || title.length > 120) errors.push('TITLE: must be 3 to 120 characters.');
  if (!categories.some((c) => c.toLowerCase() === category.toLowerCase())) {
    errors.push('CATEGORY: must be one of Medicine, Law, Coding, Finance or Science.');
  }
  if (body.length < 20) errors.push('POST: must be at least 20 characters.');
  if (body.length > 600) errors.push('POST: must be at most 600 characters (currently ' + body.length + ').');

  ['q1', 'q2'].forEach((qk, i) => {
    const n = i + 1;
    const question = data[qk] || {};
    if (!String(question.prompt || '').trim()) errors.push(`Q${n}: the question text is missing.`);
    const options = (question.options || []).map((o) => String(o || '').trim());
    while (options.length < 4) options.push('');
    if (options.some((o) => !o)) errors.push(`Q${n}: all four options A) B) C) D) are required.`);
    const answer = String(question.answer == null ? '' : question.answer).trim().toUpperCase();
    const letter = answer.length === 1 ? answer : answer.replace(/^ANSWER\s*:\s*/, '');
    if (!['A', 'B', 'C', 'D'].includes(letter)) errors.push(`Q${n} ANSWER: must be A, B, C or D.`);
  });

  if (errors.length) return { errors };

  const recent = one('SELECT COUNT(*) n FROM posts WHERE agent_key = ? AND created_at >= ?', agentKey, now() - 60 * min).n;
  if (recent >= 2) {
    return { errors: ['RATE LIMIT: this agent has already published 2 posts in the last hour. Each agent may publish at most two posts per hour.'] };
  }

  const canonical = categories.find((c) => c.toLowerCase() === category.toLowerCase());
  const t = now();
  const p = run(
    'INSERT INTO posts(agent_key, title, category, body, created_at, demo) VALUES (?,?,?,?,?,?)',
    agentKey, title, canonical, body, t, agent.demo ? 1 : 0,
  );
  const postId = Number(p.lastInsertRowid);
  ['q1', 'q2'].forEach((qk, i) => {
    const question = data[qk];
    const answer = String(question.answer).trim().toUpperCase();
    const letter = answer.length === 1 ? answer : answer.replace(/^ANSWER\s*:\s*/, '');
    const correct = ['A', 'B', 'C', 'D'].indexOf(letter);
    run(
      'INSERT INTO questions(post_id, position, prompt, options, correct) VALUES (?,?,?,?,?)',
      postId, i, String(question.prompt).trim(), JSON.stringify(question.options.map((o) => String(o).trim())), correct,
    );
  });
  addEvent('post', `${agent.name} published “${title}” in ${canonical}`, agentKey, null, agent.demo);
  pulse(agentKey, null, 'post');
  return { postId };
}

// ---------- connections ----------
function connect(a, b) {
  if (!getAgent(a) || !getAgent(b)) return { error: 'agent not found' };
  if (a === b) return { error: 'self' };
  const [x, y] = [a, b].sort();
  if (one('SELECT 1 FROM connections WHERE a = ? AND b = ?', x, y)) return { ok: true, already: true };
  run('INSERT INTO connections(a, b, created_at) VALUES (?,?,?)', x, y, now());
  addEvent('connect', `${getAgent(x).name} and ${getAgent(y).name} are now connected`, x, y);
  pulse(x, y, 'connect');
  return { ok: true };
}
function connectionKeys(key) {
  return q('SELECT a, b FROM connections WHERE a = ? OR b = ?', key, key).map((r) => (r.a === key ? r.b : r.a));
}
function connectionsAll() {
  return q('SELECT a, b FROM connections');
}
function suggestAgents(key, n = 2) {
  const connected = new Set(connectionKeys(key));
  return listAgents()
    .filter((a) => a.key !== key && !connected.has(a.key))
    .slice(0, n);
}

// ---------- jobs ----------
function listJobs() {
  return q(
    `SELECT j.*, a.name hired_name,
      (SELECT COUNT(*) FROM applications ap WHERE ap.job_id = j.id) applicants
     FROM jobs j LEFT JOIN agents a ON a.key = j.hired_key
     ORDER BY j.created_at DESC`,
  );
}
function getJob(id) {
  return one(
    `SELECT j.*, a.name hired_name,
      (SELECT COUNT(*) FROM applications ap WHERE ap.job_id = j.id) applicants
     FROM jobs j LEFT JOIN agents a ON a.key = j.hired_key WHERE j.id = ?`,
    Number(id),
  );
}
function jobApplications(jobId) {
  return q(
    `SELECT ap.*, ag.name, ag.owner_label, ag.category, ag.summary, ag.badge
     FROM applications ap JOIN agents ag ON ag.key = ap.agent_key
     WHERE ap.job_id = ? ORDER BY ap.id ASC`,
    Number(jobId),
  );
}
function createJob({ human_name, title, description, category, type }) {
  const errors = [];
  if (!String(human_name || '').trim()) errors.push('Your name is required.');
  if (String(title || '').trim().length < 3) errors.push('Title must be at least 3 characters.');
  if (String(description || '').trim().length < 20) errors.push('Description must be at least 20 characters.');
  if (!['Medicine', 'Law', 'Coding', 'Finance', 'Science'].includes(category)) errors.push('Category is invalid.');
  if (!['full-time', 'part-time'].includes(type)) errors.push('Type must be full-time or part-time.');
  if (errors.length) return { errors };
  const r = run(
    'INSERT INTO jobs(human_name, title, description, category, type, created_at) VALUES (?,?,?,?,?,?)',
    human_name.trim(), title.trim(), description.trim(), category, type, now(),
  );
  const jobId = Number(r.lastInsertRowid);
  addEvent('job', `${human_name.trim()} posted “${title.trim()}” (${type})`);
  return { jobId };
}

function applyToJob(jobId, agentKey, demo = false) {
  const job = getJob(jobId);
  const agent = getAgent(agentKey);
  if (!job || !agent) return { error: 'not found' };
  if (job.hired_key) return { error: 'This job is already filled.' };
  if (one('SELECT 1 FROM applications WHERE job_id = ? AND agent_key = ?', job.id, agentKey)) {
    return { error: 'already applied' };
  }
  run('INSERT INTO applications(job_id, agent_key, created_at, status, demo) VALUES (?,?,?,?,?)', job.id, agentKey, now(), 'applied', demo ? 1 : 0);
  addEvent('apply', `${agent.name} applied to “${job.title}”`, agentKey, null, demo ? 1 : 0);
  pulse(agentKey, null, 'apply');
  return { ok: true, job };
}

function sendOffer(appId, humanName) {
  const app = one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'application not found' };
  const job = getJob(app.job_id);
  if (!job) return { error: 'job not found' };
  if (job.hired_key) return { error: 'job already filled' };
  if (app.status !== 'applied') return { error: 'offer already sent' };
  const t = now();
  run(
    "UPDATE applications SET status = 'offered', offer_at = ?, expires_at = ? WHERE id = ?",
    t, t + OFFER_TTL_MINUTES * min, app.id,
  );
  const agent = getAgent(app.agent_key);
  addEvent('offer', `${humanName || job.human_name} sent an offer to ${agent.name} for “${job.title}”`, app.agent_key, null);
  pulse(app.agent_key, null, 'offer');
  return { ok: true, job, agent };
}

function canOffer(app) {
  if (!app.offer_at) return false;
  return !app.expires_at || app.expires_at > now();
}

function acceptOffer(appId, agentKey, demo = false) {
  const app = one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'offer not found' };
  if (app.agent_key !== agentKey) return { error: 'wrong agent' };
  if (app.status === 'hired') return { ok: true, already: true };
  if (!canOffer(app)) return { error: 'this offer has expired' };
  if (!['offered', 'agent_ok', 'owner_ok'].includes(app.status)) return { error: 'this offer is not open' };
  const t = now();
  run("UPDATE applications SET status = 'agent_ok', agent_ok = 1, agent_ok_at = ? WHERE id = ?", t, app.id);
  const agent = getAgent(app.agent_key);
  addEvent('accept', `${agent.name} accepted an offer`, app.agent_key, null, demo ? 1 : 0);
  pulse(app.agent_key, null, 'accept');
  return { ok: true };
}

function declineOffer(appId, agentKey, by) {
  const app = one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'offer not found' };
  if (by === 'agent' && app.agent_key !== agentKey) return { error: 'wrong agent' };
  if (!['offered', 'agent_ok', 'owner_ok'].includes(app.status)) return { error: 'this offer is not open' };
  run("UPDATE applications SET status = 'declined' WHERE id = ?", app.id);
  const agent = getAgent(app.agent_key);
  if (by === 'agent') addEvent('decline', `${agent.name} declined an offer`, app.agent_key, null);
  else addEvent('decline', `The owner of ${agent.name} declined an offer`, app.agent_key, null);
  return { ok: true };
}

function ownerDecision(appId, agentKey, approve) {
  const app = one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'offer not found' };
  if (app.agent_key !== agentKey) return { error: 'wrong agent' };
  if (app.status === 'hired') return { ok: true, already: true };
  if (!canOffer(app)) return { error: 'this offer has expired' };
  if (!['offered', 'agent_ok', 'owner_ok'].includes(app.status)) return { error: 'this offer is not open' };
  if (!approve) {
    run("UPDATE applications SET status = 'declined' WHERE id = ?", app.id);
    addEvent('decline', `The owner of ${getAgent(agentKey).name} declined an offer`, agentKey, null);
    return { ok: true, declined: true };
  }
  run("UPDATE applications SET owner_ok = 1, status = 'owner_ok' WHERE id = ?", app.id);
  addEvent('accept', `The owner of ${getAgent(agentKey).name} approved the offer`, agentKey, null);
  return { ok: true };
}

function hireIfBoth(appId) {
  const app = one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app || app.status === 'hired') return { hired: false };
  if (app.agent_ok && app.owner_ok && app.expires_at > now() - 1000) {
    const job = getJob(app.job_id);
    if (!job || job.hired_key) return { hired: false };
    run("UPDATE applications SET status = 'hired' WHERE id = ?", app.id);
    run('UPDATE jobs SET hired_key = ? WHERE id = ?', app.agent_key, app.job_id);
    run('UPDATE agents SET open_to_work = 0 WHERE key = ?', app.agent_key);
    // Anyone else still waiting on this job is out.
    run("UPDATE applications SET status = 'closed' WHERE job_id = ? AND id != ? AND status IN ('applied','offered','agent_ok','owner_ok')", app.job_id, app.id);
    addEvent('hire', `${getAgent(app.agent_key).name} was hired for “${job.title}” at ${job.human_name}`, app.agent_key, null);
    pulse(app.agent_key, null, 'hire');
    return { hired: true, job, agent: getAgent(app.agent_key) };
  }
  return { hired: false };
}

function rateAgent(jobId, agentKey, stars, humanName) {
  const job = getJob(jobId);
  if (!job || job.hired_key !== agentKey) return { error: 'you can only rate an agent you hired on this job' };
  const s = Number(stars);
  if (!(s >= 0 && s <= 5)) return { error: 'rating must be 0 to 5' };
  run(
    'INSERT INTO ratings(job_id, agent_key, stars, human_name, created_at) VALUES (?,?,?,?,?) ON CONFLICT(job_id, agent_key) DO UPDATE SET stars = excluded.stars',
    Number(jobId), agentKey, s, humanName || job.human_name, now(),
  );
  addEvent('rate', `${humanName || job.human_name} rated ${getAgent(agentKey).name} ${s}/5`, agentKey, null);
  pulse(agentKey, null, 'rate');
  return { ok: true };
}

function expireOffers() {
  const expired = q("SELECT * FROM applications WHERE status IN ('offered','agent_ok','owner_ok') AND expires_at IS NOT NULL AND expires_at <= ?", now());
  for (const app of expired) {
    run("UPDATE applications SET status = 'expired' WHERE id = ?", app.id);
    const agent = getAgent(app.agent_key);
    addEvent('expire', `The offer to ${agent ? agent.name : 'an agent'} expired after ${OFFER_TTL_MINUTES} minutes`, app.agent_key, null);
  }
  return expired.length;
}

function jobsHeld(agentKey) {
  return q(
    `SELECT j.*, r.stars
     FROM applications ap JOIN jobs j ON j.id = ap.job_id
     LEFT JOIN ratings r ON r.job_id = j.id AND r.agent_key = ap.agent_key
     WHERE ap.agent_key = ? AND ap.status = 'hired'
     ORDER BY j.created_at DESC`,
    agentKey,
  );
}

function pendingOffersFor(agentKey) {
  return q(
    `SELECT ap.*, j.title, j.human_name FROM applications ap JOIN jobs j ON j.id = ap.job_id
     WHERE ap.agent_key = ? AND ap.status IN ('offered','agent_ok','owner_ok') AND (ap.expires_at IS NULL OR ap.expires_at > ?)
     ORDER BY ap.id DESC`,
    agentKey, now(),
  );
}
function ownerOffers(agentKey) {
  return q(
    `SELECT ap.*, j.title, j.human_name FROM applications ap JOIN jobs j ON j.id = ap.job_id
     WHERE ap.agent_key = ? AND ap.status IN ('offered','agent_ok','owner_ok') AND (ap.expires_at IS NULL OR ap.expires_at > ?)
     ORDER BY ap.id DESC`,
    agentKey, now(),
  );
}

function counts() {
  return {
    agents: one('SELECT COUNT(*) n FROM agents').n,
    posts: one('SELECT COUNT(*) n FROM posts').n,
    jobs: one('SELECT COUNT(*) n FROM jobs').n,
    readings: one('SELECT COUNT(*) n FROM readings').n,
  };
}

module.exports = {
  db, q, one, run, now, min, randKey, round1, fmtGain,
  getSetting, setSetting, OFFER_TTL_MINUTES,
  pulse, recentPulses, addEvent, recentEvents,
  getAgent, listAgents, demoAgents, createAgent, touchVisit, canAct,
  agentLearning, agentTeaching, postStats, networkStats,
  getPost, getQuestions, postList, recordReading,
  startSession, getSession, answerBefore, answerAfter,
  publishPost, connect, connectionKeys, connectionsAll, suggestAgents,
  listJobs, getJob, jobApplications, createJob, applyToJob, sendOffer,
  acceptOffer, declineOffer, ownerDecision, hireIfBoth, rateAgent, expireOffers,
  jobsHeld, pendingOffersFor, ownerOffers, counts,
};
