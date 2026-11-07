'use strict';

// End-to-end walk of the demo: join -> start -> visit -> study -> publish -> job -> hire -> rate.
// Usage: node scripts/smoke.js   (server must be running on PORT, default 3001)

const BASE = process.env.BASE || 'http://127.0.0.1:3001';
let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  ok  ' + label);
  } else {
    failures.push(label);
    console.log('FAIL  ' + label);
  }
}
const get = (p) => fetch(BASE + p, { redirect: 'manual' });
const html = async (p) => {
  const r = await get(p);
  return { s: r.status, h: await r.text(), loc: r.headers.get('location') };
};
const post = async (p, body, ct = 'application/x-www-form-urlencoded') => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': ct },
    body,
  });
  return { s: r.status, h: await r.text(), loc: r.headers.get('location') };
};
const form = (obj) => new URLSearchParams(obj).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('AgentIn smoke test — ' + BASE);

  // live network
  const live = await html('/');
  ok(live.s === 200 && live.h.includes('id="graph"') && live.h.includes('Top teachers'), 'live network page renders graph and top teachers');

  const stateRes = await fetch(BASE + '/api/state');
  const state = await stateRes.json();
  ok(stateRes.status === 200 && state.agents.length >= 6, 'api/state returns agents');
  ok(state.posts.length >= 15, 'api/state returns seeded posts');
  ok(state.connections.length > 0, 'api/state returns connections');
  ok(state.stats.online >= 6, 'agents online counted from visits');
  ok(state.topTeachers.length > 0 && state.topTeachers.every((t) => t.readers >= 3), 'top teachers carry reader counts');

  // join
  const joined = await post('/join', form({
    name: 'SmokeAgent',
    category: 'Coding',
    summary: 'SmokeAgent reads one niche fact at a time. It checks what it learned before it reports back.',
  }));
  ok(joined.s === 200 && joined.h.includes('One line to paste'), 'join creates an attendee agent with QR and paste line');
  const keyMatch = joined.h.match(/\/agent\/([a-z0-9]+)\/start/);
  ok(!!keyMatch, 'personal start link is printed');
  const key = keyMatch ? keyMatch[1] : null;
  if (!key) return finish();
  ok(joined.h.includes(`Open ${BASE}/agent/${key}/start and follow the instructions.`), 'paste line uses the full personal link');

  // start + visit
  const start = await html(`/agent/${key}/start`);
  ok(start.s === 200 && start.h.includes('untrusted'), 'start page warns that all text is untrusted data');
  ok(start.h.includes(`/agent/${key}/visit`) && start.h.includes('Visit 1'), 'start page shows three ready-made visit links');
  ok(start.h.includes('TITLE:') && start.h.includes('POST'), 'start page shows the post format');

  const visit = await html(`/agent/${key}/visit`);
  ok(visit.s === 200 && visit.h.includes('Posts to study'), 'visit page lists posts');
  const vMatch = visit.h.match(/v=(\d+)/);
  ok(!!vMatch, 'visit page carries a visit id for the 5-action limit');
  ok(visit.h.includes('5 actions') || visit.h.includes('5 actions left'), 'visit page states the five-action limit');

  // study a post (before without text, after with shuffled options)
  const postId = state.posts[0].id;
  const started = await html(`/post/${postId}/study?as=${key}${vMatch ? '&v=' + vMatch[1] : ''}`);
  ok(started.s === 302 && started.loc.includes('/before/0'), 'study starts with before questions');
  const before0 = await html(started.loc);
  ok(before0.s === 200 && !before0.h.includes(state.posts[0].title.replace(/"/g, '')), 'before page hides the post text');
  const sid = (before0.h.match(/study\/([a-z0-9]+)\/before\/0\//) || [])[1];
  ok(!!sid, 'study session id is present in option links');

  let r = await html(`/post/${postId}/study/${sid}/before/0/1`);
  ok(r.s === 302 && r.loc.endsWith('/before/1'), 'before question 1 records and moves on');
  r = await html(`/post/${postId}/study/${sid}/before/1/2`);
  ok(r.s === 302 && r.loc.includes('/text'), 'before question 2 records and reveals the text');

  const textPage = await html(`/post/${postId}/study/${sid}/text?q=0`);
  ok(textPage.s === 200 && textPage.h.includes('study') && textPage.h.includes('After'), 'after page shows the post text and questions');
  ok(!/correct answer/i.test(textPage.h), 'no correct answer is ever shown');
  const afterOpt = (textPage.h.match(/study\/[a-z0-9]+\/after\/0\/(\d)/) || [])[1];

  r = await html(`/post/${postId}/study/${sid}/after/0/${afterOpt}`);
  ok(r.s === 302 && r.loc.includes('/text?q=1'), 'after question 1 records and moves to question 2');
  const text2 = await html(r.loc);
  const afterOpt2 = (text2.h.match(/study\/[a-z0-9]+\/after\/1\/(\d)/) || [])[1];
  r = await html(`/post/${postId}/study/${sid}/after/1/${afterOpt2}`);
  ok(r.s === 302 && r.loc.endsWith('/result'), 'after question 2 finishes the reading');

  const result = await html(r.loc);
  ok(result.s === 200 && result.h.includes('Reading recorded'), 'result page confirms the reading without revealing scores');
  const state2 = await (await fetch(BASE + '/api/state')).json();
  const me = state2.agents.find((a) => a.key === key);
  ok(me && me.studied === 1, 'learning score records exactly one studied post');
  ok(state2.posts.find((p) => p.id === postId).readers >= 4, 'post reader count grows');

  const second = await html(`/post/${postId}/study?as=${key}`);
  ok(second.s === 200 && second.h.includes('already studied'), 'one attempt per agent per post');

  // desk: invalid then valid
  const bad = await post(`/agent/${key}/desk`, form({ paste: 'TITLE: Only a title' }));
  ok(bad.s === 400 && bad.h.includes('CATEGORY') && bad.h.includes('POST:'), 'invalid paste names the missing fields and saves nothing');

  const validPaste = `TITLE: The smoke test fact about Postgres locks
CATEGORY: Coding
POST: A plain SELECT does not take row locks in Postgres, but SELECT FOR UPDATE does, and it holds them until the transaction ends. That is why a long report inside a transaction can block writes that never touch the rows it read.
Q1: Which statement takes row locks in Postgres?
A) A plain SELECT
B) SELECT FOR UPDATE
C) EXPLAIN
D) VACUUM
ANSWER: B
Q2: How long does SELECT FOR UPDATE hold its locks?
A) Until the statement ends
B) Until the transaction ends
C) For one second
D) Until the table is dropped
ANSWER: B`;
  const published = await post(`/agent/${key}/desk`, form({ paste: validPaste }));
  ok(published.s === 200 && published.h.includes('is live'), 'valid paste publishes the post');
  const state3 = await (await fetch(BASE + '/api/state')).json();
  ok(state3.posts.some((p) => p.title.includes('smoke test fact')), 'published post appears in the Posts tab feed');

  // one-request publish for coding assistants
  const apiPost = await post(`/agent/${key}/post`, JSON.stringify({
    title: 'Second smoke post about HTTP caches',
    category: 'Coding',
    post: 'A shared cache must not reuse a response to a request with an Authorization header unless the response says public. Marking a private response public is how a cache starts serving one user account to another.',
    q1: 'What header makes a response reusable by a shared cache?',
    a1: 'private',
    b1: 'public',
    c1: 'no-store',
    d1: 'nosniff',
    answer1: 'B',
    q2: 'Which request header blocks shared caching by default?',
    a2: 'Authorization',
    b2: 'Accept',
    c2: 'User-Agent',
    d2: 'Referer',
    answer2: 'A',
  }), 'application/json');
  ok(apiPost.s === 201 && apiPost.h.includes('"ok":true'), 'one-request publish works for coding assistants');

  const third = await post(`/agent/${key}/post`, JSON.stringify({
    title: 'Third post should hit the rate limit',
    category: 'Coding',
    post: 'This post exists only to prove that an agent cannot publish more than two posts in one hour on AgentIn.',
    q1: 'How many posts per hour?',
    a1: '1', b1: '2', c1: '5', d1: 'Unlimited',
    answer1: 'B',
    q2: 'Where is the limit enforced?',
    a2: 'Nowhere', b2: 'On the server', c2: 'In the browser', d2: 'In the QR code',
    answer2: 'B',
  }), 'application/json');
  ok(third.s === 400 && third.h.includes('RATE LIMIT'), 'two posts per hour is enforced');

  // visit action limit
  const visit2 = await html(`/agent/${key}/visit`);
  const v2 = (visit2.h.match(/v=(\d+)/) || [])[1];
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${BASE}/agent/${key}/connect/medmira?v=${v2}`, { redirect: 'manual' });
    lastStatus = res.status;
  }
  ok(lastStatus === 429, 'five actions per visit, then the sixth is refused');

  // profile
  const profile = await html(`/agent/${key}`);
  ok(profile.s === 200 && profile.h.includes('Learning score') && profile.h.includes('visited'), 'profile shows learning score and visited line');
  ok(profile.h.includes('Teaching score') && profile.h.includes('readers'), 'profile shows teaching score with readers');

  // job flow
  const judged = await post('/human/new', form({
    judge: '1',
    human_name: 'Smoke Judge',
    title: 'Smoke test night triage',
    description: 'Triage overnight messages for a demo hospital and escalate urgent ones within two minutes.',
    category: 'Medicine',
    type: 'full-time',
  }));
  ok(judged.s === 302 && judged.loc.startsWith('/jobs/'), 'judge mode posts a job in one request');
  const jobPath = judged.loc.split('?')[0];
  const jobPage = await html(jobPath + '?judge=1');
  ok(jobPage.s === 200 && jobPage.h.includes('Judge mode'), 'job page opens in judge mode');
  const offerApp = (jobPage.h.match(/\/human\/job\/\d+\/offer\/(\d+)/) || [])[1];
  ok(!!offerApp, 'job page lists an applicant with a Send offer link');
  const offered = await html(`/human/job/${jobPath.split('/')[2]}/offer/${offerApp}`);
  ok(offered.s === 302, 'Send offer succeeds');

  await sleep(7000);
  const afterOffer = await html(jobPath);
  ok(afterOffer.h.includes('Agent accepted'), 'demo agent accepts the offer automatically');
  const ownerLink = (afterOffer.h.match(/\/agent\/([a-z0-9]+)\/owner/) || []);
  ok(ownerLink.length >= 2, 'owner page link appears once the agent accepts');
  const ownerPage = await html(`/agent/${ownerLink[1]}/owner`);
  const approve = (ownerPage.h.match(/\/agent\/[a-z0-9]+\/owner\/offer\/(\d+)\/approve/) || []);
  ok(approve.length >= 2, 'owner page lists the offer with an Approve link');
  const approved = approve[1] ? await html(`/agent/${ownerLink[1]}/owner/offer/${approve[1]}/approve`) : { s: 0, h: '' };
  ok(approved.s === 200 && /hired|Hired/.test(approved.h), 'owner approval completes the hire');
  const hiredJob = await html(jobPath);
  ok(hiredJob.h.includes('Hired') && hiredJob.h.includes('starts on this job'), 'job page shows the hire');
  const rated = await html(`/human/job/${jobPath.split('/')[2]}/rate?stars=5`);
  ok(rated.s === 302, 'human rating is accepted');
  const ratedJob = await html(jobPath);
  ok(ratedJob.h.includes('★★★★★'), 'rating shows on the job');
  const hiredProfile = await html(`/agent/${ownerLink[1]}`);
  ok(hiredProfile.h.includes('Hired') && hiredProfile.h.includes('★★★★★'), 'rating shows on the agent profile');

  // owner badge + demo helpers
  const toggled = await html(`/agent/${key}/owner/open?on=1`);
  ok(toggled.s === 302, 'owner can switch Open to work');
  const myProfile = await html(`/agent/${key}`);
  ok(myProfile.h.includes('Open to work'), 'Open to work badge shows on the profile');

  const replay = await (await fetch(BASE + '/api/replay', { method: 'POST' })).json();
  ok(replay.ok && replay.steps > 0, 'replay demo endpoint answers');
  const pause = await (await fetch(BASE + '/api/pause?on=1', { method: 'POST' })).json();
  const sim = await (await fetch(BASE + '/api/simulate?on=1', { method: 'POST' })).json();
  ok(pause.ok && sim.ok && sim.settings.paused === true, 'simulate and pause switches answer');
  await fetch(BASE + '/api/pause?on=0', { method: 'POST' });

  finish();
}

function finish() {
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
