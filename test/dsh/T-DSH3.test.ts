import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as bridge from '../../src/dsh/index.js';
import { cleanup, poll, tempDir } from '../lifecycle/helpers.js';
import { authority, isolated } from './harness.js';

function errorCode(error: unknown): string | undefined {
  let current = error;
  while (current instanceof Error) {
    const code = (current as Error & { code?: string }).code;
    if (code) return code;
    current = current.cause;
  }
  return undefined;
}

async function assemble(host: string, port: number, socketPath: string): Promise<Context> {
  const ctx = new Context();
  ctx.provide('webServer', { host, port });
  ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/', trustedHosts: ['dsh.example.com'] });
  await ctx.plugin(bridge, { socketPath, authorities: ['dsh.example.com'] });
  return ctx;
}

test('T-DSH3a: non-loopback webServer host fails closed without creating a UDS', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('webServer', { host: '0.0.0.0', port: 18777 });
  ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/', trustedHosts: [] });

  await assert.rejects(
    async () => ctx.plugin(bridge, { socketPath, authorities: ['dsh.example.com'] }),
    (error: unknown) => errorCode(error) === 'ERR_BRIDGE_LOOPBACK_GUARD',
  );
  await assert.rejects(access(socketPath), /ENOENT/, 'no UDS created when the guard trips');
});

test('T-DSH3b: invalid bound port fails closed without creating a UDS', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('webServer', { host: '127.0.0.1', port: 0 });
  ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/', trustedHosts: [] });

  await assert.rejects(
    async () => ctx.plugin(bridge, { socketPath, authorities: ['dsh.example.com'] }),
    (error: unknown) => errorCode(error) === 'ERR_BRIDGE_LOOPBACK_GUARD',
  );
  await assert.rejects(access(socketPath), /ENOENT/);
});

test('T-DSH3c: loopback host with a valid bound port passes and binds the UDS', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const ctx = await assemble('127.0.0.1', 18777, socketPath);
  await poll(async () => access(socketPath).then(() => true, () => false));
  await ctx.fiber.dispose();
  await assert.rejects(access(socketPath), /ENOENT/, 'UDS removed after plugin dispose');
});

test('T-DSH3d: the real rc.2 connection trustedHosts satisfies the authority cross-check', async (t) => {
  // Given a real DSH 0.2.1-rc.2 tree whose Connection holds the authority list
  await using app = await isolated();
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When the bridge loads against that live service rather than a stub
  const fiber = await app.ctx.plugin(bridge, { socketPath, authorities: [authority] });
  await fiber.await();
  // Then the cross-check passes and readiness implies a real bound UDS
  await poll(async () => access(socketPath).then(() => true, () => false));
  await fiber.dispose();
  await assert.rejects(access(socketPath), /ENOENT/);
});

test('T-DSH3e: a real rc.2 connection without the authority fails closed before binding', async (t) => {
  // Given a real DSH tree whose Connection lists no deployment authorities
  await using app = await isolated([]);
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When / Then
  await assert.rejects(
    async () => app.ctx.plugin(bridge, { socketPath, authorities: [authority] }),
    (error: unknown) => errorCode(error) === 'ERR_BRIDGE_AUTHORITY_TRUST',
  );
  await assert.rejects(access(socketPath), /ENOENT/, 'no UDS created when the cross-check trips');
});
