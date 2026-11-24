'use strict';
/**
 * breaker.js — per-backend circuit breaker.
 *
 *   CLOSED  --failures >= threshold-->  OPEN
 *   OPEN    --after cooldown-->         HALF_OPEN
 *   HALF_OPEN --one success-->          CLOSED
 *   HALF_OPEN --one failure-->          OPEN (cooldown doubles, capped)
 *
 * Why this exists: without it, a backend that is down still gets its share of
 * every request, and each one pays the full connect timeout before failing
 * over. At 1/3 of traffic and a 5s timeout, a third of your users wait 5
 * seconds for a page. The breaker's job is to fail those requests in
 * microseconds instead, and to spend exactly one request periodically asking
 * whether the backend is back.
 *
 * HALF_OPEN is the part people skip, and skipping it is what causes the
 * thundering herd on recovery: if OPEN went straight back to CLOSED on the
 * cooldown, the full traffic load arrives at a backend that just came up.
 * HALF_OPEN admits exactly one probe.
 */

const CLOSED = 'closed';
const OPEN = 'open';
const HALF_OPEN = 'half-open';

class Breaker {
  constructor(opts = {}) {
    this.threshold = opts.threshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 5_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 60_000;
    this.now = opts.clock ?? Date.now;

    this.state = CLOSED;
    this.failures = 0;
    this.openedAt = 0;
    this.cooldown = this.cooldownMs;
    this.probeInFlight = false;
    this.transitions = 0;
  }

  /** True if a request may be sent. Drives the OPEN -> HALF_OPEN move. */
  allows() {
    if (this.state === CLOSED) return true;
    if (this.state === OPEN) {
      if (this.now() - this.openedAt < this.cooldown) return false;
      this.state = HALF_OPEN;
      this.probeInFlight = false;
      this.transitions++;
    }
    // HALF_OPEN: exactly one probe at a time.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  succeed() {
    this.failures = 0;
    this.probeInFlight = false;
    if (this.state !== CLOSED) {
      this.state = CLOSED;
      this.cooldown = this.cooldownMs;   // reset the backoff on real recovery
      this.transitions++;
    }
  }

  fail() {
    this.probeInFlight = false;
    if (this.state === HALF_OPEN) {
      // The probe failed: go straight back to OPEN and wait longer. Without
      // the doubling, a backend that is down for an hour gets probed every
      // cooldown for an hour.
      this.state = OPEN;
      this.openedAt = this.now();
      this.cooldown = Math.min(this.maxCooldownMs, this.cooldown * 2);
      this.transitions++;
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold && this.state === CLOSED) {
      this.state = OPEN;
      this.openedAt = this.now();
      this.transitions++;
    }
  }

  forceOpen() { this.state = OPEN; this.openedAt = this.now(); }
  reset() { this.state = CLOSED; this.failures = 0; this.cooldown = this.cooldownMs; this.probeInFlight = false; }
}

module.exports = { Breaker, CLOSED, OPEN, HALF_OPEN };
