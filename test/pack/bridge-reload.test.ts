import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import * as bridge from '../../src/dsh/index.js';
import { cleanup, tempDir } from '../lifecycle/helpers.js';
import { kernelLock } from '../lifecycle/shutdown-fixture-support.js';
import { authority, readinessUpstream, successControls, token } from './readiness-wire.js';

test('bridge reload: public UDS traffic and exclusive stable lease survive an ACTIVE raw-Fiber restart',
  { timeout: 10000 }, async (t) => {
    // Given: public Config/inject/apply has completed real startup, not a pending fixture apply.
    const dir = await tempDir();
    const socketPath = join(dir, 'bridge.sock');
    const lockPath = `${socketPath}.lock`;
    const ctx = new Context();
    const upstream = await readinessUpstream();
    t.after(async () => {
      try { await ctx.fiber.dispose(); }
      finally {
        try { await upstream.close(); }
        finally { await cleanup(dir); }
      }
    });
    ctx.provide('webServer', { host: '127.0.0.1', port: upstream.port });
    ctx.provide('webRuntime', { trustedHosts: [authority] });
    ctx.provide('connection', { authenticatedUrl: (base: string) => `${base}?token=${token}` });
    const raw = Promise.withResolvers<Fiber>();
    ctx.on('internal/plugin', (fiber) => {
      if (fiber.runtime?.callback === bridge.apply && fiber.uid !== null) raw.resolve(fiber);
    });
    const loading = ctx.plugin(bridge, { socketPath, authorities: [authority] });
    const activeFiber = await raw.promise;
    await loading;
    await activeFiber.await();
    assert.equal(activeFiber.state, 2, 'pinned Cordis ACTIVE state');
    const firstSocket = await lstat(socketPath);
    assert.ok(firstSocket.isSocket());
    assert.equal(firstSocket.mode & 0o777, 0o600);
    assert.equal(firstSocket.uid, process.geteuid?.() ?? 0);
    const firstLock = await lstat(lockPath);
    kernelLock(socketPath);
    await successControls(socketPath, upstream);

    // When: restart ONLY the typed raw Fiber AFTER its first completed ACTIVE startup.
    await activeFiber.restart();
    await activeFiber.await();

    // Then: the public default apply's new native listener serves a second activation.
    assert.equal(activeFiber.state, 2, 'pinned Cordis ACTIVE state');
    const secondSocket = await lstat(socketPath);
    assert.ok(secondSocket.isSocket());
    assert.equal(secondSocket.mode & 0o777, 0o600);
    assert.equal(secondSocket.uid, firstSocket.uid);
    const secondLock = await lstat(lockPath);
    assert.deepEqual([secondLock.dev, secondLock.ino], [firstLock.dev, firstLock.ino]);
    kernelLock(socketPath);
    await successControls(socketPath, upstream);
    // Socket inode reuse is legal; final disposal must remove the socket and release the stable lock.
    await activeFiber.dispose();
    await assert.rejects(lstat(socketPath),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
    const disposedLock = await lstat(lockPath);
    assert.deepEqual([disposedLock.dev, disposedLock.ino], [firstLock.dev, firstLock.ino]);
    kernelLock(socketPath, false);
  });
