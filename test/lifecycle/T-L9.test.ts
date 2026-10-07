import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, dispose } from '../../src/lib/socket.js';
import { cleanup, isFreshBind, requestOverSocket, responder, spawnFixture, tempDir } from './helpers.js';

test('T-L9: SIGKILLed holder releases the kernel lease; next instance recovers stale socket', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');

  const holder = spawnFixture('hold-lease.mjs', [dir]);
  t.after(() => holder.kill('SIGKILL'));
  const identity = await holder.waitReady();
  assert.equal((await requestOverSocket(socketPath)).body, 'held', 'holder serving before kill');
  const before = await lstat(socketPath);

  holder.kill('SIGKILL');
  assert.equal(await holder.exited(), null, 'holder terminated by signal');

  const lease = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => dispose(lease));

  const lock = await lstat(`${socketPath}.lock`);
  assert.equal(lock.ino, identity['lockIno'], 'stable lock inode survived the SIGKILLed holder');
  const rebound = await lstat(socketPath);
  // See T-L2: the recovered socket may reuse the inode number the SIGKILLed
  // holder left behind, so freshness is asserted through the creation time.
  assert.ok(isFreshBind(before, rebound), 'stale socket reclaimed under a fresh inode');
  assert.equal((await requestOverSocket(socketPath)).status, 200, 'recovered instance serving');
});
