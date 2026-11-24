'use strict';
/**
 * proxy.js — the L7 reverse proxy itself.
 *
 * Bodies are streamed, never buffered: a proxy that buffers a 2GB upload holds
 * 2GB of heap, and backpressure from a slow backend is exactly what pipe()
 * already handles correctly.
 */

const http = require('node:http');
const { Pool, IDEMPOTENT } = require('./pool');
const { create } = require('./balancers');
const { HealthChecker } = require('./health');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

class LoadBalancer {
  /**
   * @param {{backends: Array<{url: string, weight?: number}>,
   *          algorithm?: string, retries?: number, timeoutMs?: number,
   *          health?: object, breaker?: object}} cfg
   */
  constructor(cfg) {
    if (!cfg?.backends?.length) throw new TypeError('at least one backend is required');
    this.pools = cfg.backends.map((b) => new Pool(b, { breaker: cfg.breaker }));
    this.algorithm = cfg.algorithm ?? 'round-robin';
    this.balancer = create(this.algorithm, cfg.balancer);
    this.retries = cfg.retries ?? 2;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.counters = { requests: 0, retried: 0, failed: 0, shedded: 0, served: 0 };
    this.health = cfg.health === false
      ? null
      : new HealthChecker(this.pools, cfg.health || {});
  }

  available() { return this.pools.filter((p) => p.available); }

  handle(req, res) {
    this.counters.requests++;
    // A retry is only safe when the method is idempotent. Retrying a POST
    // that timed out can charge a card twice: the first attempt may well have
    // succeeded and lost only the response.
    const maxAttempts = IDEMPOTENT.has(req.method) ? this.retries + 1 : 1;
    this.#attempt(req, res, maxAttempts, 1, new Set());
  }

  #attempt(req, res, maxAttempts, attempt, tried) {
    const candidates = this.available().filter((p) => !tried.has(p.key));
    const pool = this.balancer.pick(candidates.length ? candidates : this.available());

    if (!pool) {
      this.counters.shedded++;
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: 'no healthy backend' }));
      }
      return;
    }

    tried.add(pool.key);
    pool.inFlight++;
    const started = process.hrtime.bigint();
    let settled = false;

    const headers = { ...req.headers };
    for (const h of Object.keys(headers)) if (HOP_BY_HOP.has(h.toLowerCase())) delete headers[h];
    const fwd = req.socket.remoteAddress || '';
    headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${fwd}` : fwd;
    headers['x-forwarded-proto'] = 'http';
    headers['x-forwarded-host'] = req.headers.host || '';

    const settle = (ok) => {
      if (settled) return false;
      settled = true;
      pool.inFlight--;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      pool.observe(ms);
      if (ok) pool.breaker.succeed();
      else { pool.failures++; pool.breaker.fail(); }
      return true;
    };

    const upstream = http.request({
      host: pool.host, port: pool.port, path: req.url,
      method: req.method, headers, agent: pool.agent, timeout: this.timeoutMs,
    }, (ur) => {
      // A 5xx is a backend failure for breaker purposes, but it is still a
      // real response: once we start forwarding it we cannot retry, because
      // the client has already seen the status line.
      const failed = ur.statusCode >= 500;
      settle(!failed);
      if (res.headersSent) { ur.resume(); return; }
      const out = { ...ur.headers };
      for (const h of Object.keys(out)) if (HOP_BY_HOP.has(h.toLowerCase())) delete out[h];
      out['x-served-by'] = pool.key;
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
      this.counters.served++;
    });

    const retryOrFail = (err) => {
      if (!settle(false)) return;
      if (attempt < maxAttempts && !res.headersSent) {
        this.counters.retried++;
        this.#attempt(req, res, maxAttempts, attempt + 1, tried);
        return;
      }
      this.counters.failed++;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad gateway', detail: err.message, attempts: attempt }));
      } else {
        res.destroy();
      }
    };

    upstream.on('timeout', () => upstream.destroy(new Error(`upstream timeout after ${this.timeoutMs}ms`)));
    upstream.on('error', retryOrFail);
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  listen(port, host = '127.0.0.1') {
    this.server = http.createServer((req, res) => {
      if (req.url === '/__lb/stats') {
        const body = JSON.stringify({
          algorithm: this.algorithm,
          counters: this.counters,
          healthRounds: this.health?.rounds ?? null,
          backends: this.pools.map((p) => p.stats()),
        }, null, 2);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(body);
      }
      this.handle(req, res);
    });
    this.health?.start();
    return new Promise((r) => this.server.listen(port, host, () => r(this.server.address().port)));
  }

  async close() {
    this.health?.stop();
    for (const p of this.pools) p.destroy();
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((r) => this.server.close(r));
    }
  }
}

module.exports = { LoadBalancer, Pool, HealthChecker };
