import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { chmod, chown, mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as bridge from '../../src/dsh/index.js';
import { cleanup, requestOverSocket, tempDir } from '../lifecycle/helpers.js';

// §14.7 T-P3: the bridge becomes ready only after its own listener and mode
// checks complete — a resolved plugin promise must imply a bound 0600 socket
// owned by this bridge (HTTP verdicts answer), and absence of a protected WS
// route never blocks readiness (handshake denials are plain 400/403, not 101).

async function assemble(socketPath: string, authority: string): Promise<Context> {
  const ctx = new Context();
  ctx.provide('webServer', { host: '127.0.0.1', port: 18777 });
  ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/' });
  ctx.provide('webRuntime', { trustedHosts: [authority] });
  const fiber = await ctx.plugin(bridge, { socketPath, authorities: [authority] });
  await fiber.await();
  return ctx;
}

function upgradeOverSocket(socketPath: string, host: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath }, () => {
      const lines = [`GET / HTTP/1.1`, `host: ${host}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => { raw += chunk; });
    socket.on('end', () => resolve(raw));
    socket.on('error', reject);
  });
}

test('T-P3: resolved plugin readiness implies a bound 0600 socket owned by the bridge', async (t) => {
  // Given
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When: readiness = the plugin promise resolving (process-alive is NOT the signal)
  const ctx = await assemble(socketPath, 'probe-p3.example.test');
  t.after(() => ctx.fiber.dispose());
  // Then: the listener already exists with the §9/§13.2 ownership and mode checks applied
  const stat = await lstat(socketPath);
  assert.ok(stat.isSocket(), 'listener exists once readiness resolves');
  assert.equal(stat.mode & 0o777, 0o600, 'socket mode 0600');
  // Then: the listener is owned by this bridge — its verdict answers over the UDS
  const probe = await requestOverSocket(socketPath, '/');
  assert.equal(probe.status, 403, 'bridge authority verdict answers on the UDS (default host is untrusted)');
});

test('T-P3: upgrade denials are plain HTTP errors and never block readiness', async (t) => {  // Given
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const ctx = await assemble(socketPath, 'probe-p3.example.test');
  t.after(() => ctx.fiber.dispose());
  // When: an upgrade from an untrusted authority
  const denied = await upgradeOverSocket(socketPath, 'untrusted.example.test', {
    connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
  });
  // Then
  assert.match(denied.split('\r\n', 1)[0] ?? '', /^HTTP\/1\.1 403 /, 'untrusted upgrade denied, no 101');
  // When: an upgrade with a malformed handshake from the trusted authority
  const malformed = await upgradeOverSocket(socketPath, 'probe-p3.example.test', {
    connection: 'Upgrade', upgrade: 'websocket',
  });
  // Then
  assert.match(malformed.split('\r\n', 1)[0] ?? '', /^HTTP\/1\.1 400 /, 'malformed handshake denied, no 101');
});

test('T-P3 group: resolved plugin readiness implies a 0660 socket carrying the parent GID', async (t) => {
  // Given: a real group-mode parent (setgid 02710, shared supplementary group != egid)
  const egid = process.getegid?.() ?? 0;
  const gid = process.getgroups?.().find((group) => group !== egid);
  if (gid === undefined) {
    t.skip('no supplementary group distinct from EGID; cannot chgrp the group-mode parent fixture');
    return;
  }
  const root = await tempDir();
  t.after(() => cleanup(root));
  const dir = join(root, 'shared');
  await mkdir(dir);
  await chown(dir, process.geteuid?.() ?? 0, gid);
  await chmod(dir, 0o2710);
  const socketPath = join(dir, 'bridge.sock');
  // When
  const ctx = new Context();
  ctx.provide('webServer', { host: '127.0.0.1', port: 18777 });
  ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/' });
  ctx.provide('webRuntime', { trustedHosts: ['probe-p3.example.test'] });
  const fiber = await ctx.plugin(bridge, { socketPath, authorities: ['probe-p3.example.test'], socketAccess: 'group' });
  await fiber.await();
  t.after(() => ctx.fiber.dispose());
  // Then
  const stat = await lstat(socketPath);
  assert.ok(stat.isSocket(), 'listener exists once readiness resolves');
  assert.equal(stat.mode & 0o777, 0o660, 'group socket mode 0660');
  assert.equal(stat.gid, gid, 'socket GID inherited from the setgid parent');
  assert.notEqual(stat.gid, egid, 'inherited GID is not the process EGID');
  const probe = await requestOverSocket(socketPath, '/');
  assert.equal(probe.status, 403, 'bridge authority verdict answers on the UDS (default host is untrusted)');
});
