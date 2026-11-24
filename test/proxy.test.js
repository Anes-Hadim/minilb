'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LoadBalancer } = require('../src/proxy');

/** A real backend server. `behave` decides what each request does. */
function backend(name, behave = {}) {
  const hits = { count: 0, methods: [], bodies: [], headers: [] };
  const srv = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      const up = behave?.healthy !== false;
      res.writeHead(up ? 200 : 503);
      return res.end(up ? 'ok' : 'down');
    }
    hits.count++;
    hits.methods.push(req.method);
    hits.headers.push(req.headers);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.bodies.push(Buffer.concat(chunks).toString());
      const act = () => {
        if (behave?.status) { res.writeHead(behave.status); return res.end(`${name}:err`); }
        if (behave?.hang) return;                      // never responds
        if (behave?.reset) return req.socket.destroy();
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(name);
      };
      behave?.delayMs ? setTimeout(act, behave.delayMs) : act();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    name, srv, hits, behave,
    url: `http://127.0.0.1:${srv.address().port}`,
    // closeAllConnections() first: a backend with `hang: true` is holding a
    // socket open and never answering, and plain close() would wait for it.
    close: () => new Promise((x) => { srv.closeAllConnections?.(); srv.close(x); }),
  })));
}

async function get(port, path = '/', opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method || 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers,
      }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('round robin spreads requests across live backends', async () => {
  const a = await backend('a'); const b = await backend('b'); const c = await backend('c');
  const lb = new LoadBalancer({ backends: [a, b, c].map((x) => ({ url: x.url })), health: false });
  const port = await lb.listen(0);

  const bodies = [];
  for (let i = 0; i < 9; i++) bodies.push((await get(port)).body);
  assert.deepEqual(bodies, ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c']);
  assert.equal(a.hits.count, 3);

  await lb.close(); await a.close(); await b.close(); await c.close();
});

test('the response names which backend served it', async () => {
  const a = await backend('a');
  const lb = new LoadBalancer({ backends: [{ url: a.url }], health: false });
  const port = await lb.listen(0);
  const res = await get(port);
  assert.equal(res.headers['x-served-by'], a.url);
  await lb.close(); await a.close();
});

test('a GET to a dead backend is retried on a live one', async () => {
  const dead = await backend('dead');
  const deadUrl = dead.url;
  await dead.close();                 // nothing is listening on that port now
  const live = await backend('live');

  const lb = new LoadBalancer({
    backends: [{ url: deadUrl }, { url: live.url }],
    health: false, retries: 2,
  });
  const port = await lb.listen(0);

  for (let i = 0; i < 6; i++) {
    const res = await get(port);
    assert.equal(res.status, 200, 'the client never sees the dead backend');
    assert.equal(res.body, 'live');
  }
  assert.ok(lb.counters.retried >= 3, `retried ${lb.counters.retried} times`);
  await lb.close(); await live.close();
});

test('a POST is NOT retried, because replaying a write can double it', async () => {
  const dead = await backend('dead');
  const deadUrl = dead.url;
  await dead.close();
  const live = await backend('live');

  const lb = new LoadBalancer({
    backends: [{ url: deadUrl }, { url: live.url }],
    health: false, retries: 3,
  });
  const port = await lb.listen(0);

  // Force the first pick to be the dead one by using round robin from index 0.
  const res = await get(port, '/', { method: 'POST', body: 'charge=100' });
  assert.equal(res.status, 502, 'the POST fails rather than being replayed elsewhere');
  assert.equal(lb.counters.retried, 0, 'no retry was attempted for a non-idempotent method');
  assert.equal(live.hits.count, 0, 'and the live backend never saw a duplicate charge');

  await lb.close(); await live.close();
});

test('503 with Retry-After when every backend is out', async () => {
  const a = await backend('a');
  const lb = new LoadBalancer({ backends: [{ url: a.url }], health: false });
  const port = await lb.listen(0);
  lb.pools[0].healthy = false;

  const res = await get(port);
  assert.equal(res.status, 503);
  assert.equal(res.headers['retry-after'], '1');
  assert.match(res.body, /no healthy backend/);
  assert.equal(lb.counters.shedded, 1);
  await lb.close(); await a.close();
});

test('repeated 5xx trips the breaker and the backend stops getting traffic', async () => {
  const bad = await backend('bad', { status: 500 });
  const good = await backend('good');
  const lb = new LoadBalancer({
    backends: [{ url: bad.url }, { url: good.url }],
    health: false, retries: 0, breaker: { threshold: 3, cooldownMs: 60_000 },
  });
  const port = await lb.listen(0);

  for (let i = 0; i < 20; i++) await get(port);

  assert.equal(lb.pools[0].breaker.state, 'open', 'the failing backend is cut out');
  assert.ok(bad.hits.count <= 4, `bad backend saw ${bad.hits.count} requests before being cut off`);
  assert.ok(good.hits.count >= 15, `good backend absorbed the rest (${good.hits.count})`);

  await lb.close(); await bad.close(); await good.close();
});

test('a hanging backend hits the timeout and fails over', async () => {
  const slow = await backend('slow', { hang: true });
  const fast = await backend('fast');
  const lb = new LoadBalancer({
    backends: [{ url: slow.url }, { url: fast.url }],
    health: false, retries: 1, timeoutMs: 150,
  });
  const port = await lb.listen(0);

  const t0 = Date.now();
  const res = await get(port);
  const elapsed = Date.now() - t0;

  assert.equal(res.status, 200);
  assert.equal(res.body, 'fast');
  assert.ok(elapsed >= 150 && elapsed < 2000, `failed over after ${elapsed}ms, bounded by the timeout`);
  await lb.close(); await slow.close(); await fast.close();
});

test('request and response bodies are forwarded intact', async () => {
  const a = await backend('a');
  const lb = new LoadBalancer({ backends: [{ url: a.url }], health: false });
  const port = await lb.listen(0);

  const body = 'x'.repeat(100_000);
  const res = await get(port, '/upload', { method: 'POST', body });
  assert.equal(res.status, 200);
  assert.equal(a.hits.bodies[0].length, 100_000, 'a 100KB body streamed through unchanged');
  await lb.close(); await a.close();
});

test('X-Forwarded-For and X-Forwarded-Host are set', async () => {
  const a = await backend('a');
  const lb = new LoadBalancer({ backends: [{ url: a.url }], health: false });
  const port = await lb.listen(0);
  await get(port);
  const h = a.hits.headers[0];
  assert.match(h['x-forwarded-for'], /127\.0\.0\.1|::1|::ffff:127/);
  assert.equal(h['x-forwarded-proto'], 'http');
  assert.ok(h['x-forwarded-host']);
  await lb.close(); await a.close();
});

test('hop-by-hop headers are stripped, not forwarded', async () => {
  const a = await backend('a');
  const lb = new LoadBalancer({ backends: [{ url: a.url }], health: false });
  const port = await lb.listen(0);
  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/', method: 'GET',
      headers: { 'x-keep': 'yes', 'proxy-authorization': 'secret' },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });
  const h = a.hits.headers[0];
  assert.equal(h['x-keep'], 'yes', 'ordinary headers pass through');
  assert.equal(h['proxy-authorization'], undefined, 'hop-by-hop header was removed');
  await lb.close(); await a.close();
});

