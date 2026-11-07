'use strict';

// Worker entry. Binds D1, seeds once, advances the demo on demand, then routes.

const s = require('./store');
const { seedIfEmpty } = require('./seed');
const sim = require('./sim');
const app = require('./app');

let booted = null;
function boot(env) {
  if (!booted) {
    booted = (async () => {
      await s.attach(env.DB);
      await seedIfEmpty();
    })();
  }
  return booted;
}

module.exports = {
  async fetch(request, env) {
    try {
      await boot(env);
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, ...(await s.counts()), stats: await s.networkStats() }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      await sim.advance();
      await sim.advanceReplay();
      return await app.route(request, env);
    } catch (err) {
      console.error('[worker]', (err && err.stack) || err);
      return new Response('Something went wrong. Open / to return to the network.', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
