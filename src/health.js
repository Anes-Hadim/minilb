'use strict';
/**
 * health.js — active health checks.
 *
 * Passive health (the circuit breaker) only learns a backend is down by
 * sending real user requests at it and watching them fail. Active checks pay a
 * cheap synthetic request on a timer instead, so a backend that goes down
 * between user requests is known to be down *before* the next user arrives,
 * and a backend that recovers is noticed without a user paying for the probe.
 *
 * Both are needed. Active checks alone miss failures that only show up under
 * real traffic (a slow query path, a specific route 500ing); passive alone
 * makes users the detector.
 */

const http = require('node:http');

class HealthChecker {
  constructor(pools, opts = {}) {
    this.pools = pools;
    this.path = opts.path ?? '/healthz';
    this.intervalMs = opts.intervalMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 1_000;
    this.riseThreshold = opts.rise ?? 1;    // consecutive passes to mark up
    this.fallThreshold = opts.fall ?? 2;    // consecutive fails to mark down
    this.counts = new Map();
    this.timer = null;
    this.rounds = 0;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.round(), this.intervalMs);
    this.timer.unref?.();
    this.round();
    return this;
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async round() {
    this.rounds++;
    await Promise.all(this.pools.map((p) => this.probe(p)));
  }

  probe(pool) {
    return new Promise((resolve) => {
      const req = http.request({
        host: pool.host, port: pool.port, path: this.path,
        method: 'GET', timeout: this.timeoutMs,
        // agent: false gives each probe its own short-lived socket. The global
        // agent keep-alives in Node 19+, which would leave probe sockets open
        // against every backend forever and keep a shutting-down server from
        // closing.
        agent: false,
      }, (res) => {
        res.resume();   // drain, or the socket is never released
        this.record(pool, res.statusCode >= 200 && res.statusCode < 400);
        resolve();
      });
      req.on('timeout', () => { req.destroy(); });
      req.on('error', () => { this.record(pool, false); resolve(); });
      req.end();
    });
  }

  /**
   * Hysteresis: a single failed probe does not take a backend out, and a
   * single success does not bring a flapping one back in. Without it, one
   * dropped packet removes a healthy backend from rotation.
   */
  record(pool, ok) {
    const c = this.counts.get(pool.key) || { up: 0, down: 0 };
    if (ok) { c.up++; c.down = 0; } else { c.down++; c.up = 0; }
    this.counts.set(pool.key, c);

    if (!pool.healthy && c.up >= this.riseThreshold) {
      pool.healthy = true;
      pool.breaker.reset();   // active checks say it is back; let traffic test it
    } else if (pool.healthy && c.down >= this.fallThreshold) {
      pool.healthy = false;
    }
  }
}

module.exports = { HealthChecker };
