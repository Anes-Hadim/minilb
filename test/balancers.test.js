'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoundRobin, SmoothWeighted, LeastConnections, PeakEwma, create } = require('../src/balancers');

const mk = (specs) => specs.map((s, i) => ({
  key: s.key ?? `b${i}`, weight: s.weight ?? 1, inFlight: s.inFlight ?? 0,
  ewmaMs: s.ewmaMs ?? 0, ewmaAt: s.ewmaAt ?? Date.now(),
}));

test('round robin cycles and distributes evenly', () => {
  const b = new RoundRobin();
  const pools = mk([{}, {}, {}]);
  const seen = [];
  for (let i = 0; i < 9; i++) seen.push(b.pick(pools).key);
  assert.deepEqual(seen, ['b0', 'b1', 'b2', 'b0', 'b1', 'b2', 'b0', 'b1', 'b2']);
});

test('smooth weighted respects the ratio', () => {
  const b = new SmoothWeighted();
  const pools = mk([{ key: 'a', weight: 5 }, { key: 'b', weight: 1 }]);
  const count = { a: 0, b: 0 };
  for (let i = 0; i < 6000; i++) count[b.pick(pools).key]++;
  assert.equal(count.a, 5000);
  assert.equal(count.b, 1000);
});

test('smooth weighted spreads picks instead of bursting', () => {
  // The naive weighted round robin for {a:3, b:2, c:1} emits "a a a b b c":
  // three requests hammer one backend, then two hammer the next. nginx's
  // algorithm emits "a b a c b a" — the same 3:2:1 ratio, interleaved.
  //
  // Note on the limit of this property: for weights {5, 1} a run of five is
  // unavoidable, because five `a`s and one `b` in a six-slot cycle must put
  // the `a`s in one contiguous arc. Smoothing can only help where a better
  // arrangement exists, so the test uses a ratio where one does.
  const b = new SmoothWeighted();
  const pools = mk([{ key: 'a', weight: 3 }, { key: 'b', weight: 2 }, { key: 'c', weight: 1 }]);
  const seq = [];
  for (let i = 0; i < 60; i++) seq.push(b.pick(pools).key);

  let longest = 1, run = 1;
  for (let i = 1; i < seq.length; i++) {
    run = seq[i] === seq[i - 1] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  assert.ok(longest <= 2, `longest run was ${longest}; naive WRR would give 3`);

  const counts = seq.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  assert.deepEqual(counts, { a: 30, b: 20, c: 10 }, 'exact 3:2:1 over 10 cycles');
  assert.deepEqual(seq.slice(0, 6), seq.slice(6, 12), 'the pattern is periodic, so credits return to zero');
});

test('smooth weighted keeps the exact ratio even at 5:1, where runs are unavoidable', () => {
  const b = new SmoothWeighted();
  const pools = mk([{ key: 'a', weight: 5 }, { key: 'b', weight: 1 }]);
  const seq = [];
  for (let i = 0; i < 6000; i++) seq.push(b.pick(pools).key);
  const counts = seq.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  assert.deepEqual(counts, { a: 5000, b: 1000 });
  // And b is not stranded at the end of the cycle the way naive WRR leaves it.
  assert.ok(seq.slice(0, 6).indexOf('b') < 5, `b appears at index ${seq.slice(0, 6).indexOf('b')} of the cycle, not last`);
});

test('smooth weighted with equal weights degenerates to round robin', () => {
  const b = new SmoothWeighted();
  const pools = mk([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(b.pick(pools).key);
  assert.deepEqual(new Set(seq.slice(0, 3)), new Set(['a', 'b', 'c']));
  assert.deepEqual(seq.slice(0, 3), seq.slice(3, 6));
});

test('least connections avoids a loaded backend', () => {
  const b = new LeastConnections();
  const pools = mk([{ key: 'busy', inFlight: 10 }, { key: 'idle', inFlight: 0 }]);
  for (let i = 0; i < 20; i++) assert.equal(b.pick(pools).key, 'idle');
});

test('least connections breaks ties round-robin, not always-first', () => {
  // All idle. A naive implementation that scans from index 0 and takes the
  // strict minimum sends every request to the first backend forever.
  const b = new LeastConnections();
  const pools = mk([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  const count = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 300; i++) count[b.pick(pools).key]++;
  for (const k of ['a', 'b', 'c']) {
    assert.equal(count[k], 100, `${k} got an even share of an idle cluster`);
  }
});

test('peak-EWMA prefers the faster backend', () => {
  const now = Date.now();
  const b = new PeakEwma({ rng: (() => { let i = 0; const s = [0, 0.5, 0.5, 0]; return () => s[i++ % s.length]; })() });
  const pools = mk([{ key: 'fast', ewmaMs: 5, ewmaAt: now }, { key: 'slow', ewmaMs: 500, ewmaAt: now }]);
  for (let i = 0; i < 10; i++) assert.equal(b.pick(pools, now).key, 'fast');
});

test('peak-EWMA weighs in-flight count as well as latency', () => {
  const now = Date.now();
  const b = new PeakEwma();
  // Same latency, different queue depth -> the shallower queue wins.
  const shallow = mk([{ key: 's', ewmaMs: 10, ewmaAt: now, inFlight: 0 }])[0];
  const deep = mk([{ key: 'd', ewmaMs: 10, ewmaAt: now, inFlight: 20 }])[0];
  assert.ok(b.score(shallow, now) < b.score(deep, now));

  // A fast-but-queued backend can still lose to a slow-but-free one.
  const fastQueued = mk([{ key: 'fq', ewmaMs: 10, ewmaAt: now, inFlight: 30 }])[0];
  const slowFree = mk([{ key: 'sf', ewmaMs: 100, ewmaAt: now, inFlight: 0 }])[0];
  assert.ok(b.score(slowFree, now) < b.score(fastQueued, now),
    'in-flight depth can outweigh a 10x latency difference');
});

test('peak-EWMA score decays toward optimism as a sample ages', () => {
  const b = new PeakEwma({ decayMs: 1000 });
  const now = 1_000_000;
  const stale = mk([{ key: 'x', ewmaMs: 900, ewmaAt: now - 10_000 }])[0];
  const fresh = mk([{ key: 'y', ewmaMs: 900, ewmaAt: now }])[0];
  assert.ok(b.score(stale, now) < b.score(fresh, now),
    'an old bad measurement loses influence, so a recovered backend is retried');
});

test('peak-EWMA samples two of many, so it cannot herd on one global best', () => {
  const now = Date.now();
  const b = new PeakEwma();
  // One backend is best by far, but with power-of-two-choices it is only
  // picked when it is in the sample — roughly 1 - ((n-1)/n)^2 of the time,
  // not always. That gap is the anti-herding property.
  const pools = mk(Array.from({ length: 10 }, (_, i) => ({ key: `b${i}`, ewmaMs: i === 0 ? 1 : 100, ewmaAt: now })));
  let best = 0;
  for (let i = 0; i < 20_000; i++) if (b.pick(pools, now).key === 'b0') best++;
  const share = best / 20_000;
  assert.ok(share > 0.1 && share < 0.3, `best backend took ${(share * 100).toFixed(1)}% (expected ~19%, never 100%)`);
});

test('every balancer handles an empty pool list', () => {
  for (const name of ['round-robin', 'weighted', 'least-conn', 'ewma']) {
    assert.equal(create(name).pick([]), null, name);
  }
});

test('every balancer returns the only pool when there is one', () => {
  for (const name of ['round-robin', 'weighted', 'least-conn', 'ewma']) {
    const pools = mk([{ key: 'only' }]);
    assert.equal(create(name).pick(pools).key, 'only', name);
  }
});

test('an unknown algorithm name fails loudly', () => {
  assert.throws(() => create('magic'), /unknown balancer "magic"/);
});
