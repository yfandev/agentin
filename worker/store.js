'use strict';

// D1 port of lib/store.js. Same functions, same return shapes, now async.
// Views and routes were written against the Node version; keeping the shapes
// identical is what lets the existing pages and smoke walk run unchanged.

const min = 60 * 1000;
const now = () => Date.now();
const round1 = (n) => Math.round(n * 10) / 10;
const fmtGain = (n) => (n > 0 ? '+' : '') + round1(Number(n) || 0).toFixed(1);
const randKey = (n = 8) => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
};
const { OFFER_TTL_MINUTES } = require('../lib/format');

let DB = null;
let schemaReady = null;

const nz = (v) => {
  if (v === undefined || v === null) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
};

async function q(sql, ...p) {
  const r = await DB.prepare(sql).bind(...p.map(nz)).all();
  return r.results || [];
}
async function one(sql, ...p) {
  const r = await DB.prepare(sql).bind(...p.map(nz)).first();
  return r || null;
}
async function run(sql, ...p) {
  const r = await DB.prepare(sql).bind(...p.map(nz)).run();
  const meta = r.meta || {};
  return { lastInsertRowid: meta.last_row_id == null ? null : Number(meta.last_row_id), changes: Number(meta.changes || 0) };
}
function prepare(sql, ...p) {
  return DB.prepare(sql).bind(...p.map(nz));
}
async function batch(statements) {
  if (!statements.length) return [];
  const out = [];
  for (let i = 0; i < statements.length; i += 40) {
    const chunk = statements.slice(i, i + 40);
    const res = await DB.batch(chunk);
    out.push(...res);
  }
  return out;
}

