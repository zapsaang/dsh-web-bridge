import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { createServer } from 'node:http';
import { acquire, defaultIo, type LeaseIo, type LeaseServer } from '../../src/lib/socket.js';
import { failure, observedIo } from './shutdown-fixture-support.js';

export async function runAliasScenario(scenario: string, dir: string): Promise<void> {
  // Given: accepted absolute spellings, with native open held at a named barrier.
  const canonical = `${dir}/bridge.sock`;
  const alias = `${dir}/${scenario.includes('double-slash') ? '/' : './'}bridge.sock`;
  const path = scenario.endsWith('-reverse') ? alias : canonical;
  const replacement = scenario.endsWith('-reverse') ? canonical : alias;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const { io: real, counts } = observedIo();
  let fd = -1;
  let nativeOpens = 0;
  const io: LeaseIo = { ...real, openLock: async (lockPath) => {
    assert.equal(lockPath, `${path}.lock`, 'native path keeps the original spelling');
    entered.resolve();
    await release.promise;
    nativeOpens += 1;
    const handle = await real.openLock(lockPath);
    fd = handle.fd;
    completed.resolve();
    return handle;
  } };
  const controller = new AbortController();
  const pending = acquire(path, createServer(), controller.signal, io);
  await entered.promise;
  assert.equal(nativeOpens, 0);
  controller.abort();
  await failure(pending, 'ERR_BRIDGE_DISPOSE_TIMEOUT');

  const attempts = { open: 0, probe: 0, bind: 0 };
  const replacementIo: LeaseIo = { ...defaultIo,
    openLock: (lockPath) => { attempts.open += 1; return defaultIo.openLock(lockPath); },
    probe: (socketPath) => { attempts.probe += 1; return defaultIo.probe(socketPath); },
  };
  const inner = createServer();
  const server: LeaseServer = {
    listen: (socketPath) => { attempts.bind += 1; return inner.listen(socketPath); },
    close: (callback) => inner.close(callback),
    once: (event, listener) => inner.once(event, listener),
    off: (event, listener) => inner.off(event, listener),
    on: (event, listener) => inner.on(event, listener),
    get listening() { return inner.listening; },
  };
  // When: replacement uses an equivalent spelling before the original native open.
  await failure(acquire(replacement, server, new AbortController().signal, replacementIo), 'ERR_BRIDGE_LEASE_STATE');
  // Then: registry rejection precedes every new resource operation.
  assert.deepEqual(attempts, { open: 0, probe: 0, bind: 0 });
  release.resolve();
  await completed.promise;
  await failure(acquire(replacement, server, new AbortController().signal, replacementIo), 'ERR_BRIDGE_LEASE_STATE');
  await failure(acquire(path, createServer(), new AbortController().signal), 'ERR_BRIDGE_LEASE_STATE');
  global.gc?.();
  assert.ok(fstatSync(fd).isFile(), 'late opened handle remains strongly retained after GC');
  assert.equal(counts.lockClose, 0, 'late settlement cannot release quarantine');
  assert.deepEqual(attempts, { open: 0, probe: 0, bind: 0 });
  // Only isolated child exit tears down quarantine; the parent cleans afterward.
}
