import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { makeApply, type BridgeLogger } from '../../src/dsh/apply.js';
import { defaultIo } from '../../src/lib/socket.js';
import { cleanup, tempDir } from '../lifecycle/helpers.js';

test('T-DSH-logging: top-level request, upgrade, checkContinue, and checkExpectation catch blocks log redacted errors without leaking tokens', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'test-log.sock');

  let serverInstance: Server | undefined;
  const logged: { message: string; meta?: unknown }[] = [];
  const testLogger: BridgeLogger = {
    error(message: string, meta?: unknown) {
      logged.push({ message, meta });
    },
  };

  const createRecordingServer = (): Server => {
    const server = createServer();
    serverInstance = server;
    return server;
  };

  const apply = makeApply({
    io: defaultIo,
    createServer: createRecordingServer,
    logger: testLogger,
  });

  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('webServer', { host: '127.0.0.1', port: 18777 });
  ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/?token=SECRET_TOKEN_LEAK', trustedHosts: ['dsh.example.com'] });

  await apply(ctx, {
    socketPath,
    authorities: ['dsh.example.com'],
    socketAccess: 'strict',
  });

  assert.ok(serverInstance, 'server instance must be created');
  const sensitiveSecret = 'SECRET_TOKEN_LEAK_987654';

  // 1. Test request error logging
  let reqDestroyed = false;
  let resDestroyed = false;
  const boomReq = {
    get method(): string {
      const err = new Error(`boom with ${sensitiveSecret}`);
      (err as any).code = 'ECONNRESET';
      throw err;
    },
    get socket() { return { destroy: () => {} }; },
    destroy: () => { reqDestroyed = true; },
  } as unknown as IncomingMessage;
  const fakeRes = {
    destroy: () => { resDestroyed = true; },
  } as unknown as ServerResponse;

  serverInstance.emit('request', boomReq, fakeRes);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(reqDestroyed, true, 'request must be destroyed on error');
  assert.equal(resDestroyed, true, 'response must be destroyed on error');
  assert.equal(logged.length, 1, 'must log exactly 1 error for request failure');
  assert.equal((logged[0]?.meta as any)?.event, 'request');
  assert.equal((logged[0]?.meta as any)?.error, '[Error: ECONNRESET]');
  assert.ok(!JSON.stringify(logged[0]).includes(sensitiveSecret), 'must not leak token in logs');

  // 2. Test upgrade error logging
  let socketDestroyed = false;
  const fakeSocket = {
    destroy: () => { socketDestroyed = true; },
  } as unknown as Duplex;
  const boomUpgradeReq = {
    get method(): string {
      throw new Error(`upgrade failed with ${sensitiveSecret}`);
    },
  } as unknown as IncomingMessage;

  serverInstance.emit('upgrade', boomUpgradeReq, fakeSocket, Buffer.from([]));

  assert.equal(socketDestroyed, true, 'socket must be destroyed on upgrade error');
  assert.equal(logged.length, 2, 'must log error for upgrade failure');
  assert.equal((logged[1]?.meta as any)?.event, 'upgrade');
  assert.equal((logged[1]?.meta as any)?.error, '[Error]');
  assert.ok(!JSON.stringify(logged[1]).includes(sensitiveSecret), 'must not leak token in upgrade logs');
});