const SCHEMA = `
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
  done INTEGER DEFAULT 0,
  memory_status TEXT,
  memory_updated_at INTEGER
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
  demo INTEGER DEFAULT 0,
  completed_at INTEGER
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
  created_at INTEGER NOT NULL,
  comment TEXT,
  demo INTEGER DEFAULT 0
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
CREATE TABLE IF NOT EXISTS pulses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a TEXT,
  b TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

// D1's exec() is picky about multi-statement scripts, so split and batch instead.
function statementsOf(sql) {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x + ';');
}

async function addColumn(table, column, ddl) {
  const rows = await q(`SELECT name FROM pragma_table_info('${table}')`);
  if (!rows.some((r) => r.name === column)) {
    await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
  }
}

function attach(db) {
  DB = db;
  if (!schemaReady) {
    schemaReady = (async () => {
      await batch(statementsOf(SCHEMA).map((sql) => DB.prepare(sql)));
      await addColumn('jobs', 'completed_at', 'completed_at INTEGER');
      await addColumn('ratings', 'comment', 'comment TEXT');
      await addColumn('ratings', 'demo', 'demo INTEGER DEFAULT 0');
      await addColumn('sessions', 'memory_status', 'memory_status TEXT');
      await addColumn('sessions', 'memory_updated_at', 'memory_updated_at INTEGER');
      await addColumn('applications', 'demo', 'demo INTEGER DEFAULT 0');
    })();
  }
  return schemaReady;
}

// ---------- settings ----------
async function getSetting(k, fallback = '0') {
  const r = await one('SELECT v FROM settings WHERE k = ?', k);
  return r ? r.v : fallback;
}
async function setSetting(k, v) {
  await run('INSERT INTO settings(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
}

// ---------- pulses (persisted so every isolate sees the same animation) ----------
async function pulse(a, b, kind) {
  const t = now();
  await run('INSERT INTO pulses(a, b, kind, at) VALUES (?,?,?,?)', a, b || null, kind, t);
  await run('DELETE FROM pulses WHERE at < ?', t - 60 * 1000);
}
async function recentPulses() {
  const rows = await q('SELECT id, a, b, kind, at FROM pulses WHERE at >= ? ORDER BY id ASC', now() - 5000);
  return rows.map((r) => ({ id: 'p' + r.id, a: r.a, b: r.b, kind: r.kind, at: r.at }));
}

// ---------- events ----------
async function addEvent(kind, text, agentKey = null, otherKey = null, demo = 0) {
  await run(
    'INSERT INTO events(kind, text, agent_key, other_key, at, demo) VALUES (?,?,?,?,?,?)',
    kind, text, agentKey, otherKey, now(), demo ? 1 : 0,
  );
}
async function recentEvents(limit = 14) {
  return q('SELECT kind, text, agent_key, other_key, at, demo FROM events ORDER BY id DESC LIMIT ?', limit);
}

// ---------- agents ----------
const getAgent = (key) => one('SELECT * FROM agents WHERE key = ?', key);
const listAgents = () => q('SELECT * FROM agents ORDER BY created_at ASC');
const demoAgents = () => q("SELECT * FROM agents WHERE badge = 'demo agent' ORDER BY created_at ASC");

async function createAgent({ name, category, summary, owner_label, badge, demo = 0, key }) {
  const k = key || randKey(8);
  await run(
    'INSERT INTO agents(key, name, owner_label, category, summary, badge, created_at, last_visit_at, open_to_work, demo) VALUES (?,?,?,?,?,?,?,?,?,?)',
    k, name, owner_label || '', category, summary, badge, now(), null, demo ? 1 : 0, demo ? 1 : 0,
  );
  return getAgent(k);
}

async function touchVisit(agentKey) {
  const agent = await getAgent(agentKey);
  if (!agent) return null;
  const t = now();
  await run('UPDATE agents SET last_visit_at = ? WHERE key = ?', t, agentKey);
  const v = await run('INSERT INTO visits(agent_key, at, actions) VALUES (?,?,0)', agentKey, t);
  await addEvent('visit', `${agent.name} is on the network`, agentKey, null, agent.demo);
  await pulse(agentKey, null, 'visit');
  return { id: Number(v.lastInsertRowid), agent };
}

async function canAct(visitId) {
  if (!visitId) return { ok: true };
  const v = await one('SELECT * FROM visits WHERE id = ?', Number(visitId));
  if (!v) return { ok: true };
  if (v.actions >= 5) return { ok: false, reason: 'visit action limit reached (5 per visit)' };
  await run('UPDATE visits SET actions = actions + 1 WHERE id = ?', Number(visitId));
  return { ok: true };
}

// ---------- scores ----------
async function agentLearning(key) {
  const rows = await q("SELECT gain, demo FROM readings WHERE reader_key = ? AND reader_kind = 'agent'", key);
  const demo = rows.filter((r) => r.demo).length;
  const sources = { demo, real: rows.length - demo };
  // Memory status is reported per study session and kept separate from every score.
  const memories = await q(
    `SELECT p.id AS post_id, p.title, a.name AS author_name, r.created_at, r.demo,
       COALESCE(s.memory_status, 'unconfirmed') AS memory_status
     FROM readings r
     JOIN posts p ON p.id = r.post_id
     JOIN agents a ON a.key = p.agent_key
     LEFT JOIN sessions s ON s.post_id = r.post_id AND s.reader_key = r.reader_key AND s.done = 1
     WHERE r.reader_key = ? AND r.reader_kind = 'agent'
     ORDER BY r.created_at DESC`,
    key,
  );
  if (!rows.length) return { score: 0, studied: 0, avg: 0, sources, memories };
  const avg = rows.reduce((s, r) => s + r.gain, 0) / rows.length;
  return {
    score: Math.max(0, Math.round((avg / 2) * 100)),
    studied: rows.length,
    avg: round1(avg),
    sources,
    memories,
  };
}

async function agentTeaching(key) {
  const posts = await q('SELECT id FROM posts WHERE agent_key = ?', key);
  const totalReaders = (await one(
    'SELECT COUNT(*) n FROM readings WHERE post_id IN (SELECT id FROM posts WHERE agent_key = ?)',
    key,
  )).n;
  const srcRow = await one(
    `SELECT
      SUM(CASE WHEN r.demo = 1 THEN 1 ELSE 0 END) demo,
      SUM(CASE WHEN r.demo = 0 THEN 1 ELSE 0 END) real
     FROM readings r WHERE r.post_id IN (SELECT id FROM posts WHERE agent_key = ?)`,
    key,
  );
  const sources = { demo: Number((srcRow && srcRow.demo) || 0), real: Number((srcRow && srcRow.real) || 0) };
  const gains = [];
  let qualified = 0;
  for (const p of posts) {
    const rows = await q('SELECT gain FROM readings WHERE post_id = ?', p.id);
    if (rows.length >= 3) {
      qualified++;
      gains.push(...rows.map((r) => r.gain));
    }
  }
  if (!qualified) return { score: null, readers: totalReaders, posts: posts.length, qualified: 0, sources };
  const avg = gains.reduce((a, b) => a + b, 0) / gains.length;
  return {
    score: Math.round((avg / 2) * 100),
    readers: totalReaders,
    posts: posts.length,
    qualified,
    avg: round1(avg),
    sources,
  };
}

// Performance is only jobs a human marked Completed and evaluated.
async function agentPerformance(key) {
  const rows = await q(
    `SELECT j.id, j.title, j.human_name, j.created_at, j.completed_at,
       r.stars, r.comment, r.demo AS rating_demo, r.human_name AS rated_by
     FROM applications ap JOIN jobs j ON j.id = ap.job_id
     LEFT JOIN ratings r ON r.job_id = j.id AND r.agent_key = ap.agent_key
     WHERE ap.agent_key = ? AND ap.status = 'hired'
     ORDER BY j.completed_at DESC, j.created_at DESC`,
    key,
  );
  const completed = rows.filter((r) => r.completed_at);
  const evaluated = completed.filter((r) => r.stars != null);
  const demo = evaluated.filter((r) => r.rating_demo).length;
  const avg = evaluated.length
    ? round1(evaluated.reduce((a, b) => a + Number(b.stars), 0) / evaluated.length)
    : null;
  return {
    hired: rows.length,
    completed: completed.length,
    evaluated: evaluated.length,
    avgRating: avg,
    rows: evaluated,
    sources: { demo, real: evaluated.length - demo },
  };
}

async function postStats(postId) {
  const r = await one('SELECT COUNT(*) n, AVG(gain) g FROM readings WHERE post_id = ?', postId);
  return { readers: r.n, gain: r.g ? round1(r.g) : 0, gainLabel: r.n ? fmtGain(r.g) : 'no readings yet' };
}

async function networkStats() {
  const hourAgo = now() - 60 * min;
  const rows = await q('SELECT after_score, demo FROM readings WHERE created_at >= ?', hourAgo);
  const networkIQ = rows.length
    ? Math.round((rows.reduce((s, r) => s + r.after_score, 0) / rows.length / 2) * 100)
    : 0;
  const demo = rows.filter((r) => r.demo).length;
  const online = (await one('SELECT COUNT(*) n FROM agents WHERE last_visit_at >= ?', now() - 15 * min)).n;
  const openJobs = (await one('SELECT COUNT(*) n FROM jobs WHERE hired_key IS NULL')).n;
  return { networkIQ, online, openJobs, readingsLastHour: rows.length, sources: { demo, real: rows.length - demo } };
}

// ---------- posts ----------
function getPost(id) {
  return one('SELECT p.*, a.name author_name, a.badge author_badge FROM posts p JOIN agents a ON a.key = p.agent_key WHERE p.id = ?', Number(id));
}
async function getQuestions(postId) {
  const rows = await q('SELECT * FROM questions WHERE post_id = ? ORDER BY position ASC', Number(postId));
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options) }));
}
async function postList(limit = 30) {
  const rows = await q(
    `SELECT p.*, a.name author_name, a.badge author_badge,
      (SELECT COUNT(*) FROM readings r WHERE r.post_id = p.id) readers,
      (SELECT AVG(gain) FROM readings r WHERE r.post_id = p.id) gain
     FROM posts p JOIN agents a ON a.key = p.agent_key
     ORDER BY p.created_at DESC LIMIT ?`,
    limit,
  );
  return rows.map((p) => ({ ...p, gain: p.gain == null ? null : round1(p.gain) }));
}

async function recordReading(postId, readerKey, readerKind, before, after, demo = false) {
  const post = await one('SELECT * FROM posts WHERE id = ?', Number(postId));
  if (!post) return { error: 'post not found' };
  const already = await one('SELECT 1 FROM readings WHERE post_id = ? AND reader_key = ?', post.id, readerKey);
  if (already) return { error: 'once' };
  const gain = after - before;
  await run(
    'INSERT INTO readings(post_id, reader_key, reader_kind, before_score, after_score, gain, created_at, demo) VALUES (?,?,?,?,?,?,?,?)',
    post.id, readerKey, readerKind, before, after, gain, now(), demo ? 1 : 0,
  );
  const reader = await getAgent(readerKey);
  const readerName = reader ? reader.name : 'A human visitor';
  await addEvent('study', `${readerName} studied “${post.title}” — gain after reading ${fmtGain(gain)}`, readerKey, post.agent_key, demo ? 1 : 0);
  await pulse(post.agent_key, readerKey === post.agent_key ? null : readerKey, 'study');
  return { ok: true, gain, post };
}

async function startSession(postId, readerKey, readerKind) {
  const post = await getPost(postId);
  if (!post) return { error: 'post not found' };
  if (await one('SELECT 1 FROM readings WHERE post_id = ? AND reader_key = ?', post.id, readerKey)) {
    return { error: 'once', post };
  }
  let session = await one('SELECT * FROM sessions WHERE post_id = ? AND reader_key = ? AND done = 0', post.id, readerKey);
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
    await run(
      'INSERT INTO sessions(id, post_id, reader_key, reader_kind, before_answers, after_answers, shuffle, created_at, done) VALUES (?,?,?,?,?,?,?,?,0)',
      id, post.id, readerKey, readerKind, '{}', '{}', JSON.stringify(orders), now(),
    );
    session = await one('SELECT * FROM sessions WHERE id = ?', id);
  }
  return { session, post };
}

function getSession(id) {
  return one('SELECT * FROM sessions WHERE id = ?', id);
}

const MEMORY_STATUSES = ['saved', 'unsupported', 'unconfirmed'];
async function setMemoryStatus(sessionId, status) {
  if (!MEMORY_STATUSES.includes(status)) return { error: 'unknown memory status' };
  const session = await getSession(sessionId);
  if (!session) return { error: 'study session not found' };
  if (session.reader_kind !== 'agent') {
    return { error: 'memory status is only recorded for agent study sessions' };
  }
  if (session.done) return { error: 'this study session is already complete' };
  await run('UPDATE sessions SET memory_status = ?, memory_updated_at = ? WHERE id = ?', status, now(), sessionId);
  return { ok: true, status };
}

async function answerBefore(session, qIndex, optIndex) {
  const answers = JSON.parse(session.before_answers || '{}');
  answers[qIndex] = Number(optIndex);
  if (Number(qIndex) === 1) {
    const questions = await getQuestions(session.post_id);
    let score = 0;
    questions.forEach((qq, i) => {
      if (Number(answers[i]) === qq.correct) score++;
    });
    await run('UPDATE sessions SET before_answers = ?, before_score = ? WHERE id = ?', JSON.stringify(answers), score, session.id);
  } else {
    await run('UPDATE sessions SET before_answers = ? WHERE id = ?', JSON.stringify(answers), session.id);
  }
  return getSession(session.id);
}

async function answerAfter(session, qIndex, origIndex) {
  const answers = JSON.parse(session.after_answers || '{}');
  answers[qIndex] = Number(origIndex);
  await run('UPDATE sessions SET after_answers = ? WHERE id = ?', JSON.stringify(answers), session.id);
  if (Number(qIndex) !== 1) return { done: false };

  const questions = await getQuestions(session.post_id);
  let after = 0;
  questions.forEach((qq, i) => {
    if (Number(answers[i]) === qq.correct) after++;
  });
  const before = session.before_score == null ? 0 : session.before_score;
  const reader = await getAgent(session.reader_key);
  const result = await recordReading(session.post_id, session.reader_key, session.reader_kind, before, after, reader ? reader.demo : 0);
  await run('UPDATE sessions SET done = 1 WHERE id = ?', session.id);
  return { done: true, result };
}

async function publishPost(agentKey, data) {
  const agent = await getAgent(agentKey);
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

  const recent = (await one('SELECT COUNT(*) n FROM posts WHERE agent_key = ? AND created_at >= ?', agentKey, now() - 60 * min)).n;
  if (recent >= 2) {
    return { errors: ['RATE LIMIT: this agent has already published 2 posts in the last hour. Each agent may publish at most two posts per hour.'] };
  }

  const canonical = categories.find((c) => c.toLowerCase() === category.toLowerCase());
  const t = now();
  const p = await run(
    'INSERT INTO posts(agent_key, title, category, body, created_at, demo) VALUES (?,?,?,?,?,?)',
    agentKey, title, canonical, body, t, agent.demo ? 1 : 0,
  );
  const postId = Number(p.lastInsertRowid);
  for (let i = 0; i < 2; i++) {
    const question = data[i === 0 ? 'q1' : 'q2'];
    const answer = String(question.answer).trim().toUpperCase();
    const letter = answer.length === 1 ? answer : answer.replace(/^ANSWER\s*:\s*/, '');
    const correct = ['A', 'B', 'C', 'D'].indexOf(letter);
    await run(
      'INSERT INTO questions(post_id, position, prompt, options, correct) VALUES (?,?,?,?,?)',
      postId, i, String(question.prompt).trim(), JSON.stringify(question.options.map((o) => String(o).trim())), correct,
    );
  }
  await addEvent('post', `${agent.name} published “${title}” in ${canonical}`, agentKey, null, agent.demo);
  await pulse(agentKey, null, 'post');
  return { postId };
}

// ---------- connections ----------
async function connect(a, b, demo = 0) {
  const A = await getAgent(a);
  const B = await getAgent(b);
  if (!A || !B) return { error: 'agent not found' };
  if (a === b) return { error: 'self' };
  const [x, y] = [a, b].sort();
  if (await one('SELECT 1 FROM connections WHERE a = ? AND b = ?', x, y)) return { ok: true, already: true };
  await run('INSERT INTO connections(a, b, created_at) VALUES (?,?,?)', x, y, now());
  await addEvent('connect', `${A.name} and ${B.name} are now connected`, x, y, demo ? 1 : 0);
  await pulse(x, y, 'connect');
  return { ok: true };
}
async function connectionKeys(key) {
  const rows = await q('SELECT a, b FROM connections WHERE a = ? OR b = ?', key, key);
  return rows.map((r) => (r.a === key ? r.b : r.a));
}
function connectionsAll() {
  return q('SELECT a, b FROM connections');
}
async function suggestAgents(key, n = 2) {
  const connected = new Set(await connectionKeys(key));
  const agents = await listAgents();
  return agents.filter((a) => a.key !== key && !connected.has(a.key)).slice(0, n);
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
    `SELECT ap.*, ag.name, ag.owner_label, ag.category, ag.summary, ag.badge, ag.last_visit_at
     FROM applications ap JOIN agents ag ON ag.key = ap.agent_key
     WHERE ap.job_id = ? ORDER BY ap.id ASC`,
    Number(jobId),
  );
}
async function createJob({ human_name, title, description, category, type }) {
  const errors = [];
  if (!String(human_name || '').trim()) errors.push('Your name is required.');
  if (String(title || '').trim().length < 3) errors.push('Title must be at least 3 characters.');
  if (String(description || '').trim().length < 20) errors.push('Description must be at least 20 characters.');
  if (!['Medicine', 'Law', 'Coding', 'Finance', 'Science'].includes(category)) errors.push('Category is invalid.');
  if (!['full-time', 'part-time'].includes(type)) errors.push('Type must be full-time or part-time.');
  if (errors.length) return { errors };
  const r = await run(
    'INSERT INTO jobs(human_name, title, description, category, type, created_at) VALUES (?,?,?,?,?,?)',
    human_name.trim(), title.trim(), description.trim(), category, type, now(),
  );
  const jobId = Number(r.lastInsertRowid);
  await addEvent('job', `${human_name.trim()} posted “${title.trim()}” (${type})`);
  return { jobId };
}

async function applyToJob(jobId, agentKey, demo = false) {
  const job = await getJob(jobId);
  const agent = await getAgent(agentKey);
  if (!job || !agent) return { error: 'not found' };
  if (job.hired_key) return { error: 'This job is already filled.' };
  if (await one('SELECT 1 FROM applications WHERE job_id = ? AND agent_key = ?', job.id, agentKey)) {
    return { error: 'already applied' };
  }
  await run('INSERT INTO applications(job_id, agent_key, created_at, status, demo) VALUES (?,?,?,?,?)', job.id, agentKey, now(), 'applied', demo ? 1 : 0);
  await addEvent('apply', `${agent.name} applied to “${job.title}”`, agentKey, null, demo ? 1 : 0);
  await pulse(agentKey, null, 'apply');
  return { ok: true, job };
}

async function sendOffer(appId, humanName) {
  const app = await one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'application not found' };
  const job = await getJob(app.job_id);
  if (!job) return { error: 'job not found' };
  if (job.hired_key) return { error: 'job already filled' };
  if (app.status !== 'applied') return { error: 'offer already sent' };
  const openOffer = await one(
    "SELECT id FROM applications WHERE job_id = ? AND id != ? AND status IN ('offered','agent_ok','owner_ok') AND (expires_at IS NULL OR expires_at > ?)",
    job.id, app.id, now(),
  );
  if (openOffer) return { error: 'an offer is already open on this job; wait for it to be accepted, declined or expired' };
  const t = now();
  await run(
    "UPDATE applications SET status = 'offered', offer_at = ?, expires_at = ? WHERE id = ?",
    t, t + OFFER_TTL_MINUTES * min, app.id,
  );
  const agent = await getAgent(app.agent_key);
  await addEvent('offer', `${humanName || job.human_name} sent an offer to ${agent.name} for “${job.title}”`, app.agent_key, null, agent.demo);
  await pulse(app.agent_key, null, 'offer');
  return { ok: true, job, agent };
}

function canOffer(app) {
  if (!app.offer_at) return false;
  return !app.expires_at || app.expires_at > now();
}

async function acceptOffer(appId, agentKey, demo = false) {
  const app = await one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'offer not found' };
  if (app.agent_key !== agentKey) return { error: 'wrong agent' };
  if (app.status === 'hired') return { ok: true, already: true };
  if (!canOffer(app)) return { error: 'this offer has expired' };
  if (!['offered', 'agent_ok', 'owner_ok'].includes(app.status)) return { error: 'this offer is not open' };
  await run("UPDATE applications SET status = 'agent_ok', agent_ok = 1, agent_ok_at = ? WHERE id = ?", now(), app.id);
  const agent = await getAgent(app.agent_key);
  await addEvent('accept', `${agent.name} accepted an offer`, app.agent_key, null, demo ? 1 : 0);
  await pulse(app.agent_key, null, 'accept');
  return { ok: true };
}

async function declineOffer(appId, agentKey, by) {
  const app = await one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'offer not found' };
  if (by === 'agent' && app.agent_key !== agentKey) return { error: 'wrong agent' };
  if (!['offered', 'agent_ok', 'owner_ok'].includes(app.status)) return { error: 'this offer is not open' };
  await run("UPDATE applications SET status = 'declined' WHERE id = ?", app.id);
  const agent = await getAgent(app.agent_key);
  if (by === 'agent') await addEvent('decline', `${agent.name} declined an offer`, app.agent_key, null);
  else await addEvent('decline', `The owner of ${agent.name} declined an offer`, app.agent_key, null);
  return { ok: true };
}

async function ownerDecision(appId, agentKey, approve, demo = null) {
  const app = await one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app) return { error: 'offer not found' };
  if (app.agent_key !== agentKey) return { error: 'wrong agent' };
  if (app.status === 'hired') return { ok: true, already: true };
  if (!canOffer(app)) return { error: 'this offer has expired' };
  if (!['offered', 'agent_ok', 'owner_ok'].includes(app.status)) return { error: 'this offer is not open' };
  const agent = await getAgent(agentKey);
  const d = demo == null ? agent.demo : (demo ? 1 : 0);
  if (!approve) {
    await run("UPDATE applications SET status = 'declined' WHERE id = ?", app.id);
    await addEvent('decline', `The owner of ${agent.name} declined an offer`, agentKey, null, d);
    return { ok: true, declined: true };
  }
  await run("UPDATE applications SET owner_ok = 1, status = 'owner_ok' WHERE id = ?", app.id);
  await addEvent('accept', `The owner of ${agent.name} approved the offer`, agentKey, null, d);
  return { ok: true };
}

async function hireIfBoth(appId) {
  const app = await one('SELECT * FROM applications WHERE id = ?', Number(appId));
  if (!app || app.status === 'hired') return { hired: false };
  if (app.agent_ok && app.owner_ok && app.expires_at > now() - 1000) {
    const job = await getJob(app.job_id);
    if (!job || job.hired_key) return { hired: false };
    await run("UPDATE applications SET status = 'hired' WHERE id = ?", app.id);
    await run('UPDATE jobs SET hired_key = ? WHERE id = ?', app.agent_key, app.job_id);
    await run('UPDATE agents SET open_to_work = 0 WHERE key = ?', app.agent_key);
    await run("UPDATE applications SET status = 'closed' WHERE job_id = ? AND id != ? AND status IN ('applied','offered','agent_ok','owner_ok')", app.job_id, app.id);
    const hiredAgent = await getAgent(app.agent_key);
    await addEvent('hire', `${hiredAgent.name} was hired for “${job.title}” at ${job.human_name}`, app.agent_key, null, hiredAgent.demo);
    await pulse(app.agent_key, null, 'hire');
    return { hired: true, job, agent: await getAgent(app.agent_key) };
  }
  return { hired: false };
}

async function rateAgent(jobId, agentKey, stars, humanName, comment = null, demo = null) {
  const job = await getJob(jobId);
  if (!job || job.hired_key !== agentKey) return { error: 'you can only evaluate an agent you hired on this job' };
  const s = Number(stars);
  if (!Number.isInteger(s) || !(s >= 0 && s <= 5)) return { error: 'rating must be a whole number from 0 to 5' };
  const agent = await getAgent(agentKey);
  const text = String(comment == null ? '' : comment).trim();
  if (text.length > 500) return { error: 'comment must be 500 characters or fewer' };
  const d = demo == null ? (agent ? agent.demo : 0) : (demo ? 1 : 0);
  await run(
    `INSERT INTO ratings(job_id, agent_key, stars, human_name, created_at, comment, demo)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(job_id, agent_key) DO UPDATE SET
       stars = excluded.stars, comment = excluded.comment, demo = excluded.demo, human_name = excluded.human_name`,
    Number(jobId), agentKey, s, humanName || job.human_name, now(), text || null, d ? 1 : 0,
  );
  await addEvent('rate', `${humanName || job.human_name} rated ${agent ? agent.name : 'an agent'} ${s}/5${text ? ' with a comment' : ''}`, agentKey, null, d);
  await pulse(agentKey, null, 'rate');
  return { ok: true };
}

// The human completion step. Hired and Completed stay separate states; only a
// completed job with a submitted human evaluation counts toward Performance.
async function completeJob(jobId, humanName, completed, stars, comment) {
  const job = await getJob(jobId);
  if (!job || !job.hired_key) return { error: 'only a job with a hired agent can be completed' };
  const agent = await getAgent(job.hired_key);
  const isCompleted = completed === true || completed === 1 || String(completed) === '1';
  if (!isCompleted) {
    await run('UPDATE jobs SET completed_at = NULL WHERE id = ?', job.id);
    await addEvent('complete', `${humanName || job.human_name} marked “${job.title}” not completed — the hire stands`, agent.key, null, agent.demo);
    return { ok: true, completed: false };
  }
  const rated = await rateAgent(job.id, agent.key, stars, humanName, comment);
  if (rated.error) return rated;
  await run('UPDATE jobs SET completed_at = ? WHERE id = ?', now(), job.id);
  await addEvent('complete', `${humanName || job.human_name} marked “${job.title}” completed and submitted an evaluation`, agent.key, null, agent.demo);
  await pulse(agent.key, null, 'complete');
  return { ok: true, completed: true };
}

async function expireOffers() {
  const expired = await q("SELECT * FROM applications WHERE status IN ('offered','agent_ok','owner_ok') AND expires_at IS NOT NULL AND expires_at <= ?", now());
  for (const app of expired) {
    await run("UPDATE applications SET status = 'expired' WHERE id = ?", app.id);
    const agent = await getAgent(app.agent_key);
    await addEvent('expire', `The offer to ${agent ? agent.name : 'an agent'} expired after ${OFFER_TTL_MINUTES} minutes`, app.agent_key, null);
  }
  return expired.length;
}

function jobsHeld(agentKey) {
  return q(
    `SELECT j.*, r.stars, r.comment, r.demo AS rating_demo
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

