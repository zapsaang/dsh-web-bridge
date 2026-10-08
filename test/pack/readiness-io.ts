import assert from 'node:assert/strict';
import { defaultIo, type LeaseIo } from '../../src/lib/socket.js';

export function barrier() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => { entered.resolve(); await released.promise; },
  };
}

export type VerificationBarrier = 'chmod' | 'final-stat';

/** Per-call barriers leave every filesystem/flock operation real. */
export function readinessIo(socketPath: string, stage: VerificationBarrier, afterVerifiedMode?: () => void) {
  const chmodBarrier = barrier();
  const finalStatBarrier = barrier();
  const openLockBarrier = barrier();
  const counts = { probes: 0, unlinks: 0, lockCloses: 0 };
  let chmodCompleted = false;
  let finalStatEntered = false;
  let holdOpenLock = false;
  const io: LeaseIo = {
    ...defaultIo,
    openLock: async (path) => {
      if (holdOpenLock) await openLockBarrier.wait();
      const handle = await defaultIo.openLock(path);
      return { fd: handle.fd, stat: () => handle.stat(), close: async () => {
        counts.lockCloses += 1;
        await handle.close();
      } };
    },
    chmod: async (path, mode) => {
      assert.equal(path, socketPath);
      if (stage === 'chmod') await chmodBarrier.wait();
      await defaultIo.chmod(path, mode);
      chmodCompleted = true;
    },
    lstat: async (path) => {
      if (path === socketPath && chmodCompleted && !finalStatEntered) {
        finalStatEntered = true;
        if (stage === 'final-stat') await finalStatBarrier.wait();
        const stat = await defaultIo.lstat(path);
        if (afterVerifiedMode === undefined) return stat;
        let queued = false;
        return {
          dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid,
          isSocket: () => stat.isSocket(), isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(),
          get mode() {
            if (!queued) { queued = true; queueMicrotask(afterVerifiedMode); }
            return stat.mode;
          },
        };
      }
      return defaultIo.lstat(path);
    },
    probe: async (path) => { counts.probes += 1; await defaultIo.probe(path); },
    unlink: async (path) => { counts.unlinks += 1; await defaultIo.unlink(path); },
  };
  return {
    io, counts, chmodBarrier, finalStatBarrier, openLockBarrier,
    verification: stage === 'chmod' ? chmodBarrier : finalStatBarrier,
    holdOpenLock: () => { holdOpenLock = true; },
    release: () => { chmodBarrier.release(); finalStatBarrier.release(); openLockBarrier.release(); },
  };
}
