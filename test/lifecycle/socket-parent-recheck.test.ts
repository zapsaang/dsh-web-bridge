import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, chown, lstat, mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, codeOf, defaultIo, dispose, type LeaseIo, type LeaseServer,
  type PathStat } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, tempDir } from './helpers.js';
import { failure, kernelLock } from './shutdown-fixture-support.js';

const euid = process.geteuid?.() ?? 0;
const egid = process.getegid?.() ?? 0;
const groups = process.getgroups?.().filter((gid) => gid !== egid) ?? [];

async function groupParent(t: test.TestContext) {
  const gid = groups[0];
  if (gid === undefined) {
    t.skip('no supplementary group distinct from EGID for native group parent fixture');
    return undefined;
  }
  const root = await tempDir();
  t.after(() => cleanup(root));
  const dir = join(root, 'shared');
  await mkdir(dir);
  await chown(dir, euid, gid);
  await chmod(dir, 0o2710);
  return { dir, gid, socketPath: join(dir, 'bridge.sock') };
}

// Per-acquisition facade forwards the real connection hook and native close
// callback; it never substitutes a close-call flag for successful shutdown.
function observedNative() {
  const inner = responder();
  const accepted = Promise.withResolvers<void>();
  const inboundClosed = Promise.withResolvers<void>();
  inner.on('connection', (socket) => {
    socket.once('close', () => inboundClosed.resolve());
    accepted.resolve();
  });
  const calls = { bind: 0, probe: 0, chmod: 0, openLock: 0, close: 0, nativeCloseSuccess: 0 };
  const server: LeaseServer = {
    listen: (path) => { calls.bind += 1; return inner.listen(path); },
    once: (event, listener) => inner.once(event, listener),
    off: (event, listener) => inner.off(event, listener),
    on: (event, listener) => inner.on(event, listener),
    get listening() { return inner.listening; },
    close: (callback) => {
      calls.close += 1;
      return inner.close((error) => {
        if (error === undefined) calls.nativeCloseSuccess += 1;
        callback?.(error);
      });
    },
  };
  const io: LeaseIo = {
    ...defaultIo,
    openLock: async (path) => { calls.openLock += 1; return defaultIo.openLock(path); },
    probe: async (path) => { calls.probe += 1; await defaultIo.probe(path); },
    chmod: async (path, mode) => { calls.chmod += 1; await defaultIo.chmod(path, mode); },
  };
  return { server, io, calls, accepted: accepted.promise, inboundClosed: inboundClosed.promise };
}

// Named initial-socket-ENOENT barrier: native initial parent/ancestor trust
// checks and real flock are complete, but native prebind parent lstat is not.
function initialSocketEnoentBarrier(socketPath: string, mutation: () => Promise<void>, io: LeaseIo): LeaseIo {
  let entered = false;
  return {
    ...io,
    lstat: async (path) => {
      try { return await io.lstat(path); }
      catch (error) {
        if (path !== socketPath || entered || codeOf(error) !== 'ENOENT') throw error;
        entered = true;
        kernelLock(socketPath);
        await mutation();
        throw error; // preserve the real native ENOENT, not a fabricated stat
      }
    },
  };
}

for (const [label, mode] of [['setgid removed', 0o710], ['group write added', 0o2730]] as const) {
  test(`A3: native prebind parent recheck rejects when ${label} after initial trust`, { timeout: 5000 }, async (t) => {
    // Given: valid native parent, independently held flock at the named barrier.
    const fixture = await groupParent(t);
    if (fixture === undefined) return;
    const native = observedNative();
    const before = await lstat(fixture.dir);
    assert.equal(before.mode & 0o7777, 0o2710);
    const io = initialSocketEnoentBarrier(fixture.socketPath, async () => {
      await chmod(fixture.dir, mode);
    }, native.io);
    // When
    await failure(acquire(fixture.socketPath, native.server, new AbortController().signal, io, 'group'),
      'ERR_BRIDGE_LEASE_DIRECTORY');
    // Then: no bind/probe/chmod reached; actual fd flock was released.
    assert.deepEqual(native.calls, { bind: 0, probe: 0, chmod: 0, openLock: 1, close: 0, nativeCloseSuccess: 0 });
    assert.equal((await lstat(fixture.dir)).mode & 0o7777, mode);
    kernelLock(fixture.socketPath, false);
  });
}