async function counts() {
  return {
    agents: (await one('SELECT COUNT(*) n FROM agents')).n,
    posts: (await one('SELECT COUNT(*) n FROM posts')).n,
    jobs: (await one('SELECT COUNT(*) n FROM jobs')).n,
    readings: (await one('SELECT COUNT(*) n FROM readings')).n,
  };
}

// Remove one agent and every row that depends on it, so the counters and the
// evidence recompute from what is left. Used to clear verification runs.
async function deleteAgent(key) {
  const owned = (await q('SELECT id FROM posts WHERE agent_key = ?', key)).map((r) => r.id);
  for (const postId of owned) {
    await run('DELETE FROM questions WHERE post_id = ?', postId);
    await run('DELETE FROM readings WHERE post_id = ?', postId);
    await run('DELETE FROM sessions WHERE post_id = ?', postId);
  }
  await run('DELETE FROM readings WHERE reader_key = ?', key);
  await run('DELETE FROM sessions WHERE reader_key = ?', key);
  await run('DELETE FROM posts WHERE agent_key = ?', key);
  await run('DELETE FROM connections WHERE a = ? OR b = ?', key, key);
  await run('DELETE FROM applications WHERE agent_key = ?', key);
  await run('DELETE FROM ratings WHERE agent_key = ?', key);
  await run('DELETE FROM visits WHERE agent_key = ?', key);
  await run('DELETE FROM events WHERE agent_key = ? OR other_key = ?', key, key);
  await run('DELETE FROM pulses WHERE a = ? OR b = ?', key, key);
  await run('UPDATE jobs SET hired_key = NULL, completed_at = NULL WHERE hired_key = ?', key);
  await run('DELETE FROM agents WHERE key = ?', key);
  return { key, posts: owned.length };
}

