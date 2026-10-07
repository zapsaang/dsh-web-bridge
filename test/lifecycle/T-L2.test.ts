import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire } from '../../src/lib/socket.js';
import { cleanup, connectRaw, isFreshBind, requestOverSocket, responder, spawnFixture, tempDir } from './helpers.js';

test('T-L2: stale socket (ECONNREFUSED + type/owner/dev/ino recheck) is reclaimed', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');

  const stale = spawnFixture('bind-stale.mjs', [dir]);
  assert.equal(await stale.exited(), 0, 'stale fixture bound and exited without close');
  const orphaned = await lstat(socketPath);
  assert.ok(orphaned.isSocket(), 'orphaned socket inode remains after ungraceful exit');
  await assert.rejects(connectRaw(socketPath), (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED');

  const lease = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => lease.dispose());
  const rebound = await lstat(socketPath);
  assert.ok(isFreshBind(orphaned, rebound), 'stale inode replaced by a fresh bind');
  assert.equal(rebound.uid, process.geteuid?.(), 'socket owned by euid');
  assert.equal(rebound.mode & 0o777, 0o600, 'socket mode pinned to 0600');
  const response = await requestOverSocket(socketPath);
  assert.equal(response.status, 200);
});

test('T-L2b: an unreplaced socket file is not a fresh bind', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');

  const stale = spawnFixture('bind-stale.mjs', [dir]);
  assert.equal(await stale.exited(), 0, 'stale fixture bound and exited without close');
  // Given: the orphaned file is observed twice with no rebind in between,
  // Then: the signal T-L2 relies on must stay false, so a weakened comparison
  // (inode inequality, or >= instead of >) cannot pass T-L2 by accident.
  const before = await lstat(socketPath);
  const after = await lstat(socketPath);
  assert.equal(isFreshBind(before, after), false, 'an unchanged socket file is not a fresh bind');
});
