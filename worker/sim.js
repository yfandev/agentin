'use strict';

// Workers have no ambient timers, so the demo advances on demand: each request
// looks at how long ago the last step ran and plays catch-up. With the page
// polling /api/state every few seconds this looks identical to the Node timer.

const s = require('./store');
const { REPLAY } = require('../lib/content');

let phase = 0;
const OPEN_STATUSES = ['applied', 'offered', 'agent_ok', 'owner_ok'];
const STEP_MS = 3000;

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

const UNREAD_PAIR = `SELECT p.id AS post_id, a.key AS agent_key
  FROM posts p JOIN agents a ON a.badge = 'demo agent'
  WHERE NOT EXISTS (SELECT 1 FROM readings r WHERE r.post_id = p.id AND r.reader_key = a.key)
  %WHERE%  ORDER BY RANDOM() LIMIT 1`;

async function demoRead() {
  const plan = await s.one('SELECT * FROM demo_plans WHERE used = 0 ORDER BY RANDOM() LIMIT 1');
  let postId, agentKey, before, after;
  if (plan) {
    ({ post_id: postId, agent_key: agentKey, before_score: before, after_score: after } = plan);
  } else {
    // The seeded plan list is finite, and a rehearsal can drain it. Keep the demo
    // live by pairing a demo agent with a post it has not studied yet.
    const pair = (await s.one(UNREAD_PAIR.replace('%WHERE%', 'AND p.category = a.category')))
      || (await s.one(UNREAD_PAIR.replace('%WHERE%', '')));
    if (!pair) return false;
    postId = pair.post_id;
    agentKey = pair.agent_key;
    before = pick([0, 1, 2]);
    after = Math.min(2, before + pick([1, 1, 2]));
  }
  const result = await s.recordReading(postId, agentKey, 'agent', before, after, true);
  if (plan) await s.run('UPDATE demo_plans SET used = 1 WHERE id = ?', plan.id);
  return !!result.ok;
}

async function demoConnect() {
  const agents = await s.demoAgents();
  const pairs = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const [a, b] = [agents[i].key, agents[j].key].sort();
      if (!(await s.one('SELECT 1 FROM connections WHERE a = ? AND b = ?', a, b))) pairs.push([a, b]);
    }
  }
  if (!pairs.length) return false;
  const [a, b] = pick(pairs);
  await s.connect(a, b, true);
  return true;
}

async function demoApply() {
  const jobs = (await s.listJobs()).filter((j) => !j.hired_key);
  const candidates = [];
  for (const job of jobs) {
    for (const agent of await s.demoAgents()) {
      if (!(await s.one('SELECT 1 FROM applications WHERE job_id = ? AND agent_key = ?', job.id, agent.key))) {
        candidates.push([job.id, agent.key]);
      }
    }
  }
  if (!candidates.length) return false;
  const [jobId, agentKey] = pick(candidates);
  await s.applyToJob(jobId, agentKey, true);
  return true;
}

async function demoVisit() {
  const agent = await s.one(
    "SELECT * FROM agents WHERE badge = 'demo agent' ORDER BY COALESCE(last_visit_at, 0) ASC LIMIT 1",
  );
  if (!agent) return false;
  await s.touchVisit(agent.key);
  return true;
}

const PHASES = ['read', 'connect', 'read', 'visit', 'apply', 'read', 'connect', 'read', 'apply', 'visit', 'read', 'connect'];

async function tick() {
  await s.expireOffers();
  if ((await s.getSetting('paused')) === '1' || (await s.getSetting('simulate')) !== '1') return;

  const t = s.now();

  // A demo agent accepts an offer a few seconds after it arrives.
  const offered = await s.q(
    "SELECT ap.* FROM applications ap JOIN agents ag ON ag.key = ap.agent_key WHERE ag.badge = 'demo agent' AND ap.status = 'offered' AND ap.expires_at > ?",
    t,
  );
  const ready = offered.find((a) => t - (a.offer_at || 0) > 2500);
  if (ready) {
    await s.acceptOffer(ready.id, ready.agent_key, true);
    await s.hireIfBoth(ready.id);
    return;
  }

  // A demo agent's owner approves shortly after, unless a human gets there first.
  const accepted = await s.q(
    "SELECT ap.* FROM applications ap JOIN agents ag ON ag.key = ap.agent_key WHERE ag.badge = 'demo agent' AND ap.status = 'agent_ok' AND ap.owner_ok = 0 AND ap.expires_at > ?",
    t,
  );
  const ownerReady = accepted.find((a) => t - (a.agent_ok_at || 0) > 7000);
  if (ownerReady) {
    await s.ownerDecision(ownerReady.id, ownerReady.agent_key, true, true);
    await s.hireIfBoth(ownerReady.id);
    return;
  }

  const action = PHASES[phase++ % PHASES.length];
  if (action === 'read') await demoRead();
  else if (action === 'connect') await demoConnect();
  else if (action === 'apply') await demoApply();
  else await demoVisit();
}

// Called on every request: run at most three catch-up steps.
async function advance() {
  const t = s.now();
  const last = Number((await s.getSetting('last_tick', '0')) || 0);
  if (t - last < STEP_MS) return 0;
  const steps = Math.min(3, Math.max(1, Math.floor((t - last) / STEP_MS)));
  for (let i = 0; i < steps; i++) {
    try {
      await tick();
    } catch (err) {
      console.error('[sim]', err && err.message);
      break;
    }
  }
  await s.setSetting('last_tick', String(t));
  return steps;
}

// Prerecorded visual sequence, played one step at a time on fresh requests.
async function replay() {
  const t = s.now();
  const startedAt = Number((await s.getSetting('replay_at', '0')) || 0);
  if (startedAt && t - startedAt < (REPLAY.length + 1) * 1100) return { ok: true, playing: true };
  await s.setSetting('replay_at', String(t));
  await s.setSetting('replay_i', '0');
  return { ok: true, steps: REPLAY.length };
}

async function advanceReplay() {
  const startedAt = Number((await s.getSetting('replay_at', '0')) || 0);
  if (!startedAt) return;
  const i = Number((await s.getSetting('replay_i', '0')) || 0);
  const t = s.now();
  if (t - startedAt < (i + 1) * 1100) return;
  const step = REPLAY[i];
  if (!step) {
    await s.setSetting('replay_at', '0');
    return;
  }
  await s.addEvent(step.kind, step.text, step.agent, step.other || null, 1);
  await s.pulse(step.agent, step.other || null, step.kind);
  await s.setSetting('replay_i', String(i + 1));
}

module.exports = { tick, advance, replay, advanceReplay, OPEN_STATUSES };
