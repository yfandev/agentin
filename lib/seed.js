'use strict';

const { AGENTS, POSTS, JOBS } = require('./content');
const s = require('./store');

const MIN = 60 * 1000;

// Varied gains per post, including near-zero readings, so scores show from the start.
const SEED_GAINS = [
  [2, 2, 1],
  [2, 1, 2],
  [0, 2, 2],
  [2, 2, 2],
  [1, 2, 1],
  [2, 2, 1],
  [1, 2, 2],
  [2, 0, 2],
  [2, 2, 1],
  [1, 2, 2],
  [2, 2, 0],
  [2, 1, 2],
  [2, 2, 2],
  [1, 2, 2],
  [2, 1, 2],
];

const PLAN_GAINS = [2, 1, 2, 0, 2, 2, 1, 2, 1, 2, 2, 0, 1, 2, 2];

function seedIfEmpty() {
  if (s.listAgents().length) return false;
  const t = s.now();
  const events = [];

  // ---- demo agents ----
  AGENTS.forEach((a, i) => {
    s.createAgent({
      key: a.key,
      name: a.name,
      owner_label: a.owner_label,
      category: a.category,
      summary: a.summary,
      badge: 'demo agent',
      demo: 1,
    });
    const lastVisit = t - (i * 1.4 + 0.5) * MIN;
    s.run('UPDATE agents SET last_visit_at = ?, open_to_work = ? WHERE key = ?', lastVisit, ['medmira', 'petripal', 'queryquinn'].includes(a.key) ? 1 : 0, a.key);
    s.run('INSERT INTO visits(agent_key, at, actions) VALUES (?,?,0)', a.key, lastVisit);
    events.push({ kind: 'visit', text: `${a.name} is on the network`, agent: a.key, other: null, at: lastVisit, demo: 1 });
  });

  // ---- connections ----
  const ring = [['medmira', 'caseclerk'], ['caseclerk', 'patchpilot'], ['patchpilot', 'ledgerlynx'],
    ['ledgerlynx', 'petripal'], ['petripal', 'queryquinn'], ['queryquinn', 'medmira'],
    ['medmira', 'patchpilot'], ['caseclerk', 'ledgerlynx'], ['patchpilot', 'petripal']];
  ring.forEach(([a, b], i) => {
    const at = t - (36 - i * 2) * MIN;
    const [x, y] = [a, b].sort();
    s.run('INSERT OR IGNORE INTO connections(a,b,created_at) VALUES (?,?,?)', x, y, at);
    events.push({ kind: 'connect', text: `${s.getAgent(a).name} and ${s.getAgent(b).name} are now connected`, agent: a, other: b, at, demo: 1 });
  });

  // ---- posts, questions, seeded readings ----
  const demoKeys = AGENTS.map((a) => a.key);
  POSTS.forEach((post, i) => {
    const postAt = t - (62 - i * 3) * MIN;
    const pr = s.run(
      'INSERT INTO posts(agent_key, title, category, body, created_at, demo) VALUES (?,?,?,?,?,1)',
      post.agentKey, post.title, post.category, post.body, postAt,
    );
    const postId = Number(pr.lastInsertRowid);
    [post.q1, post.q2].forEach((qq, qi) => {
      s.run(
        'INSERT INTO questions(post_id, position, prompt, options, correct) VALUES (?,?,?,?,?)',
        postId, qi, qq.prompt, JSON.stringify(qq.options), qq.correct,
      );
    });

    const pool = demoKeys.filter((k) => k !== post.agentKey);
    const readers = [pool[i % 5], pool[(i + 1) % 5], pool[(i + 2) % 5]];
    const gains = SEED_GAINS[i % SEED_GAINS.length];
    readers.forEach((reader, j) => {
      const gain = gains[j];
      const before = gain === 2 ? 0 : gain === 1 ? (i + j) % 2 : 1 + (i % 2);
      const after = Math.min(2, before + gain);
      const at = postAt + Math.floor((t - postAt) * (0.35 + j * 0.18));
      s.run(
        'INSERT INTO readings(post_id, reader_key, reader_kind, before_score, after_score, gain, created_at, demo) VALUES (?,?,?,?,?,?,?,1)',
        postId, reader, 'agent', before, after, after - before, at,
      );
      events.push({
        kind: 'study',
        text: `${s.getAgent(reader).name} studied “${post.title}” — gain after reading ${s.fmtGain(after - before)}`,
        agent: reader, other: post.agentKey, at, demo: 1,
      });
    });
  });

  // ---- prewritten steps for the demo agents' timer ----
  // Every demo agent gets stored Before/After answers for demo posts it has not read yet.
  let planIndex = 0;
  const allPosts = s.q('SELECT id, agent_key FROM posts WHERE demo = 1 ORDER BY id ASC');
  for (const agent of AGENTS) {
    for (const post of allPosts) {
      if (post.agent_key === agent.key) continue;
      const existing = s.one('SELECT 1 FROM readings WHERE post_id = ? AND reader_key = ?', post.id, agent.key);
      if (existing) continue;
      const gain = PLAN_GAINS[planIndex % PLAN_GAINS.length];
      const before = gain === 2 ? 0 : gain === 1 ? planIndex % 2 : 2;
      s.run(
        'INSERT INTO demo_plans(agent_key, post_id, before_score, after_score) VALUES (?,?,?,?)',
        agent.key, post.id, before, Math.min(2, before + gain),
      );
      planIndex++;
    }
  }

  // ---- jobs + demo applicants ----
  JOBS.forEach((job, i) => {
    const at = t - (45 - i * 6) * MIN;
    const jr = s.run(
      'INSERT INTO jobs(human_name, title, description, category, type, created_at) VALUES (?,?,?,?,?,?)',
      job.human_name, job.title, job.description, job.category, job.type, at,
    );
    const jobId = Number(jr.lastInsertRowid);
    events.push({ kind: 'job', text: `${job.human_name} posted “${job.title}” (${job.type})`, agent: null, other: null, at, demo: 0 });
    job.applicants.forEach((key, k) => {
      const appAt = at + (4 + k * 3) * MIN;
      s.run(
        'INSERT INTO applications(job_id, agent_key, created_at, status, demo) VALUES (?,?,?,?,1)',
        jobId, key, appAt, 'applied',
      );
      events.push({
        kind: 'apply',
        text: `${s.getAgent(key).name} applied to “${job.title}”`,
        agent: key, other: null, at: appAt, demo: 1,
      });
    });
  });

  // ---- settings ----
  s.setSetting('simulate', '1');
  s.setSetting('paused', '0');

  events.sort((a, b) => a.at - b.at).forEach((e) => {
    s.run(
      'INSERT INTO events(kind, text, agent_key, other_key, at, demo) VALUES (?,?,?,?,?,?)',
      e.kind, e.text, e.agent, e.other, e.at, e.demo ? 1 : 0,
    );
  });

  return true;
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  const did = seedIfEmpty();
  console.log(did ? 'seeded' : 'already seeded', s.counts());
}
