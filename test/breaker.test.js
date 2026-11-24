'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Breaker, CLOSED, OPEN, HALF_OPEN } = require('../src/breaker');

function clockAt(start = 0) {
  let t = start;
  const c = () => t;
  c.advance = (ms) => { t += ms; };
  return c;
}

test('stays closed while failures are below the threshold', () => {
  const b = new Breaker({ threshold: 3, clock: clockAt() });
  b.fail(); b.fail();
  assert.equal(b.state, CLOSED);
  assert.equal(b.allows(), true);
});

test('a success resets the failure count, so sporadic errors never trip it', () => {
  const b = new Breaker({ threshold: 3, clock: clockAt() });
  for (let i = 0; i < 20; i++) { b.fail(); b.fail(); b.succeed(); }
  assert.equal(b.state, CLOSED, '2 failures then a success, twenty times over, never trips');
});

test('opens at the threshold and sheds immediately', () => {
  const b = new Breaker({ threshold: 3, cooldownMs: 1000, clock: clockAt() });
  b.fail(); b.fail(); b.fail();
  assert.equal(b.state, OPEN);
  assert.equal(b.allows(), false, 'an open breaker sheds without a network call');
});

test('after the cooldown it admits exactly one probe', () => {
  const clock = clockAt();
  const b = new Breaker({ threshold: 1, cooldownMs: 1000, clock });
  b.fail();
  assert.equal(b.allows(), false);

  clock.advance(999);
  assert.equal(b.allows(), false, 'still cooling down');

  clock.advance(2);
  assert.equal(b.allows(), true, 'first caller becomes the probe');
  assert.equal(b.state, HALF_OPEN);
  assert.equal(b.allows(), false, 'a second concurrent caller is refused');
  assert.equal(b.allows(), false, 'and a third');
});

test('a successful probe closes the breaker and resets its cooldown', () => {
  const clock = clockAt();
  const b = new Breaker({ threshold: 1, cooldownMs: 1000, clock });
  b.fail();
  clock.advance(1001);
  b.allows();
  b.succeed();
  assert.equal(b.state, CLOSED);
  assert.equal(b.cooldown, 1000);
  assert.equal(b.allows(), true);
});

test('a failed probe reopens it and doubles the cooldown, capped', () => {
  const clock = clockAt();
  const b = new Breaker({ threshold: 1, cooldownMs: 100, maxCooldownMs: 800, clock });
  b.fail();
  const seen = [];
  for (let i = 0; i < 6; i++) {
    clock.advance(b.cooldown + 1);
    assert.equal(b.allows(), true, `probe ${i + 1} admitted`);
    b.fail();                      // backend is still down
    seen.push(b.cooldown);
  }
  assert.deepEqual(seen, [200, 400, 800, 800, 800, 800],
    'doubles, then saturates at maxCooldownMs so a long outage is not probed hard');
});

test('half-open does not let the full load back in on recovery', () => {
  // The herd test: 50 concurrent callers arrive the moment the cooldown ends.
  // Exactly one may through, or a backend that just came up is immediately
  // flattened by the traffic that killed it.
  const clock = clockAt();
  const b = new Breaker({ threshold: 1, cooldownMs: 100, clock });
  b.fail();
  clock.advance(101);
  const admitted = Array.from({ length: 50 }, () => b.allows()).filter(Boolean).length;
  assert.equal(admitted, 1);
});

test('forceOpen and reset work for the health checker', () => {
  const b = new Breaker({ clock: clockAt() });
  b.forceOpen();
  assert.equal(b.allows(), false);
  b.reset();
  assert.equal(b.state, CLOSED);
  assert.equal(b.allows(), true);
});