test('active health checks take a sick backend out and bring it back', async () => {
  const flaky = await backend('flaky', {});
  const solid = await backend('solid');
  const lb = new LoadBalancer({
    backends: [{ url: flaky.url }, { url: solid.url }],
    health: { intervalMs: 30, timeoutMs: 200, fall: 2, rise: 1 },
    retries: 0,
  });
  const port = await lb.listen(0);

  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); }
    return false;
  };

  assert.ok(await waitFor(() => lb.health.rounds >= 2), 'health checker ran');
  assert.equal(lb.pools[0].healthy, true, 'healthy backend stays in rotation');

  flaky.behave.healthy = false;       // /healthz now returns 503
  assert.ok(await waitFor(() => lb.pools[0].healthy === false), 'marked down after `fall` probes');

  const before = flaky.hits.count;
  for (let i = 0; i < 6; i++) assert.equal((await get(port)).body, 'solid');
  assert.equal(flaky.hits.count, before, 'a down backend receives no traffic at all');

  flaky.behave.healthy = true;
  assert.ok(await waitFor(() => lb.pools[0].healthy === true), 'brought back after `rise` probes');

  await lb.close(); await flaky.close(); await solid.close();
});

test('one failed probe does not evict a backend (hysteresis)', async () => {
  const a = await backend('a');
  const lb = new LoadBalancer({
    backends: [{ url: a.url }], health: { intervalMs: 20, fall: 3, rise: 1 },
  });
  await lb.listen(0);
  await new Promise((r) => setTimeout(r, 60));

  lb.health.record(lb.pools[0], false);
  assert.equal(lb.pools[0].healthy, true, 'one bad probe is treated as noise');
  lb.health.record(lb.pools[0], false);
  assert.equal(lb.pools[0].healthy, true, 'two is still under the threshold');
  lb.health.record(lb.pools[0], false);
  assert.equal(lb.pools[0].healthy, false, 'three consecutive failures evicts it');

  await lb.close(); await a.close();
});

test('weighted routing sends traffic in proportion to capacity', async () => {
  const big = await backend('big'); const small = await backend('small');
  const lb = new LoadBalancer({
    backends: [{ url: big.url, weight: 4 }, { url: small.url, weight: 1 }],
    algorithm: 'weighted', health: false,
  });
  const port = await lb.listen(0);
  for (let i = 0; i < 50; i++) await get(port);
  assert.equal(big.hits.count, 40);
  assert.equal(small.hits.count, 10);
  await lb.close(); await big.close(); await small.close();
});

test('least-conn sends concurrent work to the idle backend', async () => {
  const slow = await backend('slow', { delayMs: 120 });
  const quick = await backend('quick', { delayMs: 1 });
  const lb = new LoadBalancer({
    backends: [{ url: slow.url }, { url: quick.url }],
    algorithm: 'least-conn', health: false,
  });
  const port = await lb.listen(0);

  // Fire 14 at once. Round robin would give each backend 7 and block on the
  // slow one; least-conn should pile most onto the quick backend, because the
  // slow one's in-flight count stays high.
  const results = await Promise.all(Array.from({ length: 14 }, () => get(port)));
  assert.equal(results.filter((r) => r.status === 200).length, 14);
  assert.ok(quick.hits.count > slow.hits.count,
    `quick:${quick.hits.count} slow:${slow.hits.count} — load followed capacity`);

  await lb.close(); await slow.close(); await quick.close();
});

test('the stats endpoint reports per-backend state', async () => {
  const a = await backend('a');
  const lb = new LoadBalancer({ backends: [{ url: a.url, weight: 2 }], health: false });
  const port = await lb.listen(0);
  await get(port);
  const res = await get(port, '/__lb/stats');
  const s = JSON.parse(res.body);
  assert.equal(s.algorithm, 'round-robin');
  assert.equal(s.counters.requests, 1);
  assert.equal(s.backends[0].weight, 2);
  assert.equal(s.backends[0].requests, 1);
  assert.equal(s.backends[0].breaker, 'closed');
  assert.ok(s.backends[0].ewmaMs > 0, 'latency was observed');
  await lb.close(); await a.close();
});