test('A3: prebind native parent GID supersedes initial GID when the real group changes', { timeout: 5000 }, async (t) => {
  // Given: two real supplementary groups, neither equal to EGID.
  const nextGid = groups[1];
  if (nextGid === undefined) {
    t.skip('two supplementary groups distinct from EGID required for native parent GID change');
    return;
  }
  const fixture = await groupParent(t);
  if (fixture === undefined) return;
  assert.notEqual(fixture.gid, nextGid);
  assert.equal((await lstat(fixture.dir)).gid, fixture.gid);
  const native = observedNative();
  const umask = process.umask();
  const io = initialSocketEnoentBarrier(fixture.socketPath, async () => {
    await chown(fixture.dir, euid, nextGid);
    await chmod(fixture.dir, 0o2710); // chown may clear setgid; retain the valid predicate
  }, native.io);
  // When
  const lease = await acquire(fixture.socketPath, native.server, new AbortController().signal, io, 'group');
  t.after(() => dispose(lease));
  // Then: genuine bind inherits the fresh GID, not the initial snapshot or EGID.
  const bound = await lstat(fixture.socketPath);
  assert.equal(bound.gid, nextGid);
  assert.notEqual(bound.gid, fixture.gid);
  assert.notEqual(bound.gid, egid);
  assert.equal(bound.mode & 0o777, 0o660);
  assert.equal(process.umask(), umask);
  assert.equal((await requestOverSocket(fixture.socketPath)).status, 200);
});

const finalDrifts = [
  { label: 'type', change: (stat: PathStat): PathStat => ({ ...stat, isSocket: () => false }) },
  { label: 'dev', change: (stat: PathStat): PathStat => ({ ...stat, dev: stat.dev + 1 }) },
  { label: 'ino', change: (stat: PathStat): PathStat => ({ ...stat, ino: stat.ino + 1 }) },
  { label: 'mode', change: (stat: PathStat): PathStat => ({ ...stat, mode: stat.mode ^ 0o020 }) },
] as const;

for (const access of ['strict', 'group'] as const) {
  for (const drift of finalDrifts) {
    test(`A4: ${access} rejects final ${drift.label}-only drift with native close proof`, { timeout: 5000 }, async (t) => {
      // Given: real bind/chmod plus an accepted native connection before rejection.
      const root = await tempDir();
      t.after(() => cleanup(root));
      const fixture = access === 'group' ? await groupParent(t) : { socketPath: join(root, 'bridge.sock') };
      if (fixture === undefined) return;
      const native = observedNative();
      let chmodComplete = false;
      let injected = false;
      const clientClosed = Promise.withResolvers<void>();
      const io: LeaseIo = {
        ...native.io,
        chmod: async (path, mode) => { await native.io.chmod(path, mode); chmodComplete = true; },
        // Named final-socket-stat barrier after real chmod; only this observation drifts.
        lstat: async (path) => {
          const stat = await defaultIo.lstat(path);
          if (path !== fixture.socketPath || !chmodComplete || injected) return stat;
          injected = true;
          assert.ok(stat.isSocket());
          assert.equal(stat.mode & 0o777, access === 'group' ? 0o660 : 0o600);
          kernelLock(fixture.socketPath);
          const client = connect(fixture.socketPath);
          t.after(() => client.destroy());
          client.once('close', () => clientClosed.resolve());
          await once(client, 'connect');
          await native.accepted;
          return drift.change({
            dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode,
            isSocket: () => stat.isSocket(), isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(),
          });
        },
      };
      // When
      await failure(acquire(fixture.socketPath, native.server, new AbortController().signal, io, access),
        'ERR_BRIDGE_LEASE_STATE');
      // Then: native close succeeded, both connection endpoints closed, flock is free.
      assert.equal(injected, true);
      assert.equal(native.calls.chmod, 1);
      assert.equal(native.calls.close, 1);
      assert.equal(native.calls.nativeCloseSuccess, 1);
      await native.inboundClosed;
      await clientClosed.promise;
      kernelLock(fixture.socketPath, false);
    });
  }
}

test('A3: native foreign-owner-only group parent fails before lock/probe/bind', { timeout: 5000 }, async (t) => {
  // Given: root can construct a genuinely foreign UID; never substitute own UID.
  if (euid !== 0) {
    t.skip(`EUID ${euid} is not root; cannot create native foreign-owner parent (foreign UID not tested)`);
    return;
  }
  const root = await tempDir();
  t.after(() => cleanup(root));
  const fixture = { dir: join(root, 'foreign'), socketPath: join(root, 'foreign', 'bridge.sock') };
  await mkdir(fixture.dir);
  // Root need not have supplementary groups; GID 24 is the existing group fixture.
  const gid = groups[0] ?? (egid === 24 ? 25 : 24);
  await chown(fixture.dir, 1, gid);
  await chmod(fixture.dir, 0o2710);
  const parent = await lstat(fixture.dir);
  assert.ok(parent.isDirectory());
  assert.notEqual(parent.uid, euid);
  assert.notEqual(parent.gid, egid);
  assert.equal(parent.mode & 0o7777, 0o2710);
  const native = observedNative();
  // When
  await failure(acquire(fixture.socketPath, native.server, new AbortController().signal, native.io, 'group'),
    'ERR_BRIDGE_LEASE_DIRECTORY');
  // Then: owner alone invalidates an otherwise valid native parent.
  assert.deepEqual(native.calls, { bind: 0, probe: 0, chmod: 0, openLock: 0, close: 0, nativeCloseSuccess: 0 });
});
