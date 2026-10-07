import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, LeaseError } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, tempDir } from './helpers.js';

test('T-L1: second instance fails on lease conflict without socket mutation', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');

  const first = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => first.dispose());
  const before = await lstat(socketPath);

  await assert.rejects(
    acquire(socketPath, responder(), new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof LeaseError, 'conflict is a LeaseError');
      assert.equal(error.code, 'ERR_BRIDGE_LEASE_CONFLICT');
      return true;
    },
  );

  const after = await lstat(socketPath);
  assert.equal(after.dev, before.dev, 'socket device untouched by contender');
  assert.equal(after.ino, before.ino, 'socket inode untouched by contender');
  const response = await requestOverSocket(socketPath);
  assert.equal(response.status, 200, 'lease owner still serving after contender failure');
  assert.equal(response.body, 'ok');
});
