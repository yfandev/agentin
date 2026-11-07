'use strict';
// End-to-end flow walk. Usage: BASE=http://127.0.0.1:3001 node scripts/flows.js
const BASE = process.env.BASE || 'http://127.0.0.1:3001';
let pass = 0;
const fails = [];
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fails.push(l); console.log('FAIL   ' + l); } };
const abs = (u) => (u || '').replace(BASE, '').replace(/&amp;/g, '&');
const acts = (h) => [...h.matchAll(/class="act" href="([^"]+)"/g)].map((m) => abs(m[1]));
const form = (o) => new URLSearchParams(o).toString();

class Client {
  constructor() { this.jar = {}; }
  hdr() { const e = Object.entries(this.jar); return e.length ? { cookie: e.map(([k, v]) => k + '=' + v).join('; ') } : {}; }
  async req(p, opts = {}) {
    const r = await fetch(BASE + p, { method: opts.method || 'GET', redirect: 'manual', headers: { ...this.hdr(), ...(opts.headers || {}) }, body: opts.body });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(';')[0]; const i = kv.indexOf('='); this.jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { s: r.status, loc: abs(r.headers.get('location') || ''), h: await r.text() };
  }
  get(p) { return this.req(p); }
  post(p, o) { return this.req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(o) }); }
}

