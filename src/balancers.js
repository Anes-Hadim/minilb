'use strict';
/**
 * balancers.js — four ways to answer "which backend gets this request?"
 *
 * Each is a pure selection policy over a list of pools. Keeping them free of
 * I/O is what makes them testable: a test can assert the exact distribution
 * over 10,000 picks without a single socket.
 */

/* ---------------------------------------------------------------------- */

/** Plain round robin. Even distribution, blind to load and to capacity. */
class RoundRobin {
  constructor() { this.i = 0; }
  static id = 'round-robin';
  pick(pools) {
    if (pools.length === 0) return null;
    const chosen = pools[this.i % pools.length];
    this.i = (this.i + 1) % pools.length;
    return chosen;
  }
}

/**
 * Smooth weighted round robin — nginx's algorithm.
 *
 * The naive weighted round robin for weights {a:5, b:1} emits
 * `a a a a a b`: five requests hammer one backend, then one goes elsewhere.
 * Burstiness like that defeats the point of weighting.
 *
 * This one keeps a `current` credit per pool. Each pick adds every pool's
 * weight to its credit, takes the pool with the most credit, and subtracts
 * the total weight from the winner. The same weights now emit
 * `a a b a a a` — the same 5:1 ratio, spread out.
 */
class SmoothWeighted {
  static id = 'weighted';
  constructor() { this.credit = new Map(); }
  pick(pools) {
    if (pools.length === 0) return null;
    let total = 0;
    let best = null;
    let bestCredit = -Infinity;
    for (const p of pools) {
      const w = Math.max(1, p.weight | 0);
      total += w;
      const c = (this.credit.get(p.key) || 0) + w;
      this.credit.set(p.key, c);
      if (c > bestCredit) { bestCredit = c; best = p; }
    }
    this.credit.set(best.key, bestCredit - total);
    return best;
  }
}

/**
 * Least connections. Routes to whoever is holding the fewest in-flight
 * requests, which is the cheapest real signal of load you have.
 *
 * Beats round robin exactly when request costs are uneven: round robin keeps
 * feeding a backend that is stuck on a slow query, because it only counts
 * requests sent, not requests still open.
 */
class LeastConnections {
  static id = 'least-conn';
  constructor() { this.i = 0; }
  pick(pools) {
    if (pools.length === 0) return null;
    let best = null;
    let bestN = Infinity;
    // Rotating the scan start breaks ties round-robin instead of always
    // favouring the first pool in the list, which would make an idle cluster
    // route everything to one backend.
    for (let k = 0; k < pools.length; k++) {
      const p = pools[(this.i + k) % pools.length];
      if (p.inFlight < bestN) { bestN = p.inFlight; best = p; }
    }
    this.i = (this.i + 1) % pools.length;
    return best;
  }
}

/**
 * Peak-EWMA with power-of-two-choices — the policy Finagle and Envoy use.
 *
 * Two ideas stacked:
 *
 * 1. Score a backend by an exponentially weighted moving average of its
 *    latency, multiplied by its in-flight count. Latency alone is stale (a
 *    backend that just got slow has not reported it yet); in-flight alone is
 *    blind to how slow each of those requests is. The product reacts to both.
 *
 * 2. Do not pick the global best — sample two at random and take the better.
 *    Picking the global best is what causes herding: every balancer in the
 *    fleet sees the same "best" backend at the same instant and stampedes it,
 *    which makes it the worst backend, and the herd moves on together. Two
 *    random choices gets nearly the same quality with none of the
 *    synchronisation.
 */
class PeakEwma {
  static id = 'ewma';
  constructor(opts = {}) {
    this.decayMs = opts.decayMs ?? 10_000;
    this.rng = opts.rng ?? Math.random;
  }

  /** Decayed score: cost estimate for sending one more request here. */
  score(p, now) {
    // A backend with no sample yet gets an optimistic score, so a newly
    // healthy node actually receives traffic instead of being starved by
    // peers that already have good numbers.
    const base = p.ewmaMs > 0 ? p.ewmaMs : 1;
    const age = now - (p.ewmaAt || now);
    const decay = Math.exp(-age / this.decayMs);
    const decayed = base * decay + 1 * (1 - decay);   // drifts back toward 1ms
    return decayed * (p.inFlight + 1);
  }

  pick(pools, now = Date.now()) {
    if (pools.length === 0) return null;
    if (pools.length === 1) return pools[0];
    const a = pools[Math.floor(this.rng() * pools.length)];
    let b = pools[Math.floor(this.rng() * pools.length)];
    if (a === b) b = pools[(pools.indexOf(a) + 1) % pools.length];
    return this.score(a, now) <= this.score(b, now) ? a : b;
  }
}

const BALANCERS = { RoundRobin, SmoothWeighted, LeastConnections, PeakEwma };

function create(name, opts) {
  for (const B of Object.values(BALANCERS)) if (B.id === name) return new B(opts);
  throw new Error(`unknown balancer "${name}"; try ${Object.values(BALANCERS).map((b) => b.id).join(', ')}`);
}

module.exports = { ...BALANCERS, BALANCERS, create };
