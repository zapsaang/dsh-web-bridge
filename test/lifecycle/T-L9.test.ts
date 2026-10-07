import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, dispose } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, spawnFixture, tempDir } from './helpers.js';

test('T-L9: SIGKILLed holder releases the kernel lease; next instance recovers stale socket', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');

  const holder = spawnFixture('hold-lease.mjs', [dir]);
  t.after(() => holder.kill('SIGKILL'));
  const identity = await holder.waitReady();
  assert.equal((await requestOverSocket(socketPath)).body, 'held', 'holder serving before kill');

  holder.kill('SIGKILL');
  assert.equal(await holder.exited(), null, 'holder terminated by signal');

  const lease = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => dispose(lease));

  const lock = await lstat(`${socketPath}.lock`);
  assert.equal(lock.ino, identity['lockIno'], 'stable lock inode survived the SIGKILLed holder');
  const rebound = await lstat(socketPath);
  assert.notEqual(rebound.ino, identity['socketIno'], 'stale socket reclaimed under a fresh inode');
  assert.equal((await requestOverSocket(socketPath)).status, 200, 'recovered instance serving');
});