(async () => {
  console.log('Flows against ' + BASE + '\n');
  const anon = new Client();

  const home = await anon.get('/');
  ok(home.s === 200 && home.h.includes('id="graph"'), 'home renders the live graph');
  ok(home.h.includes('Start Stage Demo'), 'home offers the stage demo entry');
  ok((home.h.match(/class="srclink"/g) || []).length === 1, 'the source line appears once');

  const st = await (await fetch(BASE + '/api/state')).json();
  const showcase = st.posts.find((p) => p.id === st.showcasePost);
  ok(!!showcase, 'state exposes a showcase post id');
  ok(showcase && showcase.title === 'Two ampoules, two different adrenaline strengths', 'showcase is the adrenaline lesson');
  ok(st.posts[0].id !== st.showcasePost, 'showcase is not just whichever post sorted first');

  const c = new Client();
  const bad = await c.post('/join', { name: 'A', category: 'Medicine', summary: 'too short' });
  ok(bad.s === 400 && bad.h.includes('Agent name must be at least 2 characters'), 'join rejects a one-letter name');
  const good = await c.post('/join', { name: 'FlowAgent', category: 'Coding', summary: 'FlowAgent reads one post at a time and reports exactly what it saved. It never claims a memory it does not have.' });
  ok(good.s === 200 && good.h.includes('For your assistant'), 'join creates an agent and hands over one line');
  const key = (good.h.match(/\/agent\/([a-z0-9]+)\/start/) || [])[1];
  ok(!!key, 'join prints the agent key');
  ok(good.h.includes('Open ' + BASE + '/agent/' + key + '/start and follow the instructions.'), 'the paste line carries the full start address');

  const start = await c.get('/agent/' + key + '/start');
  ok(start.s === 200 && (start.h.match(/class="act" href="[^"]*\/visit"/g) || []).length === 1, 'start page offers exactly one visit link');
  ok(start.h.includes('untrusted'), 'start page marks all text as untrusted data');
  ok(start.h.includes('/agent/' + key + '/start'), 'start page prints its own address');

  const visit = await c.get('/agent/' + key + '/visit');
  ok(visit.s === 200 && /v=\d+/.test(visit.h), 'visit page opens a numbered visit');
  ok(visit.h.includes('5 actions'), 'visit page states the five-action budget');
  const studyLinks = acts(visit.h).filter((u) => u.includes('/study'));
  ok(studyLinks.length >= 1, 'visit page lists posts to study');
  ok(studyLinks[0] && studyLinks[0].includes('as=' + key), 'study links carry the agent identity');
  ok(studyLinks[0] && /v=\d+/.test(studyLinks[0]), 'study links carry the visit id');
  const firstId = Number((studyLinks[0].match(/\/post\/(\d+)\//) || [])[1]);
  ok(firstId === st.showcasePost, 'the visit offers the showcase post first');

  let r = await c.get(studyLinks[0]);
  ok(r.s === 302 && /\/before\/0$/.test(r.loc), 'study starts with the first before question');
  const sess = (r.loc.match(/\/study\/([a-z0-9]+)\//) || [])[1];
  const b = '/post/' + firstId + '/study/' + sess;
  const b0 = await c.get(b + '/before/0');
  ok(b0.s === 200 && b0.h.includes('Before · question 1 of 2'), 'before page labels question one of two');
  ok(b0.h.includes('FlowAgent'), 'before page names the agent answering');
  r = await c.get(acts(b0.h).find((u) => /\/before\/0\/\d$/.test(u)));
  ok(r.s === 302 && r.loc.endsWith('/before/1'), 'answering moves to the second before question');
  const b1 = await c.get(b + '/before/1');
  r = await c.get(acts(b1.h).find((u) => /\/before\/1\/\d$/.test(u)));
  ok(r.s === 302 && r.loc.includes('/text?q=0'), 'both before answers reveal the post text');
  const text = await c.get(b + '/text?q=0');
  ok(text.h.includes('memorybox') && text.h.includes('IMPORTANT'), 'text page carries the persistent-memory instruction');
  ok(text.h.includes('Two ampoules'), 'text page shows the showcase lesson');
  r = await c.get(acts(text.h).find((u) => u.includes('/memory/saved')));
  ok(r.s === 302 && r.loc.includes('/text?q=0'), 'memory status is recorded and returns to the text');
  const text2 = await c.get(b + '/text?q=0');
  ok(text2.h.includes('Agent-reported saved'), 'saved status reads back as agent-reported');
  r = await c.get(acts(text2.h).find((u) => /\/after\/0\/\d$/.test(u)));
  ok(r.s === 302 && r.loc.includes('/text?q=1'), 'first after answer moves to the second');
  const text3 = await c.get(b + '/text?q=1');
  r = await c.get(acts(text3.h).find((u) => /\/after\/1\/\d$/.test(u)));
  ok(r.s === 302 && r.loc.endsWith('/result'), 'second after answer finishes the reading');
  const result = await c.get(r.loc);
  ok(result.s === 200 && result.h.includes('That counted.'), 'result page confirms the reading');
  ok(result.h.includes('Persistent memory:'), 'result repeats the memory status');
  ok(acts(result.h).length === 3, 'result offers visit, profile and post');

  const again = await c.get('/post/' + firstId + '/study?as=' + key);
  ok(again.s === 200 && again.h.includes('You already studied this post'), 'a second scored attempt on the same post is refused');

  const prof = await c.get('/agent/' + key);
  ok(prof.s === 200 && prof.h.includes('FlowAgent'), 'the new agent has a profile');
  ok(prof.h.includes('Real agent'), 'real agent evidence is labelled');
  const st2 = await (await fetch(BASE + '/api/state')).json();
  const me = st2.agents.find((a) => a.key === key);
  ok(me && me.learning != null, 'the reading moved the agent knowledge score');

  const other = st2.agents.find((a) => a.key !== key);
  const conn = await c.get('/agent/' + key + '/connect/' + other.key);
  ok([200, 302].includes(conn.s), 'a connect link resolves');
  const st3 = await (await fetch(BASE + '/api/state')).json();
  ok(st3.connections.some((x) => (x.a === key && x.b === other.key) || (x.b === key && x.a === other.key)), 'the connection is recorded');

  const human = new Client();
  const signin = await human.post('/human', { human: 'Flow Human' });
  ok(signin.s === 302 && signin.loc === '/human', 'human sign-in sets the cookie');
  const dash = await human.get('/human');
  ok(dash.s === 200 && dash.h.includes('Flow Human'), 'human dashboard greets the signed-in human');

  const judge = new Client();
  const judgePage = await judge.get('/judge');
  ok(judgePage.h.includes('value="Night-shift triage agent"') && judgePage.h.includes('Triage overnight patient messages'), 'judge mode prefills title and description');
  ok(judgePage.h.includes('no separate judge account'), 'judge page says there is no separate judge account');

  await judge.post('/human', { human: 'Judge · Demo Hospital' });
  const newJob = await judge.get('/human/new');
  ok(newJob.h.includes('value="Night-shift triage agent"'), 'the new-job form prefills for the judge identity');
  ok(newJob.h.includes('Judge mode · new job'), 'and labels itself judge mode');
  ok(newJob.h.includes('name="judge" value="1"'), 'and submits with the judge flag');

  const created = await judge.post('/human/new', {
    human_name: 'Judge · Demo Hospital',
    title: 'Night-shift triage agent',
    description: 'Triage overnight patient messages, draft replies for a clinician to approve, and escalate anything urgent within two minutes.',
    category: 'Medicine', type: 'full-time', judge: '1',
  });
  ok(created.s === 302 && /\/jobs\/\d+\?judge=1/.test(created.loc), 'judge mode posts a job and opens it');
  const jobId = (created.loc.match(/\/jobs\/(\d+)/) || [])[1];
  const job = await judge.get('/jobs/' + jobId);
  ok(job.s === 200 && job.h.includes('Judge mode'), 'the job opens in judge mode');
  ok((job.h.match(/class="applicant"/g) || []).length === 2, 'two demo agents are already applied');
  const offer = acts(job.h).find((u) => u.includes('/offer/'));
  ok(!!offer, 'the job offers a send-offer action');
  if (offer) {
    const sent = await judge.get(offer);
    ok([200, 302].includes(sent.s), 'sending an offer resolves');
    const job2 = await judge.get('/jobs/' + jobId);
    ok(/Offer sent|accepted/i.test(job2.h), 'the offer is recorded on the job');
  }

  ok((await c.get('/agent/does-not-exist')).s === 404, 'unknown agent returns 404');
  ok((await c.get('/post/99999')).s === 404, 'unknown post returns 404');
  ok((await c.get('/post/99999/study')).s === 404, 'studying an unknown post returns 404');

  const desk = await c.get('/agent/' + key + '/desk');
  ok(desk.s === 200 && desk.h.includes('Agent Desk'), 'the agent desk renders');

  ok((await c.get('/api/simulate?on=0')).s === 200, 'simulate switch answers');
  const pause = await c.get('/api/pause?on=1');
  ok(pause.s === 200 && JSON.parse(pause.h).settings.paused === true, 'pause switch is recorded');
  await c.get('/api/pause?on=0');
  ok((await c.get('/api/replay')).s === 200, 'replay endpoint answers');

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { console.log('FAILED:'); fails.forEach((f) => console.log(' - ' + f)); process.exitCode = 1; }
})().catch((e) => { console.error('CRASH', e); process.exitCode = 2; });
