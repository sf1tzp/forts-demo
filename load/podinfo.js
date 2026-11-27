// k6 load script for podinfo on outpost — exercises the API surface so
// the Grafana panels (request rate by status, error ratio, p99) have
// real traffic behind them, and the logs stream has requests to show at
// logLevel=debug.
//
// Run from the repo root (k6 is Go, so SSL_CERT_FILE teaches it the
// estate's step-ca root):
//
//   SSL_CERT_FILE=nixos/certs/ca-root.pem k6 run load/podinfo.js
//
// Knobs (all -e / env):
//   BASE_URL   target            default https://podinfo.outpost.forts-demo.mesh
//   RPS        steady request rate            default 4
//   DURATION   how long to run                default 5m
//   ERROR_RPS  extra GET /status/500 per sec  default 0
//
// ERROR_RPS is the no-PR way to exercise PodinfoErrorRateHigh: the
// alert fires when 5xx exceeds 5% of requests over 5m, so with RPS=4
// anything above ~0.5 trips it after the `for: 5m` — e.g.
//
//   SSL_CERT_FILE=nixos/certs/ca-root.pem k6 run -e ERROR_RPS=2 -e DURATION=15m load/podinfo.js
//
// and stopping the run heals it. (The faults.* values in release.yaml
// remain the GitOps way to break the app itself.)
//
// Deliberately not called: /panic (kills the pod — that story belongs
// to faults.unhealthy), /readyz/disable, and /cache/* (no redis behind
// this deployment).

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'https://podinfo.outpost.forts-demo.mesh';
const RPS = Number(__ENV.RPS || 4);
const DURATION = __ENV.DURATION || '5m';
const ERROR_RPS = Number(__ENV.ERROR_RPS || 0);

const scenarios = {
  traffic: {
    executor: 'constant-arrival-rate',
    rate: RPS,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 10,
    maxVUs: 30,
    exec: 'traffic',
  },
};

if (ERROR_RPS > 0) {
  scenarios.faults = {
    executor: 'constant-arrival-rate',
    rate: ERROR_RPS,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 5,
    maxVUs: 10,
    exec: 'faults',
  };
}

export const options = {
  scenarios,
  thresholds: {
    // The faults scenario marks its 500s expected, so this guards the
    // real traffic only.
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // Latency guard on the fast routes; delay/chunked are tagged slow
    // and exempt.
    'http_req_duration{kind:fast}': ['p(95)<1500'],
  },
};

// Weighted mix of the API surface. The `name` tag keeps per-route
// metrics tidy (no /store/<hash> cardinality).
const routes = [
  { weight: 4, run: () => get('/', 'ui') },
  { weight: 3, run: () => get('/version', 'version') },
  { weight: 2, run: () => get('/api/info', 'api-info') },
  { weight: 2, run: () => get('/env', 'env') },
  { weight: 2, run: () => get('/headers', 'headers') },
  { weight: 1, run: () => get('/configs', 'configs') },
  {
    weight: 3,
    run: () => {
      const res = http.post(`${BASE}/api/echo`, JSON.stringify({ ts: Date.now(), vu: __VU }), {
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'api-echo', kind: 'fast' },
      });
      check(res, { 'echo 202': (r) => r.status === 202 });
    },
  },
  {
    weight: 2,
    run: () => {
      // JWT round-trip: mint a token, validate it.
      const tok = http.post(`${BASE}/token`, 'k6', { tags: { name: 'token', kind: 'fast' } });
      const ok = check(tok, { 'token 200': (r) => r.status === 200 });
      if (!ok) return;
      const val = http.get(`${BASE}/token/validate`, {
        headers: { Authorization: `Bearer ${tok.json('token')}` },
        tags: { name: 'token-validate', kind: 'fast' },
      });
      check(val, { 'validate 200': (r) => r.status === 200 });
    },
  },
  {
    weight: 1,
    run: () => {
      // Store round-trip: write a payload, read it back by hash.
      const put = http.post(`${BASE}/store`, `k6-${__VU}-${Date.now()}`, {
        tags: { name: 'store-write', kind: 'fast' },
      });
      const ok = check(put, { 'store 202': (r) => r.status === 202 });
      if (!ok) return;
      const got = http.get(`${BASE}/store/${put.json('hash')}`, {
        tags: { name: 'store-read', kind: 'fast' },
      });
      check(got, { 'store read 202': (r) => r.status === 202 });
    },
  },
  {
    weight: 1,
    run: () => {
      const res = http.get(`${BASE}/delay/1`, { tags: { name: 'delay', kind: 'slow' } });
      check(res, { 'delay 200': (r) => r.status === 200 });
    },
  },
  {
    weight: 1,
    run: () => {
      const res = http.get(`${BASE}/chunked/1`, { tags: { name: 'chunked', kind: 'slow' } });
      check(res, { 'chunked 200': (r) => r.status === 200 });
    },
  },
];

const totalWeight = routes.reduce((sum, r) => sum + r.weight, 0);

function get(path, name) {
  const res = http.get(`${BASE}${path}`, { tags: { name, kind: 'fast' } });
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
}

export function traffic() {
  let pick = Math.random() * totalWeight;
  for (const route of routes) {
    pick -= route.weight;
    if (pick < 0) {
      route.run();
      return;
    }
  }
}

export function faults() {
  // Podinfo records the 500 in its own histogram, which is what the
  // alert reads; expectedStatuses keeps it out of k6's failure rate.
  http.get(`${BASE}/status/500`, {
    tags: { name: 'status-500', kind: 'fast' },
    responseCallback: http.expectedStatuses(500),
  });
}

export function teardown() {
  // Nothing to clean up: /store files live in the pod and the demo pod
  // is disposable.
  sleep(0);
}
