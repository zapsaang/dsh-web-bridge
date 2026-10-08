import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, Socket } from 'node:net';
import { test } from 'node:test';
import { makeApply } from '../../src/dsh/apply.js';
import { acquire, defaultIo, LeaseError } from '../../src/lib/socket.js';
import { requestOverSocket, responder } from '../lifecycle/helpers.js';
import { atVerification, fixture, ObservedServer, ready } from './readiness-harness.js';
import { authority, probeBytes, rawProbe, successControls } from './readiness-wire.js';

function assertCancelled(result: unknown): void {
  assert.ok(result instanceof LeaseError, 'disposal must reject apply with the existing cancellation error');
  assert.equal(result.code, 'ERR_BRIDGE_LEASE_CANCELLED');
  assert.equal(result.message, 'socket lease startup cancelled');
}

for (const stale of [false, true]) {
  for (const stage of ['chmod', 'final-stat'] as const) {
    test(`readiness disposal: synchronously aborts when ${stale ? 'stale' : 'normal'} ${stage} is pending after a real event`,
      { timeout: 10000 }, async (t) => {
        // Given: a genuine bind and a genuine checkExpectation arrival precede intent.
        const app = await fixture(t, { stage, stale });
        await atVerification(app);
        const bytes = await rawProbe(app.socketPath, probeBytes('checkExpectation'));
        assert.deepEqual(app.server.arrivals, ['checkExpectation']);
        // When: dispose the raw typed Fiber while acquire is still awaiting IO.
        const disposed = app.fiber.dispose();
        // Then: intent aborts synchronously, before any await/released verification.
        assert.deepEqual(app.events, ['disposal-intent']);
        assert.equal(app.server.closeCalls, 1, 'disposal hook must synchronously abort the real listener before barrier release');
        app.dependencies.release();
        assertCancelled(await app.settled);
        await disposed;
        assert.deepEqual(app.events, ['disposal-intent', 'apply-rejected']);
        assert.equal(bytes.length, 0);
        assert.deepEqual(app.upstream.paths, []);
        assert.equal(app.factoryCalls(), 0);
        assert.equal(app.server.closeCalls, 1);
        assert.equal(app.dependencies.counts.lockCloses, 1);
        // Final-stat pending is caught by acquire, NOT independent proof of apply's last check.
      });
  }
}

test('readiness disposal: pre-bind cancellation never listens or probes a foreign live owner', { timeout: 10000 }, async (t) => {
  // Given: pending apply is blocked before opening a lock; a different owner binds meanwhile.
  const app = await fixture(t, { stage: 'chmod', preBind: true });
  await app.dependencies.openLockBarrier.entered;
  const owner = await acquire(app.socketPath, responder(), new AbortController().signal);
  try {
    // When
    const disposed = app.fiber.dispose();
    app.dependencies.release();
    // Then: no competitor bind or stale probe, and the actual owner still serves.
    assertCancelled(await app.settled);
    await disposed;
    assert.equal(app.server.listenCalls, 0);
    assert.equal(app.dependencies.counts.probes, 0);
    assert.equal(app.dependencies.counts.unlinks, 0);
    assert.deepEqual(app.server.arrivals, []);
    assert.equal((await requestOverSocket(app.socketPath)).body, 'ok');
    assert.deepEqual(app.upstream.paths, []);
  } finally { await owner.dispose(); }
});

test('readiness disposal: final apply check rejects an acquired lease when intent runs before its continuation', { timeout: 10000 }, async (t) => {
  // Given: the native verified stat's mode getter queues intent. Acquire's final
  // synchronous check/return run in the same stack, before this queued microtask;
  // the queued intent runs before apply's awaiting continuation. No fake readiness.
  const app = await fixture(t, { stage: 'chmod', disposeBeforeApplyResume: true });
  await atVerification(app);
  // When
  app.dependencies.release();
  // Then: this cancellation reaches apply's last check, not a pending-stat race.
  assertCancelled(await app.settled);
  await app.fiber.dispose();
  assert.deepEqual(app.events, ['disposal-intent', 'apply-rejected']);
  assert.equal(app.server.closeCalls, 1);
  assert.equal(app.dependencies.counts.lockCloses, 1);
  assert.deepEqual(app.upstream.paths, []);
});

