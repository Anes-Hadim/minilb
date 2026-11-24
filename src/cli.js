#!/usr/bin/env node
'use strict';
/** minilb — run the balancer from the command line or a JSON config. */
const fs = require('node:fs');
const { LoadBalancer } = require('./proxy');

function usage() {
  console.error(`minilb — L7 HTTP load balancer

  minilb --backend http://127.0.0.1:3001 --backend http://127.0.0.1:3002:2 \\
         --algorithm ewma --port 8080

  minilb --config lb.json

Options
  --backend URL[:weight]   repeatable; weight defaults to 1
  --algorithm NAME         round-robin (default) | weighted | least-conn | ewma
  --port N                 listen port, default 8080
  --retries N              retries for idempotent methods, default 2
  --timeout MS             upstream timeout, default 10000
  --health-path PATH       probe path, default /healthz
  --no-health              disable active health checks
  --config FILE            JSON with the same keys

Endpoints
  /__lb/stats              per-backend state as JSON
`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (!argv.length) usage();

const cfg = { backends: [], algorithm: 'round-robin', port: 8080 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => { const v = argv[++i]; if (v === undefined) usage(); return v; };
  switch (a) {
    case '--backend': {
      const spec = next();
      // Split on the last colon only if it is followed by digits alone, so
      // "http://host:3001" is a port and "http://host:3001:2" is port+weight.
      const m = /^(.*):(\d+)$/.exec(spec);
      if (m && /^https?:\/\/.*:\d+$/.test(m[1])) cfg.backends.push({ url: m[1], weight: Number(m[2]) });
      else cfg.backends.push({ url: spec, weight: 1 });
      break;
    }
    case '--algorithm': cfg.algorithm = next(); break;
    case '--port': cfg.port = Number(next()); break;
    case '--retries': cfg.retries = Number(next()); break;
    case '--timeout': cfg.timeoutMs = Number(next()); break;
    case '--health-path': cfg.health = { ...(cfg.health || {}), path: next() }; break;
    case '--no-health': cfg.health = false; break;
    case '--config': Object.assign(cfg, JSON.parse(fs.readFileSync(next(), 'utf8'))); break;
    case '-h': case '--help': usage(); break;
    default: console.error(`unknown option ${a}\n`); usage();
  }
}

if (!cfg.backends.length) { console.error('at least one --backend is required\n'); usage(); }

const lb = new LoadBalancer(cfg);
lb.listen(cfg.port).then((port) => {
  console.log(`minilb: :${port} -> ${cfg.backends.map((b) => `${b.url}(w${b.weight ?? 1})`).join(' ')}`);
  console.log(`minilb: algorithm=${cfg.algorithm} health=${cfg.health === false ? 'off' : 'on'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\nminilb: draining');
    await lb.close();
    process.exit(0);
  });
}
