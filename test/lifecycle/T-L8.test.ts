import assert from 'node:assert/strict';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, LeaseError } from '../../src/lib/socket.js';
import { cleanup, responder, tempDir } from './helpers.js';
import { stubIo } from './stub-io.js';

test('T-L8a: missing flock helper fails closed with the socket path untouched', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const io = stubIo({ helperAuto: 'spawnError' });

  await assert.rejects(
    acquire(socketPath, responder(), new AbortController().signal, io),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_FLOCK',
  );
  await assert.rejects(access(socketPath), /ENOENT/, 'socket path unchanged when helper is missing');
  const close = io.events.indexOf('lock-close');
  const error = io.events.indexOf('flock-error');
  assert.ok(error !== -1 && close > error, `lock fd closed after failed spawn observed, got ${io.events}`);
});

test('T-L8b: lease conflict failure leaves socket path and inode unchanged', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const owner = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => owner.dispose());
  const before = await lstat(socketPath);

  const io = stubIo({ helperAuto: 'conflict' });
  await assert.rejects(
    acquire(socketPath, responder(), new AbortController().signal, io),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_CONFLICT',
  );
  const after = await lstat(socketPath);
  assert.equal(after.ino, before.ino, 'socket inode unchanged on conflict');
  const reap = io.events.indexOf('flock-reap');
  const close = io.events.indexOf('lock-close');
  assert.ok(reap !== -1 && close > reap, `helper reaped before fd close, got ${io.events}`);
});

test('T-L8c: cancel during helper wait kills then reaps then closes fd', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const io = stubIo({ helperAuto: 'pending' });
  const controller = new AbortController();
  const pending = acquire(join(dir, 'bridge.sock'), responder(), controller.signal, io);
  const spawned = Date.now() + 5000;
  while (!io.events.includes('flock-spawn')) {
    if (Date.now() > spawned) assert.fail('flock helper never spawned');
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();
  await assert.rejects(pending);

  assert.deepEqual(
    io.events.filter((event) => event.startsWith('flock-') || event === 'lock-close'),
    ['flock-spawn', 'flock-kill', 'flock-reap', 'lock-close'],
  );
});
