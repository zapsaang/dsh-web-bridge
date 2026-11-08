import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as bridge from '../../src/dsh/index.js';
import { cleanup, poll, tempDir } from '../lifecycle/helpers.js';
import { authority, isolated, send } from './harness.js';

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

test('T-DSH3c-ipv6: IPv6 loopback host ::1 and localhost pass loopback guard and bind the UDS', async (t) => {
  for (const host of ['::1', '[::1]', 'localhost']) {
    const dir = await tempDir();
    t.after(() => cleanup(dir));
    const socketPath = join(dir, 'bridge.sock');
    const ctx = await assemble(host, 18778, socketPath);
    await poll(async () => access(socketPath).then(() => true, () => false));
    await ctx.fiber.dispose();
    await assert.rejects(access(socketPath), /ENOENT/);
  }
});

test('T-DSH3a-ipv6: non-loopback IPv6 host fails closed without creating a UDS', async (t) => {
  for (const host of ['::', '2001:db8::1']) {
    const dir = await tempDir();
    t.after(() => cleanup(dir));
    const socketPath = join(dir, 'bridge.sock');
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    ctx.provide('webServer', { host, port: 18779 });
    ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/', trustedHosts: [] });

    await assert.rejects(
      async () => ctx.plugin(bridge, { socketPath, authorities: ['dsh.example.com'] }),
      (error: unknown) => errorCode(error) === 'ERR_BRIDGE_LOOPBACK_GUARD',
    );
    await assert.rejects(access(socketPath), /ENOENT/);
  }
});

test('T-DSH3d: the real rc connection trustedHosts satisfies the authority cross-check', async (t) => {
  // Given a real pinned DSH tree whose Connection holds the authority list
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

test('T-DSH3e: a real rc connection without the authority fails closed before binding', async (t) => {
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

test('T-DSH3f: a port-bearing authority and trusted entry pass the cross-check and the native fence', async (t) => {
  // Given a real pinned DSH tree whose Connection trusts the exact port
  await using app = await isolated([`${authority}:8443`]);
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  app.ctx.connection.fetch.register({
    path: '/api/native-probe', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => new Response('native-admitted'),
  });
  // When the bridge loads with the same port-bearing authority
  const fiber = await app.ctx.plugin(bridge, { socketPath, authorities: [`${authority}:8443`] });
  await fiber.await();
  await poll(async () => access(socketPath).then(() => true, () => false));
  // Then the native fence admits the port-bearing Host (401 only because no cookie is sent)
  const response = await send(app.port, { path: '/api/native-probe', headers: { host: `${authority}:8443` } });
  assert.equal(response.status, 401);
  await fiber.dispose();
});

test('T-DSH3g: a loopback authority needs no trustedHosts entry and the native fence admits its Host', async (t) => {
  // Given a real pinned DSH tree with an empty deployment authority list
  await using app = await isolated([]);
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  app.ctx.connection.fetch.register({
    path: '/api/native-probe', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => new Response('native-admitted'),
  });
  // When the bridge is configured for a loopback authority (D5: no trust entry needed)
  const fiber = await app.ctx.plugin(bridge, { socketPath, authorities: ['localhost:8080'] });
  await fiber.await();
  await poll(async () => access(socketPath).then(() => true, () => false));
  // Then DSH's own loopback fence admits the Host without a trustedHosts entry
  const response = await send(app.port, { path: '/api/native-probe', headers: { host: 'localhost:8080' } });
  assert.equal(response.status, 401);
  await fiber.dispose();
});

test('T-DSH3h: a port-specific real trusted entry cannot cover a port-less authority', async (t) => {
  // Given a real pinned DSH tree that trusts only the explicit port
  await using app = await isolated([`${authority}:8443`]);
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When / Then a port-less authority still fails closed before binding
  await assert.rejects(
    async () => app.ctx.plugin(bridge, { socketPath, authorities: [authority] }),
    (error: unknown) => errorCode(error) === 'ERR_BRIDGE_AUTHORITY_TRUST',
  );
  await assert.rejects(access(socketPath), /ENOENT/);
});
