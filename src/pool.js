'use strict';
/** pool.js — one backend: its address, its live counters, its breaker. */

const http = require('node:http');
const { Breaker } = require('./breaker');

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']);

class Pool {
  /** @param {{url: string, weight?: number}} spec */
  constructor(spec, opts = {}) {
    const u = new URL(spec.url);
    this.key = spec.url;
    this.host = u.hostname;
    this.port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    this.weight = spec.weight ?? 1;

    this.inFlight = 0;
    this.ewmaMs = 0;
    this.ewmaAt = 0;
    this.healthy = true;        // set by the active health checker
    this.breaker = new Breaker(opts.breaker);

    this.requests = 0;
    this.failures = 0;
    this.totalMs = 0;

    // One keep-alive agent per backend. Without it every proxied request pays
    // a TCP handshake, which on a LAN is most of the latency the proxy adds.
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: opts.maxSockets ?? 256,
      keepAliveMsecs: 10_000,
    });
  }

  /** Available to receive traffic right now. */
  get available() {
    return this.healthy && this.breaker.allows();
  }

  /** Exponentially weighted moving average of latency, alpha = 0.2. */
  observe(ms) {
    this.requests++;
    this.totalMs += ms;
    this.ewmaMs = this.ewmaMs === 0 ? ms : this.ewmaMs * 0.8 + ms * 0.2;
    this.ewmaAt = Date.now();
  }

  stats() {
    return {
      url: this.key,
      weight: this.weight,
      healthy: this.healthy,
      breaker: this.breaker.state,
      inFlight: this.inFlight,
      requests: this.requests,
      failures: this.failures,
      ewmaMs: Number(this.ewmaMs.toFixed(2)),
      avgMs: this.requests ? Number((this.totalMs / this.requests).toFixed(2)) : 0,
    };
  }

  destroy() { this.agent.destroy(); }
}

module.exports = { Pool, IDEMPOTENT };
