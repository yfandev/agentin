'use strict';

// Pure formatting helpers shared by the views and both stores.

const round1 = (n) => Math.round(n * 10) / 10;
const fmtGain = (n) => (n > 0 ? '+' : '') + round1(Number(n) || 0).toFixed(1);
const OFFER_TTL_MINUTES = 15;

module.exports = { round1, fmtGain, OFFER_TTL_MINUTES };
