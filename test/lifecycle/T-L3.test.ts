import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, defaultIo, dispose, LeaseError, type LeaseIo } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, tempDir } from './helpers.js';
import { enoent, fakeStat, stubIo } from './stub-io.js';

const euid = process.geteuid?.() ?? 0;

async function expectState(promise: Promise<unknown>): Promise<LeaseError> {
  const error = await promise.then(
    () => assert.fail('expected lease acquisition to fail'),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof LeaseError, 'failure is a LeaseError');
  return error;
}

test('T-L3a: pre-existing regular file fails closed without mutation', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  await writeFile(socketPath, 'not a socket');
  const before = await lstat(socketPath);

  const error = await expectState(acquire(socketPath, responder(), new AbortController().signal));
  assert.equal(error.code, 'ERR_BRIDGE_LEASE_STATE');
  const after = await lstat(socketPath);
  assert.ok(after.isFile() && after.ino === before.ino, 'foreign file left untouched');
});

test('T-L3b: symlink at socket path fails closed', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  await symlink(join(dir, 'missing-target'), socketPath);

  const error = await expectState(acquire(socketPath, responder(), new AbortController().signal));
  assert.equal(error.code, 'ERR_BRIDGE_LEASE_STATE');
});

test('T-L3c: socket owned by another uid fails before any probe', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const io = stubIo({
    lstat: async () => fakeStat({ kind: 'socket', uid: euid === 0 ? 1 : 0, mode: 0o600 }),
  });
  const error = await expectState(acquire(join(dir, 'bridge.sock'), responder(), new AbortController().signal, io));
  assert.equal(error.code, 'ERR_BRIDGE_LEASE_STATE');
  assert.equal(io.calls.probe, 0, 'foreign-owned socket is never probed');
  assert.equal(io.calls.unlink, 0, 'foreign-owned socket is never unlinked');
});

test('T-L3d: live listener at path fails closed and stays serving', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const owner = createServer((req, res) => res.end('held'));
  await new Promise<void>((resolve) => owner.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => owner.close(() => resolve(undefined))));

  const error = await expectState(acquire(socketPath, responder(), new AbortController().signal));
  assert.equal(error.code, 'ERR_BRIDGE_LEASE_STATE');
  const response = await requestOverSocket(socketPath);
  assert.equal(response.body, 'held', 'live listener was not disrupted');
});

test('T-L3e: probe errors other than ECONNREFUSED fail closed without erase', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const owner = createServer((req, res) => res.end('held'));
  await new Promise<void>((resolve) => owner.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => owner.close(() => resolve(undefined))));
  const before = await lstat(socketPath);

  for (const code of ['EACCES', 'ETIMEDOUT']) {
    const io = stubIo({
      lstat: async () => fakeStat({ kind: 'socket', dev: before.dev, ino: before.ino }),
      probe: async () => { throw Object.assign(new Error(code), { code }); },
    });
    const error = await expectState(acquire(socketPath, responder(), new AbortController().signal, io));
    assert.equal(error.code, 'ERR_BRIDGE_LEASE_STATE', `${code} fails closed`);
    assert.equal(io.calls.unlink, 0, `${code} never erases`);
  }
});

test('T-L3f: initial ENOENT binds directly with zero probes', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');

  let probeCalls = 0;
  const io: LeaseIo = {
    ...defaultIo,
    probe: async (path) => {
      probeCalls += 1;
      await defaultIo.probe(path);
    },
  };
  const lease = await acquire(socketPath, responder(), new AbortController().signal, io);
  t.after(() => dispose(lease));
  assert.equal(probeCalls, 0, 'missing path is bound directly, never probed');
  assert.equal((await requestOverSocket(socketPath)).status, 200);
});

test('T-L3g: probe observing ENOENT after initial lstat is a fail-closed race', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const io = stubIo({
    lstat: async () => fakeStat({ kind: 'socket', dev: 7, ino: 7 }),
    probe: async () => { throw enoent(); },
  });
  const error = await expectState(acquire(join(dir, 'bridge.sock'), responder(), new AbortController().signal, io));
  assert.equal(error.code, 'ERR_BRIDGE_LEASE_STATE');
  assert.equal(io.calls.unlink, 0, 'probe ENOENT never triggers erase or retry');
});

test('T-L3h: dev/ino drift between probe and erase fails closed', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  let lstatCalls = 0;
  const io = stubIo({
    lstat: async () => {
      lstatCalls += 1;
      return fakeStat({ kind: 'socket', dev: 7, ino: lstatCalls === 1 ? 7 : 8 });
    },
    probe: async () => { throw Object.assign(new Error('stale'), { code: 'ECONNREFUSED' }); },
  });
  const error = await expectState(acquire(join(dir, 'bridge.sock'), responder(), new AbortController().signal, io));
  assert.equal(error.code, 'ERR_BRIDGE_LEASE_STATE');
  assert.equal(io.calls.unlink, 0, 'replaced inode is never unlinked');
});

test('T-L3i: ECONNREFUSED with stable identity unlinks then binds', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const io = stubIo({
    lstat: async () => fakeStat({ kind: 'socket', dev: 7, ino: 7 }),
    probe: async () => { throw Object.assign(new Error('stale'), { code: 'ECONNREFUSED' }); },
  });
  const lease = await acquire(socketPath, responder(), new AbortController().signal, io);
  t.after(() => dispose(lease));
  assert.equal(io.calls.probe, 1, 'owned existing socket probed exactly once');
  assert.equal(io.calls.unlink, 1, 'stale owned socket erased after identity recheck');
  assert.equal((await requestOverSocket(socketPath)).status, 200);
});
