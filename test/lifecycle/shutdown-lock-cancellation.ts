import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { acquire, defaultIo, type LeaseIo, type LeaseServer } from '../../src/lib/socket.js';
import { facade } from './shutdown-fixture-support.js';

export async function runLockCancellation(scenario: 'sync-lock-path-abort' | 'sync-lock-handle-abort', dir: string): Promise<void> {
  // Given: real filesystem/HTTP resources; only the abort entry point is injected.
  const path = `${dir}/bridge.sock`;
  const controller = new AbortController();
  const fixture = facade((callback) => fixture.inner.close(callback));
  const counts = { bind: 0, probe: 0, flock: 0, lockClose: 0, pathStat: 0, handleStat: 0 };
  let fd = -1;
  const server: LeaseServer = { ...fixture.server, listen: (socketPath) => {
    counts.bind += 1;
    return fixture.inner.listen(socketPath);
  } };
  const io: LeaseIo = {
    ...defaultIo,
    openLock: async (lockPath) => {
      const handle = await defaultIo.openLock(lockPath);
      fd = handle.fd;
      return { fd: handle.fd, stat: () => {
        counts.handleStat += 1;
        switch (scenario) {
          case 'sync-lock-path-abort': break;
          case 'sync-lock-handle-abort': controller.abort(); break;
          default: scenario satisfies never;
        }
        return handle.stat();
      }, close: async () => {
        counts.lockClose += 1;
        await handle.close();
      } };
    },
    lstat: (statPath) => {
      if (statPath.endsWith('.lock')) {
        counts.pathStat += 1;
        switch (scenario) {
          case 'sync-lock-path-abort': controller.abort(); break;
          case 'sync-lock-handle-abort': break;
          default: scenario satisfies never;
        }
      }
      return defaultIo.lstat(statPath);
    },
    probe: (probePath) => { counts.probe += 1; return defaultIo.probe(probePath); },
    spawnFlock: (lockFd) => { counts.flock += 1; return defaultIo.spawnFlock(lockFd); },
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    // When: synchronous abort re-enters shutdown during the identity check.
    await assert.rejects(acquire(path, server, controller.signal, io), {
      code: 'ERR_BRIDGE_LEASE_CANCELLED', message: 'socket lease startup cancelled',
    });
    await setImmediate();
    // Then: cancellation is observed exactly through acquire, before bind/probe.
    assert.equal(unhandled.length, 0, `unhandled cancellation: ${unhandled.map(String).join(', ')}`);
    assert.equal(counts.pathStat, 1);
    assert.equal(counts.handleStat, scenario === 'sync-lock-handle-abort' ? 1 : 0);
    assert.deepEqual({ bind: counts.bind, probe: counts.probe, flock: counts.flock, lockClose: counts.lockClose },
      { bind: 0, probe: 0, flock: 0, lockClose: 1 });
    assert.equal(fixture.state.closeCalls, 0);
    assert.ok(fd >= 0);
    assert.throws(() => fstatSync(fd), { code: 'EBADF' });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}
