import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, dispose, LeaseError, type LeaseServer } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, tempDir } from './helpers.js';

test('T-L5a: dispose releases lease within budget and removes the socket', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const lease = await acquire(socketPath, responder(), new AbortController().signal);

  const started = Date.now();
  await dispose(lease);
  assert.ok(Date.now() - started < 2000, 'dispose within the 2s closure budget');
  await assert.rejects(access(socketPath), /ENOENT/, 'socket inode removed on dispose');

  const next = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => dispose(next));
  assert.equal((await requestOverSocket(socketPath)).status, 200, 'lease re-acquirable after dispose');
});

test('T-L5b: dispose is idempotent across concurrent and repeated calls', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const lease = await acquire(socketPath, responder(), new AbortController().signal);

  await Promise.all([dispose(lease), dispose(lease), lease.dispose()]);
  await dispose(lease);
  await assert.rejects(access(socketPath), /ENOENT/);
});

test('T-L5c: unprovable closure retains the lease and reports failure', { timeout: 15000 }, async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const inner = responder();
  t.after(() => new Promise((resolve) => inner.close(() => resolve(undefined))));
  const hanging: LeaseServer = {
    listen: (path) => inner.listen(path),
    once: (event, listener) => inner.once(event, listener),
    off: (event, listener) => inner.off(event, listener),
    get listening() { return inner.listening; },
    close: () => undefined,
  };
  const lease = await acquire(socketPath, hanging, new AbortController().signal);

  await assert.rejects(dispose(lease), (error: unknown) =>
    error instanceof LeaseError && error.code === 'ERR_BRIDGE_DISPOSE_TIMEOUT');

  await assert.rejects(
    acquire(socketPath, responder(), new AbortController().signal),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_CONFLICT',
    'lease retained while closure is unprovable',
  );
});