test('readiness: actual flock contention never binds or probes the active owner', { timeout: 10000 }, async (t) => {
  // Given: real successful bridge owner holds the stable flock.
  const app = await fixture(t, { stage: 'chmod' });
  await atVerification(app);
  await ready(app);
  const contender = new ObservedServer();
  const counts = { probes: 0 };
  const apply = makeApply({ io: { ...app.dependencies.io,
    probe: async (path) => { counts.probes += 1; await app.dependencies.io.probe(path); } },
    createServer: () => contender });
  // When
  await assert.rejects(apply(app.ctx, { socketPath: app.socketPath, authorities: [authority], socketAccess: 'strict' }),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_CONFLICT');
  // Then
  assert.equal(contender.listenCalls, 0);
  assert.equal(counts.probes, 0);
  assert.deepEqual(contender.arrivals, []);
  await successControls(app.socketPath, app.upstream);
});

test('readiness disposal: ready raw Fiber invalidates admission synchronously before async unload', { timeout: 10000 }, async (t) => {
  // Given: ready success controls have reached real upstream paths; an accepted idle connection stays open.
  const app = await fixture(t, { stage: 'final-stat' });
  await atVerification(app);
  await ready(app);
  await successControls(app.socketPath, app.upstream);
  const arrivals = [...app.server.arrivals];
  const paths = [...app.upstream.paths];
  const accepted = once(app.server, 'connection');
  const client = connect({ path: app.socketPath });
  const chunks: Buffer[] = [];
  let disposalStarted = false;
  client.on('data', (chunk: Buffer) => chunks.push(chunk));
  client.setTimeout(1000, () => client.destroy(new Error('post-disposal client close timed out')));
  const clientClosed = new Promise<void>((resolve, reject) => {
    client.once('close', () => resolve());
    client.on('error', (error: Error) => {
      if (disposalStarted && 'code' in error && (error.code === 'EPIPE' || error.code === 'ECONNRESET')) return;
      reject(error);
    });
  });
  await once(client, 'connect');
  const [socket] = await accepted;
  assert.ok(socket instanceof Socket);
  client.write(`GET /api/probe HTTP/1.1\r\nHost: ${authority}\r\n`);
  // When: intent synchronously invalidates before unload/effect microtasks can run.
  disposalStarted = true;
  const disposed = app.fiber.dispose();
  // Then: established connections are already destroyed; no newly completed request is admitted.
  assert.equal(socket.destroyed, true, 'hook invalidates and aborts BEFORE fiber.dispose returns its promise');
  assert.equal(app.server.closeCalls, 1);
  client.write('Connection: close\r\n\r\n');
  await clientClosed;
  await disposed;
  assert.equal(Buffer.concat(chunks).length, 0);
  assert.deepEqual(app.server.arrivals, arrivals);
  assert.deepEqual(app.upstream.paths, paths);
  await assert.rejects(rawProbe(app.socketPath, probeBytes('request')),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
  assert.equal(app.dependencies.counts.lockCloses, 1, 'returned disposer and early effect share one shutdown');
  assert.equal(app.server.closeCalls, 1);
});

test('readiness disposal: returned cleanup remains idempotent across explicit calls and Cordis effects', { timeout: 10000 }, async (t) => {
  // Given
  const app = await fixture(t, { stage: 'chmod' });
  await atVerification(app);
  const cleanup = await ready(app);
  await successControls(app.socketPath, app.upstream);
  // When
  await Promise.all([cleanup(), cleanup(), app.fiber.dispose()]);
  // Then
  assert.equal(app.server.closeCalls, 1);
  assert.equal(app.dependencies.counts.lockCloses, 1);
});

test('readiness disposal: early effect owns cleanup when direct apply has no collected returned disposer', { timeout: 10000 }, async (t) => {
  // Given: a direct call on the root context is not collected by Cordis plugin execution.
  const app = await fixture(t, { stage: 'chmod' });
  await atVerification(app);
  await ready(app);
  const server = new ObservedServer();
  const apply = makeApply({ io: defaultIo, createServer: () => server });
  const socketPath = `${app.socketPath}.direct`;
  const cleanup = await apply(app.ctx, { socketPath, authorities: [authority], socketAccess: 'strict' });
  t.after(cleanup);
  await successControls(socketPath, app.upstream);
  // When: root unload runs the early effect, with no raw-child disposal notification for this direct call.
  await app.ctx.fiber.dispose();
  // Then
  assert.equal(server.closeCalls, 1, 'early effect must clean up even without a collected returned disposer');
  await cleanup();
  assert.equal(server.closeCalls, 1);
});
