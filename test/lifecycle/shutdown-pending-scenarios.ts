import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { acquire, dispose, type LeaseIo, type LockHandle, type PathStat } from '../../src/lib/socket.js';
import { failure, kernelLock, observedIo, quarantine } from './shutdown-fixture-support.js';

export async function runPendingScenario(scenario: string, dir: string): Promise<void> {
  // Given: one explicitly entered resource promise, not a timer phase guess.
  const path = `${dir}/bridge.sock`;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const { io: real, counts } = observedIo();
  const controller = new AbortController();
  const server = createServer();
  let listenCalls = 0;
  server.once('listening', () => { listenCalls += 1; });
  let fd = -1;
  let saved: PathStat | undefined;
  let chmodded = false;
  const hold = async <T>(operation: () => Promise<T>): Promise<T> => {
    entered.resolve();
    await release.promise;
    try { return await operation(); }
    finally { completed.resolve(); }
  };
  let io: LeaseIo;
  switch (scenario) {
    case 'pending-open':
    case 'pending-open-sync-abort':
      io = { ...real, openLock: (lockPath) => hold(async () => {
        const handle = await real.openLock(lockPath);
        fd = handle.fd;
        return handle;
      }) };
      if (scenario === 'pending-open-sync-abort') {
        const openLock = io.openLock;
        io = { ...io, openLock: (lockPath) => { controller.abort(); return openLock(lockPath); } };
      }
      break;
    case 'pending-lock-stat':
    case 'pending-lock-path-stat':
      io = { ...real, openLock: async (lockPath): Promise<LockHandle> => {
        const handle = await real.openLock(lockPath);
        fd = handle.fd;
        return { ...handle, stat: () => scenario === 'pending-lock-stat'
          ? hold(() => handle.stat()) : handle.stat() };
      }, lstat: (statPath) => statPath.endsWith('.lock') && scenario === 'pending-lock-path-stat'
        ? hold(() => real.lstat(statPath)) : real.lstat(statPath) };
      break;
    case 'pending-initial-stat':
      io = { ...real, lstat: (statPath) => statPath === path
        ? hold(() => real.lstat(statPath)) : real.lstat(statPath) };
      break;
    case 'pending-probe':
    case 'pending-stale-unlink': {
      const fixture = fileURLToPath(new URL('../../../test/lifecycle/fixtures/bind-stale.mjs', import.meta.url));
      const stale = spawnSync(process.execPath, [fixture, '', dir]);
      assert.equal(stale.status, 0);
      io = { ...real,
        probe: (probePath) => scenario === 'pending-probe' ? hold(() => real.probe(probePath)) : real.probe(probePath),
        unlink: (unlinkPath) => scenario === 'pending-stale-unlink' ? hold(() => real.unlink(unlinkPath)) : real.unlink(unlinkPath),
      };
      break;
    }
    case 'pending-bound-stat':
    case 'pending-final-stat':
    case 'pending-residual-stat':
    case 'pending-residual-unlink': {
      io = { ...real,
        chmod: async (chmodPath, mode) => { await real.chmod(chmodPath, mode); chmodded = true; },
        lstat: async (statPath) => {
          if (statPath !== path) return real.lstat(statPath);
          if (saved === undefined) {
            const stat = await real.lstat(statPath);
            saved = stat;
            return scenario === 'pending-bound-stat' ? hold(async () => stat) : stat;
          }
          if (chmodded && !controller.signal.aborted) {
            return scenario === 'pending-final-stat' ? hold(() => real.lstat(statPath)) : real.lstat(statPath);
          }
          if (scenario === 'pending-residual-stat') return hold(() => real.lstat(statPath));
          if (scenario === 'pending-residual-unlink') return saved;
          return real.lstat(statPath);
        },
        unlink: (unlinkPath) => scenario === 'pending-residual-unlink' ? hold(async () => {
          counts.unlink += 1;
        }) : real.unlink(unlinkPath),
      };
      break;
    }
    case 'pending-helper-reap':
      io = { ...real, spawnFlock: (lockFd) => {
        const helper = real.spawnFlock(lockFd);
        return { done: helper.done.then((code) => hold(async () => code)), kill: () => helper.kill() };
      } };
      break;
    default: assert.fail(`unknown pending scenario ${scenario}`);
  }
  const pending = acquire(path, server, controller.signal, io);
  let shutdown: Promise<unknown> = pending;
  if (scenario.startsWith('pending-residual-')) {
    const lease = await pending;
    controller.abort();
    shutdown = dispose(lease);
  }
  await entered.promise;
  // When: intent must bound reporting even for open/stat/probe/unlink/reap.
  controller.abort();
  await failure(shutdown, 'ERR_BRIDGE_DISPOSE_TIMEOUT');
  // Then: fd/real flock remain retained, late settlement never restarts acquisition.
  assert.equal(counts.lockClose, 0);
  if (fd >= 0) assert.ok(fstatSync(fd).isFile(), 'early captured fd retained through pending stat');
  const hasFlock = !['pending-open', 'pending-open-sync-abort', 'pending-lock-stat', 'pending-lock-path-stat'].includes(scenario);
  if (hasFlock) await quarantine(path);
  else await failure(acquire(path, createServer(), new AbortController().signal), 'ERR_BRIDGE_LEASE_STATE');
  release.resolve();
  await completed.promise;
  await failure(acquire(path, createServer(), new AbortController().signal), 'ERR_BRIDGE_LEASE_STATE');
  if (scenario.startsWith('pending-open')) {
    global.gc?.();
    assert.ok(fstatSync(fd).isFile(), 'late opened handle remains strongly retained after GC');
  }
  assert.equal(counts.lockClose, 0, 'late settlement cannot release quarantine');
  assert.equal(listenCalls, ['pending-bound-stat', 'pending-final-stat', 'pending-residual-stat', 'pending-residual-unlink'].includes(scenario) ? 1 : 0);
  if (hasFlock) kernelLock(path);
}
