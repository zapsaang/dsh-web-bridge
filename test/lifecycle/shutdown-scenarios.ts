import assert from 'node:assert/strict';
import { chmod, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { acquire, defaultIo, dispose, type LeaseIo, type LeaseServer } from '../../src/lib/socket.js';
import { facade, failure, kernelLock, observedIo, quarantine } from './shutdown-fixture-support.js';

export async function runShutdownScenario(scenario: string, dir: string): Promise<void> {
  const path = `${dir}/bridge.sock`;
  switch (scenario) {
    case 'close-hang-not-listening':
    case 'quarantine-hang': {
      // Given: a real listener behind a facade whose flag falls before its callback.
      const fixture = facade(() => undefined);
      const { io, counts } = observedIo();
      const lease = await acquire(path, fixture.server, new AbortController().signal, io);
      // When
      const intent = performance.now();
      const error = await failure(dispose(lease), 'ERR_BRIDGE_DISPOSE_TIMEOUT');
      // Then: no shortcut, retry, residual cleanup, or fd release.
      assert.ok(performance.now() - intent >= 1900);
      assert.equal(await failure(dispose(lease), error.code), error);
      assert.equal(fixture.state.closeCalls, 1);
      assert.ok((await lstat(path)).isSocket());
      assert.deepEqual(counts, { unlink: 0, lockClose: 0 });
      await quarantine(path);
      return;
    }
    case 'close-callback-error':
    case 'close-not-running-error':
    case 'close-throw': {
      // Given: explicit close failure (including the tempting NOT_RUNNING shortcut).
      const cause = Object.assign(new Error('controlled native close failure'), {
        code: scenario === 'close-not-running-error' ? 'ERR_SERVER_NOT_RUNNING' : 'EIO',
      });
      const fixture = facade((callback) => {
        if (scenario === 'close-throw') throw cause;
        callback?.(cause);
      });
      const { io, counts } = observedIo();
      const lease = await acquire(path, fixture.server, new AbortController().signal, io);
      // When
      const error = await failure(dispose(lease), 'ERR_BRIDGE_LEASE_STATE');
      // Then
      assert.equal(error.cause, cause);
      assert.equal(await failure(dispose(lease), error.code), error);
      assert.equal(fixture.state.closeCalls, 1);
      assert.deepEqual(counts, { unlink: 0, lockClose: 0 });
      await quarantine(path);
      return;
    }
    case 'late-bind-past-deadline': {
      // Given: listen is entered, but the actual native bind is held.
      const entered = Promise.withResolvers<void>();
      const fixture = facade((callback) => fixture.inner.close(callback));
      let releaseBind: () => void = () => assert.fail('listen has not been entered');
      const server: LeaseServer = { ...fixture.server, listen: (socketPath) => {
        releaseBind = () => fixture.inner.listen(socketPath);
        entered.resolve();
      } };
      const { io, counts } = observedIo();
      const controller = new AbortController();
      const pending = acquire(path, server, controller.signal, io);
      await entered.promise;
      // When: only the real proof deadline is timed; late bind is released AFTER reporting.
      const intent = performance.now();
      controller.abort();
      await failure(pending, 'ERR_BRIDGE_DISPOSE_TIMEOUT');
      // Then
      assert.ok(performance.now() - intent >= 1900);
      assert.equal(fixture.state.closeCalls, 0, 'no premature close on uncertain bind');
      await quarantine(path);
      releaseBind();
      await fixture.closeEntered;
      await fixture.closed;
      assert.equal(fixture.state.closeCalls, 1, 'late bind triggers the original single close');
      assert.deepEqual(counts, { unlink: 0, lockClose: 0 });
      await quarantine(path);
      return;
    }
    case 'chmod-hang-cancel': {
      // Given: real listening has happened; chmod is at a named entered barrier.
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const inner = createServer();
      const closed = new Promise<void>((resolve) => inner.once('close', resolve));
      const { io: real, counts } = observedIo();
      const io: LeaseIo = { ...real, chmod: async (socketPath, mode) => {
        entered.resolve();
        await release.promise;
        await defaultIo.chmod(socketPath, mode).catch((error: unknown) => {
          assert.equal(typeof error === 'object' && error !== null && 'code' in error ? error.code : '', 'ENOENT');
        });
        completed.resolve();
      } };
      const controller = new AbortController();
      const pending = acquire(path, inner, controller.signal, io);
      await entered.promise;
      // When
      controller.abort();
      await failure(pending, 'ERR_BRIDGE_DISPOSE_TIMEOUT');
      // Then: settled close is not sufficient while a mutating promise remains pending.
      await closed;
      await quarantine(path);
      release.resolve();
      await completed.promise;
      assert.deepEqual(counts, { unlink: 0, lockClose: 0 });
      await quarantine(path);
      return;
    }
    case 'upgraded-ws-open': {
      // Given: real accepted upgraded socket, deliberately left open.
      const inner = createServer();
      const acceptedClosed = Promise.withResolvers<void>();
      inner.on('upgrade', (_request, socket) => {
        socket.once('close', () => acceptedClosed.resolve());
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      });
      const lease = await acquire(path, inner, new AbortController().signal);
      const client = connect({ path });
      client.on('error', (error) => { assert.fail(error.message); });
      await new Promise<void>((resolve) => {
        client.on('data', () => resolve());
        client.write('GET / HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      });
      let observedClose = false;
      void acceptedClosed.promise.then(() => { observedClose = true; });
      // When
      await dispose(lease);
      // Then: SERVER-side close observation, not remote-client scheduling.
      assert.equal(observedClose, true, 'upgraded accepted close observed before lease release');
      kernelLock(path, false);
      return;
    }
    case 'bind-failure-release': {
      // Given: a genuine native EACCES bind terminal error, after lock acquisition.
      assert.notEqual(process.geteuid?.(), 0, 'EACCES fixture requires non-root');
      const fixture = facade((callback) => fixture.inner.close(callback));
      const io: LeaseIo = { ...defaultIo, openLock: async (lockPath) => {
        const handle = await defaultIo.openLock(lockPath);
        await chmod(dir, 0o500);
        return handle;
      } };
      // When
      const error = await failure(acquire(path, fixture.server, new AbortController().signal, io), 'ERR_BRIDGE_LEASE_STATE');
      // Then: positive bind failure permits release WITHOUT a close call.
      assert.ok(error.cause instanceof Error && 'code' in error.cause);
      assert.equal(error.cause.code, 'EACCES');
      assert.equal(fixture.state.closeCalls, 0);
      kernelLock(path, false);
      await chmod(dir, 0o700);
      const next = await acquire(path, createServer(), new AbortController().signal);
      await dispose(next);
      return;
    }
  }
}
