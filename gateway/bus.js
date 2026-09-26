'use strict';
/**
 * Event bus — one envelope, one channel. Modules subscribe by event type ('*' = all).
 * Keeps a bounded history so a single module can be replayed in isolation.
 */

const { EventEmitter } = require('events');
const { makeEvent } = require('./contract');

const MAX_HISTORY = 5000;

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._history = [];
  }

  publish(type, sessionId, payload, traceId) {
    const event = makeEvent(type, sessionId, payload, traceId);
    this._history.push(event);
    if (this._history.length > MAX_HISTORY) this._history.shift();
    this.emit(type, event);
    this.emit('*', event);
    return event;
  }

  subscribe(type, fn) {
    this.on(type, fn);
    return () => this.off(type, fn);
  }

  history({ type, sessionId, limit } = {}) {
    let h = this._history;
    if (type) h = h.filter(e => e.type === type);
    if (sessionId) h = h.filter(e => e.session_id === sessionId);
    return limit ? h.slice(-limit) : [...h];
  }
}

module.exports = new Bus();
module.exports.Bus = Bus;
