'use strict';
/**
 * Variety for the scripted agents: every run picks different items, amounts and words, so the dashboard never shows
 * fifteen copies of the same purchase. Randomness is seeded and the seed is printed, so any run can be replayed exactly:
 *
 *     SEED=12345 npm run agents:scalper
 */

const { INVENTORY } = require('../catalog');
const { WALLET_TX_LIMIT, WALLET_DAILY_LIMIT } = require('../gateway/currency');

// mulberry32: a tiny, well-known seeded generator (deterministic for a given seed)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedInput) {
  const given = seedInput !== undefined && seedInput !== '' && Number.isFinite(Number(seedInput));
  const seed = given ? Number(seedInput) >>> 0 : ((Date.now() ^ Math.floor(Math.random() * 2 ** 32)) >>> 0);
  const next = mulberry32(seed);
  const rng = {
    seed,
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
  };
  return rng;
}

const fromEnv = () => makeRng(process.env.SEED);

const products = Object.values(INVENTORY);
const byId = (id) => INVENTORY[String(id)];
const affordable = products.filter((p) => p.price <= WALLET_TX_LIMIT);          // an honest shopper stays under the per-purchase limit
const hoardable = products.filter((p) => p.price >= 3000 && p.price < 100000);  // what a tout goes after: tickets, sneakers, a GPU
const whales = products.filter((p) => p.price > WALLET_TX_LIMIT * 3);           // above the 3x auto-deny line: ₹1,00,000 package and the GPU

/** A word that matches this product in the shop's search (its first word: "Concert", "Limited", "Office"...). */
const keyword = (p) => p.name.split(/[ (]/)[0].toLowerCase();

module.exports = { makeRng, fromEnv, products, byId, affordable, hoardable, whales, keyword, WALLET_TX_LIMIT, WALLET_DAILY_LIMIT };
