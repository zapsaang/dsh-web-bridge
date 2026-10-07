import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, dispose, LeaseError } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, tempDir } from './helpers.js';

const euid = process.geteuid?.() ?? 0;

test('T-L7a: lock inode is stable across acquire/dispose cycles and never unlinked', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const lockPath = `${socketPath}.lock`;

  const first = await acquire(socketPath, responder(), new AbortController().signal);
  const lockBefore = await lstat(lockPath);
  await dispose(first);
  const lockAfterDispose = await lstat(lockPath);
  assert.equal(lockAfterDispose.ino, lockBefore.ino, 'dispose never unlinks the stable lock inode');

  const second = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => dispose(second));
  const lockReacquired = await lstat(lockPath);
  assert.equal(lockReacquired.ino, lockBefore.ino, 'same lock inode across cycles');
  assert.equal(lockReacquired.uid, euid, 'lock owned by euid');
  assert.equal(lockReacquired.mode & 0o777, 0o600, 'lock mode 0600');
  assert.ok(lockReacquired.isFile(), 'lock is a regular file');
});

test('T-L7b: acquire/dispose never touches the process umask', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const before = process.umask();
  const lease = await acquire(join(dir, 'bridge.sock'), responder(), new AbortController().signal);
  await dispose(lease);
  assert.equal(process.umask(), before);
});

test('T-L7c: pre-existing lock with wrong mode or owner fails closed', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  await writeFile(`${socketPath}.lock`, '', { mode: 0o644 });
  // The ambient umask masks creation modes, so set the lax mode explicitly:
  // this test needs a genuinely wrong-mode lock, not whatever the shell allows.
  await chmod(`${socketPath}.lock`, 0o644);

  await assert.rejects(
    acquire(socketPath, responder(), new AbortController().signal),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_LOCK',
  );
});

test('T-L7d: parent directory must be euid-owned without group/other access', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const lax = join(dir, 'lax');
  await mkdir(lax, { mode: 0o755 });
  // As above: the ambient umask masks creation modes, so force the group/other
  // access this test is about instead of relying on the shell's umask.
  await chmod(lax, 0o755);

  await assert.rejects(
    acquire(join(lax, 'bridge.sock'), responder(), new AbortController().signal),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_DIRECTORY',
  );
  await chmod(lax, 0o700);
  const lease = await acquire(join(lax, 'bridge.sock'), responder(), new AbortController().signal);
  t.after(() => dispose(lease));
  assert.equal((await requestOverSocket(join(lax, 'bridge.sock'))).status, 200);
});

test('T-L7e: failed contender never disturbs the active lease', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const owner = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => dispose(owner));
  const lockBefore = await lstat(`${socketPath}.lock`);

  await assert.rejects(acquire(socketPath, responder(), new AbortController().signal));
  const lockAfter = await lstat(`${socketPath}.lock`);
  assert.equal(lockAfter.ino, lockBefore.ino, 'active lock inode intact after contender failure');
  assert.equal((await requestOverSocket(socketPath)).status, 200, 'owner still serving');
});

test('T-L7f: path constraints reject relative, traversal, NUL, and oversized paths', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const rejected = [
    ['relative path', 'relative/bridge.sock'],
    ['traversal segment', `${dir}/../bridge.sock`],
    ['embedded NUL', `${dir}/bridge\0.sock`],
    ['over 107 bytes', join(dir, `${'a'.repeat(120)}.sock`)],
  ] as const;
  for (const [label, path] of rejected) {
    await assert.rejects(
      acquire(path, responder(), new AbortController().signal),
      (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_PATH',
      label,
    );
  }
});
