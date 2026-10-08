import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { acquire, defaultIo, LeaseError, type LeaseIo, type LeaseServer } from '../../src/lib/socket.js';

export function facade(close: (callback?: (error?: Error) => void) => void) {
  const inner = createServer();
  const closeEntered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const state = { closeCalls: 0, intent: false };
  const server: LeaseServer = {
    listen: (path) => inner.listen(path),
    once: (event, listener) => inner.once(event, listener),
    off: (event, listener) => inner.off(event, listener),
    on: (event, listener) => inner.on(event, listener),
    get listening() { return inner.listening && !state.intent; },
    close: (callback) => {
      state.intent = true;
      state.closeCalls += 1;
      closeEntered.resolve();
      close((error) => { callback?.(error); closed.resolve(); });
    },
  };
  return { inner, server, state, closeEntered: closeEntered.promise, closed: closed.promise };
}

export function observedIo() {
  const counts = { unlink: 0, lockClose: 0 };
  const io: LeaseIo = {
    ...defaultIo,
    openLock: async (path) => {
      const handle = await defaultIo.openLock(path);
      return { fd: handle.fd, stat: () => handle.stat(), close: async () => {
        counts.lockClose += 1;
        await handle.close();
      } };
    },
    unlink: async (path) => { counts.unlink += 1; await defaultIo.unlink(path); },
  };
  return { io, counts };
}

export async function failure(promise: Promise<unknown>, code: LeaseError['code']): Promise<LeaseError> {
  const error = await promise.then(() => assert.fail(`expected ${code}`), (caught: unknown) => caught);
  assert.ok(error instanceof LeaseError);
  assert.equal(error.code, code);
  return error;
}

export function kernelLock(path: string, retained = true): void {
  const competitor = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', `${path}.lock`, 'true']);
  assert.equal(competitor.error, undefined);
  assert.equal(competitor.status, retained ? 75 : 0, 'independent process actually competes for flock');
}

export async function quarantine(path: string): Promise<void> {
  kernelLock(path);
  await failure(acquire(path, createServer(), new AbortController().signal), 'ERR_BRIDGE_LEASE_STATE');
}
