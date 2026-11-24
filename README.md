# minilb

An L7 HTTP load balancer. Four balancing policies, active **and** passive health
checking, a per-backend circuit breaker, and retries that know which HTTP
methods are safe to replay. **Zero dependencies** — `node:http` and nothing else.

I had already deployed Nginx as a reverse proxy during an infrastructure
internship. This exists because I wanted to know what it was doing while I was
writing `upstream { }` blocks.

```console
$ minilb --backend http://10.0.0.1:3000 \
         --backend http://10.0.0.2:3000:3 \
         --algorithm ewma --port 8080
minilb: :8080 -> http://10.0.0.1:3000(w1) http://10.0.0.2:3000(w3)
minilb: algorithm=ewma health=on
```

## The four policies, and when each one wins

| | Signal it uses | Wins when |
|---|---|---|
| `round-robin` | nothing | backends and requests are uniform |
| `weighted` | configured capacity | backends have different sizes |
| `least-conn` | in-flight count | request costs are uneven |
| `ewma` | latency × in-flight | backends degrade rather than die |

**`weighted` is nginx's smooth algorithm, not the naive one.** The naive
weighted round robin for weights `{a:3, b:2, c:1}` emits `a a a b b c` — three
requests hammer one backend, then two hammer the next. Burstiness like that
defeats the point of weighting. This keeps a credit per backend, adds every
weight to every credit on each pick, takes the highest, and subtracts the total
from the winner. Same 3:2:1 ratio, emitted as `a b a c b a`.

There is a limit to that property and the tests say so: for weights `{5, 1}` a
run of five is *unavoidable*, because five `a`s and one `b` in a six-slot cycle
must put the `a`s in one contiguous arc. Smoothing only helps where a better
arrangement exists.

**`least-conn` beats round robin exactly when request costs are uneven.** Round
robin keeps feeding a backend that is stuck on a slow query, because it counts
requests *sent*, not requests still *open*. One test fires 14 concurrent
requests at a 120 ms backend and a 1 ms backend and asserts the load follows
capacity.

**`ewma` is peak-EWMA with power-of-two-choices**, the policy Finagle and Envoy
use. Two ideas stacked:

- Score a backend by an exponentially weighted moving average of its latency
  **times** its in-flight count. Latency alone is stale — a backend that just
  got slow has not reported it yet. In-flight alone is blind to how slow each
  of those requests is. The product reacts to both.
- Do not pick the global best. **Sample two at random and take the better one.**
  Picking the global best is what causes herding: every balancer in the fleet
  sees the same "best" backend at the same instant, stampedes it, makes it the
  worst backend, and the herd moves on together. One test puts one excellent
  backend among ten and asserts it receives ~19% of traffic — not 100%.

Scores also **decay toward optimism** as a sample ages, so a backend that was
briefly terrible gets retried instead of being blacklisted by one bad minute.

## Failure handling

**Retries respect idempotency.** A `GET` that fails is retried on a different
backend. A `POST` is **not**, because the first attempt may well have succeeded
and lost only the response — retrying it can charge a card twice. One test
sends a `POST` at a dead backend and asserts it returns `502` rather than being
replayed on the live one, and that the live backend never saw it.

**The circuit breaker has a half-open state, which is the part people skip.**

```
CLOSED  --failures >= threshold-->  OPEN
OPEN    --after cooldown-->         HALF_OPEN
HALF_OPEN --one success-->          CLOSED
HALF_OPEN --one failure-->          OPEN  (cooldown doubles, capped)
```

Without a breaker, a dead backend still gets its share of traffic and each
request pays the full connect timeout before failing over — at one backend in
three and a 5 s timeout, a third of your users wait 5 seconds. The breaker
fails those in microseconds and spends exactly one request periodically asking
whether the backend is back.

Skipping `HALF_OPEN` is what causes the thundering herd on recovery: if `OPEN`
went straight to `CLOSED`, full production load would arrive at a backend that
just came up. One test has 50 callers arrive the instant the cooldown ends and
asserts **exactly one** gets through.

**Active and passive health checks are both needed.** The breaker only learns a
backend is down by sending real user requests at it. Active probes pay a cheap
synthetic request on a timer, so a backend that dies between user requests is
known to be down before the next user arrives. But active checks alone miss
failures that only appear under real traffic — a slow query path, one route
500ing — so passive detection is still what catches those. Probes apply
hysteresis (`fall: 2`, `rise: 1` by default), because one dropped packet should
not evict a healthy backend.

## Tests

```console
$ npm test
ℹ tests 37
ℹ pass 37
ℹ fail 0
```

The policy tests are pure and assert exact distributions over thousands of
picks. The proxy tests run **real HTTP backends** on real sockets and cover
failover, timeout-then-failover, breaker trip, body streaming (a 100 KB upload
through unchanged), header rewriting, hop-by-hop header stripping, and an
active health checker taking a backend out and bringing it back.

Two bugs the tests actually caught, both worth writing down:

- **Health probes used Node's global agent**, which keep-alives since Node 19.
  Every probe left a socket open against every backend forever, and a backend
  shutting down could never finish closing. Fixed with `agent: false` — a
  health probe has no business pooling connections.
- A `hang: true` test backend held a socket open, so `server.close()` waited on
  it indefinitely and the suite ran for 110 seconds before timing out instead
  of 0.5 seconds. `closeAllConnections()` first.

## Known limits

- **HTTP/1.1 only, no TLS.** Real edge deployments terminate TLS; this assumes
  something in front already did. No HTTP/2, no h2c.
- **No WebSocket / `CONNECT` upgrade.** `Upgrade` is stripped as hop-by-hop, so
  a WebSocket handshake through this proxy fails. Supporting it means handling
  the `upgrade` event and splicing two raw sockets.
- **Config is static.** Backends come from argv or a JSON file read at startup.
  No service discovery, no runtime reconfiguration, no draining a backend
  gracefully.
- **Single process.** No `cluster`, so one core. A real deployment would fork
  per core behind `SO_REUSEPORT`.
- **Breaker state is per process.** Fork four workers and you get four
  independent opinions about each backend's health.
- **No rate limiting or request buffering**, so a slowloris client ties up a
  socket for as long as it likes.

## Layout

```
src/balancers.js  the four selection policies, pure and I/O-free
src/breaker.js    circuit breaker with half-open probing and cooldown backoff
src/health.js     active probes with rise/fall hysteresis
src/pool.js       one backend: counters, EWMA, keep-alive agent, breaker
src/proxy.js      streaming reverse proxy, retry logic, header rewriting
src/cli.js        argv / JSON config front end
```

MIT.
