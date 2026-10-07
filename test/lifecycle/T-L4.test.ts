import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { acquire, LeaseError, type LeaseServer } from '../../src/lib/socket.js';
import { cleanup, responder, tempDir } from './helpers.js';
import { stubIo } from './stub-io.js';

class DeferrableServer extends EventEmitter implements LeaseServer {
  listening = false;
  private release?: () => void;

  constructor(private readonly events: string[]) {
    super();
  }

  listen(): unknown {
    this.events.push('server-listen');
    queueMicrotask(() => {
      new Promise<void>((resolve) => { this.release = resolve; }).then(() => {
        this.listening = true;
        this.emit('listening');
      });
    });
    return this;
  }

  completeBind(): void {
    this.release?.();
  }

  close(callback?: (error?: Error) => void): unknown {
    this.events.push('server-close');
    this.listening = false;
    queueMicrotask(() => callback?.());
    return this;
  }
}

test('T-L4a: pre-aborted signal cancels before any filesystem mutation', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    acquire(socketPath, responder(), controller.signal),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_CANCELLED',
  );
  await assert.rejects(access(socketPath), /ENOENT/, 'socket path never created');
  await assert.rejects(access(`${socketPath}.lock`), /ENOENT/, 'lock file never created');
});

test('T-L4b: cancel while flock helper pending kills and reaps helper before fd close', async (t) => {
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

  await assert.rejects(pending, (error: unknown) =>
    error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_CANCELLED');
  const kill = io.events.indexOf('flock-kill');
  const reap = io.events.indexOf('flock-reap');
  const close = io.events.indexOf('lock-close');
  assert.ok(kill !== -1 && reap > kill && close > reap, `kill -> reap -> fd close order, got ${io.events}`);
});

test('T-L4c: late bind after cancel is closed before the lease is released', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const events: string[] = [];
  const io = stubIo({ helperAuto: 'success', events });
  const server = new DeferrableServer(events);
  const controller = new AbortController();
  const pending = acquire(join(dir, 'bridge.sock'), server, controller.signal, io);

  const deadline = Date.now() + 5000;
  while (!events.includes('server-listen')) {
    if (Date.now() > deadline) assert.fail('bind never attempted');
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();
  server.completeBind();

  await assert.rejects(pending, (error: unknown) =>
    error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_CANCELLED');
  const serverClose = events.indexOf('server-close');
  const lockClose = events.indexOf('lock-close');
  assert.ok(serverClose !== -1, 'late bind closed by the cancellation barrier');
  assert.ok(lockClose !== -1 && lockClose > serverClose, `lease released after barrier, got ${events}`);
});
