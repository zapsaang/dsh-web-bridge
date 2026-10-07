import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as bridge from '../../src/dsh/index.js';
import { cleanup, tempDir } from '../lifecycle/helpers.js';

// §14.7 T-P1: the pinned overlay must load and actually insert one row whose
// shape matches the plugin contract; the Config schema is exactly
// socketPath (concrete default) + required finite authorities; startup
// cross-checks authorities ⊆ ctx.webRuntime.trustedHosts public bare names.

interface YamlModule {
  load: (text: string) => unknown;
}
// js-yaml is a declared dependency of the pinned @deepseek-ai/dsh; resolve it
// from that installation instead of adding a parallel dependency.
const dshRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'));
const yaml = dshRequire('js-yaml') as YamlModule;

interface OverlayRow {
  id: string;
  name: string;
  inject: readonly string[];
  config: Record<string, unknown>;
}

function overlayRows(): { insert: OverlayRow[] }[] {
  const parsed: unknown = yaml.load(readFileSync('cordis.patch.yml', 'utf8'));
  assert.ok(Array.isArray(parsed), 'overlay is a patch list');
  return parsed as { insert: OverlayRow[] }[];
}

test('T-P1a: pinned overlay parses as a single append-mode insert of the bridge row', () => {
  // Given / When
  const patches = overlayRows();
  // Then
  assert.equal(patches.length, 1, 'exactly one patch entry');
  const patch = patches[0];
  assert.ok(patch && typeof patch === 'object', 'patch entry exists');
  assert.ok(!('id' in patch), 'insert without id appends the entry (include L79-101)');
  assert.ok(Array.isArray(patch.insert) && patch.insert.length === 1, 'one inserted row');
  const row = patch.insert[0];
  assert.ok(row && typeof row === 'object', 'inserted row exists');
  assert.deepEqual(Object.keys(row).sort(), ['config', 'id', 'inject', 'name'], 'row carries no extra keys');
  assert.equal(row.id, 'dsh-web-bridge');
  assert.equal(row.name, bridge.name, 'row name matches the exported plugin name');
  assert.deepEqual([...row.inject].sort(), [...bridge.inject].sort(), 'row inject matches the exported inject');
  assert.deepEqual(Object.keys(row.config).sort(), ['authorities', 'socketPath'], 'config is exactly the two schema keys');
  assert.equal(row.config['socketPath'], '/run/dsh-web/session-bridge.sock', 'concrete default socket path');
  const authorities = row.config['authorities'];
  assert.ok(Array.isArray(authorities) && authorities.length > 0, 'required finite authorities');
  // The whole overlay config must pass the shipped Config schema unchanged.
  const normalized = bridge.Config(row.config);
  assert.deepEqual(normalized, {
    socketPath: row.config['socketPath'],
    authorities: row.config['authorities'],
  });
  for (const authority of normalized.authorities) {
    assert.ok(!authority.includes(':'), `${authority} is a bare name without a port`);
    assert.equal(authority, authority.toLowerCase(), `${authority} is a bare canonical name`);
  }
});

function errorCode(error: unknown): string | undefined {
  let current = error;
  while (current instanceof Error) {
    const code = (current as Error & { code?: string }).code;
    if (code) return code;
    current = current.cause;
  }
  return undefined;
}

async function assemble(trustedHosts: unknown, socketPath: string, authorities = ['dsh.example.com']): Promise<Context> {
  const ctx = new Context();
  ctx.provide('webServer', { host: '127.0.0.1', port: 18777 });
  ctx.provide('connection', { authenticatedUrl: () => 'http://127.0.0.1/' });
  ctx.provide('webRuntime', { trustedHosts });
  const fiber = await ctx.plugin(bridge, { socketPath, authorities });
  await fiber.await();
  return ctx;
}

test('T-P1b: startup accepts authorities that are a subset of the web runtime trusted bare names', async (t) => {
  // Given
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When
  const ctx = await assemble(['dsh.example.com', 'dsh2.example.com'], socketPath, ['dsh.example.com']);
  t.after(() => ctx.fiber.dispose());
  // Then: subset (not equality) loads and binds; CLI extras stay native-only.
  await access(socketPath);
});

test('T-P1c: startup fails closed when an authority is absent from the trusted bare names', async (t) => {
  // Given
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When / Then
  await assert.rejects(
    async () => assemble(['other.example.com'], socketPath),
    (error: unknown) => errorCode(error) === 'ERR_BRIDGE_AUTHORITY_TRUST',
  );
  await assert.rejects(access(socketPath), /ENOENT/, 'no UDS created when the cross-check trips');
});

test('T-P1d: a port-bearing trusted entry does not satisfy the bare-name requirement', async (t) => {
  // Given
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When / Then
  await assert.rejects(
    async () => assemble(['dsh.example.com:8443'], socketPath),
    (error: unknown) => errorCode(error) === 'ERR_BRIDGE_AUTHORITY_TRUST',
  );
  await assert.rejects(access(socketPath), /ENOENT/);
});

test('T-P1e: startup fails closed when the web runtime exposes no trusted host list', async (t) => {
  // Given
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  // When / Then
  await assert.rejects(
    async () => assemble(undefined, socketPath),
    (error: unknown) => errorCode(error) === 'ERR_BRIDGE_AUTHORITY_TRUST',
  );
  await assert.rejects(access(socketPath), /ENOENT/);
});
