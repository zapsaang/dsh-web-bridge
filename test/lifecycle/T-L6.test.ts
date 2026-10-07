import assert from 'node:assert/strict';
import { access, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, dispose } from '../../src/lib/socket.js';
import { cleanup, responder, tempDir } from './helpers.js';
import { enoent, fakeStat, stubIo } from './stub-io.js';

function scriptedIo(lstatSequence: Array<'enoent' | { dev: number; ino: number }>): ReturnType<typeof stubIo> {
  let cursor = 0;
  return stubIo({
    helperAuto: 'success',
    lstat: async () => {
      const entry = lstatSequence[Math.min(cursor++, lstatSequence.length - 1)]!;
      if (entry === 'enoent') throw enoent();
      return fakeStat({ kind: 'socket', dev: entry.dev, ino: entry.ino });
    },
  });
}

test('T-L6a: real dispose removes the bound socket inode (Node 24 auto-unlink parity)', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const lease = await acquire(socketPath, responder(), new AbortController().signal);
  const bound = await lstat(socketPath);
  await dispose(lease);
  await assert.rejects(access(socketPath), /ENOENT/, `inode ${bound.ino} removed`);
});

test('T-L6b: residual cleanup unlinks only the recorded dev/ino', async (t) => {
  for (const [label, residual, expectUnlink] of [
    ['matching residual is collected', { dev: 9, ino: 42 }, 1],
    ['replaced inode is preserved', { dev: 9, ino: 43 }, 0],
  ] as const) {
    const dir = await tempDir();
    const io = scriptedIo(['enoent', { dev: 9, ino: 42 }, { dev: 9, ino: 42 }, residual]);
    const lease = await acquire(join(dir, 'bridge.sock'), responder(), new AbortController().signal, io);
    await dispose(lease);
    assert.equal(io.calls.unlink, expectUnlink, label);
    await cleanup(dir);
  }
});

test('T-L6c: ENOENT residual check performs no unlink', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const io = scriptedIo(['enoent', { dev: 9, ino: 42 }, { dev: 9, ino: 42 }, 'enoent']);
  const lease = await acquire(join(dir, 'bridge.sock'), responder(), new AbortController().signal, io);
  await dispose(lease);
  assert.equal(io.calls.unlink, 0, 'no residual means no unlink attempt');
});
