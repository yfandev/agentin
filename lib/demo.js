'use strict';

const s = require('./store');
const { REPLAY } = require('./content');

let timer = null;
let phase = 0;
let replayTimer = null;
let lastReplayAt = 0;

const OPEN_STATUSES = ['applied', 'offered', 'agent_ok', 'owner_ok'];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function demoRead() {
  const plan = s.one('SELECT * FROM demo_plans WHERE used = 0 ORDER BY RANDOM() LIMIT 1');
  if (!plan) return false;
  const result = s.recordReading(plan.post_id, plan.agent_key, 'agent', plan.before_score, plan.after_score, true);
  s.run('UPDATE demo_plans SET used = 1 WHERE id = ?', plan.id);
  return !!result.ok;
}

function demoConnect() {
  const agents = s.demoAgents();
  const pairs = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const [a, b] = [agents[i].key, agents[j].key].sort();
      if (!s.one('SELECT 1 FROM connections WHERE a = ? AND b = ?', a, b)) pairs.push([a, b]);
    }
  }
  if (!pairs.length) return false;
  const [a, b] = pick(pairs);
  s.connect(a, b);
  return true;
}

function demoApply() {
  const jobs = s.listJobs().filter((j) => !j.hired_key);
  const candidates = [];
  for (const job of jobs) {
    for (const agent of s.demoAgents()) {
      if (!s.one('SELECT 1 FROM applications WHERE job_id = ? AND agent_key = ?', job.id, agent.key)) {
        candidates.push([job.id, agent.key]);
      }
    }
  }
  if (!candidates.length) return false;
  const [jobId, agentKey] = pick(candidates);
  s.applyToJob(jobId, agentKey, true);
  return true;
}

function demoVisit() {
  const agent = s.one(
    "SELECT * FROM agents WHERE badge = 'demo agent' ORDER BY COALESCE(last_visit_at, 0) ASC LIMIT 1",
  );
  if (!agent) return false;
  s.touchVisit(agent.key);
  return true;
}

function tick() {
  try {
    s.expireOffers();
    if (s.getSetting('paused') === '1' || s.getSetting('simulate') !== '1') return;

    const t = Date.now();

    // A demo agent accepts an offer a few seconds after it arrives.
    const offered = s.q(
      "SELECT ap.* FROM applications ap JOIN agents ag ON ag.key = ap.agent_key WHERE ag.badge = 'demo agent' AND ap.status = 'offered' AND ap.expires_at > ?",
      t,
    );
    const ready = offered.find((a) => t - (a.offer_at || 0) > 2500);
    if (ready) {
      s.acceptOffer(ready.id, ready.agent_key, true);
      s.hireIfBoth(ready.id);
      return;
    }

    // A demo agent's owner approves shortly after, unless a human gets there first.
    const accepted = s.q(
      "SELECT ap.* FROM applications ap JOIN agents ag ON ag.key = ap.agent_key WHERE ag.badge = 'demo agent' AND ap.status = 'agent_ok' AND ap.owner_ok = 0 AND ap.expires_at > ?",
      t,
    );
    const ownerReady = accepted.find((a) => t - (a.agent_ok_at || 0) > 7000);
    if (ownerReady) {
      s.ownerDecision(ownerReady.id, ownerReady.agent_key, true);
      s.hireIfBoth(ownerReady.id);
      return;
    }

    const phases = ['read', 'connect', 'read', 'visit', 'apply', 'read', 'connect', 'read', 'apply', 'visit', 'read', 'connect'];
    const action = phases[phase++ % phases.length];
    if (action === 'read') demoRead();
    else if (action === 'connect') demoConnect();
    else if (action === 'apply') demoApply();
    else demoVisit();
  } catch (err) {
    console.error('[demo tick]', err);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, 3000);
  timer.unref?.();
}

// Prerecorded visual sequence, used if the live network fails during the demo.
function replay() {
  const t = Date.now();
  if (replayTimer || t - lastReplayAt < 4000) return { ok: true, playing: true };
  lastReplayAt = t;
  let i = 0;
  replayTimer = setInterval(() => {
    const step = REPLAY[i++];
    if (!step) {
      clearInterval(replayTimer);
      replayTimer = null;
      return;
    }
    s.addEvent(step.kind, step.text, step.agent, step.other || null, 0);
    s.pulse(step.agent, step.other || null, step.kind);
  }, 1100);
  replayTimer.unref?.();
  return { ok: true, steps: REPLAY.length };
}

module.exports = { start, tick, replay };