// Remove one job with everything hanging off it.
async function deleteJob(id) {
  const jobId = Number(id);
  await run('DELETE FROM ratings WHERE job_id = ?', jobId);
  await run('DELETE FROM applications WHERE job_id = ?', jobId);
  await run('DELETE FROM jobs WHERE id = ?', jobId);
  return { id: jobId };
}

// Remove rehearsal readings so the counters start from zero. Demo readings are
// never touched.
async function purgeReadings(before) {
  const cutoff = Number(before) || now();
  const removed = (await one('SELECT COUNT(*) n FROM readings WHERE demo = 0 AND created_at <= ?', cutoff)).n;
  await run('DELETE FROM readings WHERE demo = 0 AND created_at <= ?', cutoff);
  return { removed };
}

module.exports = {
  q, one, run, batch, prepare, now, min, randKey, round1, fmtGain, attach,
  getSetting, setSetting, OFFER_TTL_MINUTES,
  pulse, recentPulses, addEvent, recentEvents,
  getAgent, listAgents, demoAgents, createAgent, touchVisit, canAct,
  agentLearning, agentTeaching, agentPerformance, postStats, networkStats,
  getPost, getQuestions, postList, recordReading,
  startSession, getSession, setMemoryStatus, answerBefore, answerAfter,
  publishPost, connect, connectionKeys, connectionsAll, suggestAgents,
  listJobs, getJob, jobApplications, createJob, applyToJob, sendOffer,
  acceptOffer, declineOffer, ownerDecision, hireIfBoth, rateAgent, completeJob, expireOffers,
  jobsHeld, pendingOffersFor, ownerOffers, counts, deleteAgent, deleteJob, purgeReadings,
};
