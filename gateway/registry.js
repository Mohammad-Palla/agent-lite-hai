'use strict';
/**
 * Module registry + stats aggregator. Backs GET /stats/all.
 * Subscribes each module to the events it declares; isolates module failures.
 */

const bus = require('./bus');
const { validateModule } = require('./contract');

const _modules = new Map();

function register(mod, { state = 'built' } = {}) {
  validateModule(mod);
  if (_modules.has(mod.name)) throw new Error(`duplicate module: ${mod.name}`);
  _modules.set(mod.name, { mod, state });

  const subs = mod.subscribes && mod.subscribes.length ? mod.subscribes : [];
  for (const type of subs) {
    bus.subscribe(type, (event) => mod.handle(event, { bus }));
  }
  return mod;
}

function get(name) {
  const e = _modules.get(name);
  return e && e.mod;
}

function statsAll() {
  const modules = {};
  for (const [name, { mod, state }] of _modules) {
    let stats, health;
    try { stats = mod.stats(); health = mod.health(); }
    catch (err) { stats = { counters: {}, latency: { p50: null, p95: null }, last_error: { message: err.message, ts: Date.now() }, custom: {} }; health = 'down'; }
    modules[name] = { state, health, ...stats };
  }
  const healths = Object.values(modules).map(m => m.health);
  const overall = healths.includes('down') ? 'down' : healths.includes('degraded') ? 'degraded' : 'ok';
  return { ts: Date.now(), overall, count: _modules.size, modules };
}

function setFault(name, value) {
  const e = _modules.get(name);
  if (!e || typeof e.mod.setFault !== 'function') return false;
  e.mod.setFault(value);
  return true;
}

/** Replay recorded events into ONE module with no others running; returns its stats. */
function replay(mod, events) {
  mod.reset && mod.reset();
  for (const ev of events) {
    if (!mod.subscribes || !mod.subscribes.length || mod.subscribes.includes(ev.type)) mod.handle(ev, {});
  }
  return mod.stats();
}

module.exports = { register, get, statsAll, setFault, replay, names: () => [..._modules.keys()] };
