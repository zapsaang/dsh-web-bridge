import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atVerification, fixture, ready } from './readiness-harness.js';
import { probeBytes, rawProbe, routes, successControls } from './readiness-wire.js';

for (const stale of [false, true]) {
  for (const stage of ['chmod', 'final-stat'] as const) {
    for (const route of routes) {
      test(`readiness: ${route} closes with zero bytes when ${stale ? 'stale' : 'normal'} ${stage} verification is pending`,
        { timeout: 10000 }, async (t) => {
          // Given: real apply has bound, but its named verification await is pending.
          const app = await fixture(t, { stage, stale });
          await atVerification(app);
          assert.equal(app.dependencies.counts.probes, stale ? 1 : 0, 'real stale probe, never an ENOENT probe');
          assert.equal(app.dependencies.counts.unlinks, stale ? 1 : 0, 'real stale reclaim precedes bind');
          // When: a syntax-valid raw connection reaches exactly the named Node event.
          const bytes = await rawProbe(app.socketPath, probeBytes(route));
          // Then: no HTTP, proxy, bootstrap, exchange, headers, cookie, or queue.
          assert.deepEqual(app.server.arrivals, [route]);
          assert.equal(bytes.length, 0, `${route}: expected zero HTTP bytes before ready; got ${bytes.toString('latin1')}`);
          assert.deepEqual(app.upstream.paths, [], 'zero genuine upstream business paths before ready');
          assert.deepEqual(app.upstream.headers, []);
          assert.equal(app.factoryCalls(), 0);
          await ready(app);
          await successControls(app.socketPath, app.upstream);
          assert.equal(app.factoryCalls(), 1, 'only the NEW ready navigation exchanges');
        });
    }
  }
}

test('readiness: native malformed control never visits any of the four admission events', { timeout: 10000 }, async (t) => {
  // Given
  const app = await fixture(t, { stage: 'chmod' });
  await atVerification(app);
  // When: native parser rejects this before dispatch (NOT a four-route probe).
  const bytes = await rawProbe(app.socketPath, 'GET / HTTP/1.1\r\nHost: bad\r\nBad Header: value\r\n\r\n');
  // Then: native 400 is permitted; no admission event or business work occurred.
  assert.match(bytes.toString('latin1'), /^HTTP\/1\.1 400 /);
  assert.deepEqual(app.server.arrivals, []);
  assert.deepEqual(app.upstream.paths, []);
  assert.equal(app.factoryCalls(), 0);
  await ready(app);
  await successControls(app.socketPath, app.upstream);
});

import './readiness-disposal.js';
