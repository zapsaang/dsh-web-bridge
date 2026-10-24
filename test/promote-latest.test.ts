import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const script = resolve('scripts/promote-latest.mjs');
const packageName = '@zapsaang/dsh-web-bridge';

type Tags = Readonly<Record<string, string>>;

interface Registry {
  readonly url: string;
  readonly requests: string[];
  readonly server: ReturnType<typeof createServer>;
}

interface RegistryOptions {
  readonly publishedVersion?: string;
  readonly promoteMarker?: string;
}

const startRegistry = async (
  tags: Tags | null,
  status = 200,
  options: RegistryOptions = {},
): Promise<Registry> => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    const url = request.url ?? '';
    if (request.method === 'GET' && url.endsWith('/dist-tags')) {
      if (status !== 200) {
        response.writeHead(status);
        response.end('unavailable');
        return;
      }
      // The fake npm touches the marker: only then does the registry report the move.
      const promoted = options.promoteMarker !== undefined && existsSync(options.promoteMarker);
      const body = promoted
        ? { ...(tags ?? {}), latest: options.publishedVersion }
        : (tags ?? {});
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(body));
      return;
    }
    if (request.method === 'GET' && options.publishedVersion !== undefined
      && url.endsWith(`/${options.publishedVersion}`)) {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end('{}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, requests, server };
};

const withRegistry = async (
  t: TestContext,
  tags: Tags | null,
  status = 200,
  options: RegistryOptions = {},
): Promise<Registry> => {
  const registry = await startRegistry(tags, status, options);
  t.after(() => {
    registry.server.closeAllConnections();
    registry.server.close();
  });
  return registry;
};

const writeFakeNpm = (
  t: TestContext,
  version: string,
  options: { readonly argsFile: string; readonly marker?: string },
): string => {
  const directory = mkdtempSync(join(tmpdir(), 'promote-latest-bin-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'npm');
  const lines = [
    '#!/bin/sh',
    `echo "$*" >> "${options.argsFile}"`,
    'if [ "$1" = "--version" ]; then',
    `  echo "${version}"`,
    '  exit 0',
    'fi',
    ...(options.marker === undefined ? [] : [`: > "${options.marker}"`]),
    'exit 0',
    '',
  ];
  writeFileSync(path, lines.join('\n'), { mode: 0o755 });
  return directory;
};

const writeManifest = (t: TestContext, version: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'promote-latest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'package.json');
  writeFileSync(path, JSON.stringify({
    name: packageName,
    version,
    publishConfig: { registry: 'https://registry.npmjs.org/' },
  }));
  return path;
};

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}) =>
  new Promise<RunResult>((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });

const dryRun = (manifest: string, registry: Registry, expectedVersion: string) =>
  run(['--dry-run', '--registry', registry.url, manifest], { EXPECTED_VERSION: expectedVersion });

test('promote-latest moves latest for a newer alpha', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.5', alpha: '0.1.0-alpha.5' });
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.6');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=move\b/);
});

test('promote-latest moves latest for a newer rc', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-rc.2', rc: '0.1.0-rc.2' });
  const manifest = writeManifest(t, '0.1.0-rc.3');
  const result = await dryRun(manifest, registry, '0.1.0-rc.3');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=move\b/);
});

test('promote-latest moves latest for a newer stable version', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0' });
  const manifest = writeManifest(t, '0.1.1');
  const result = await dryRun(manifest, registry, '0.1.1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=move\b/);
});

test('promote-latest compares prerelease numbers numerically', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.9' });
  const manifest = writeManifest(t, '0.1.0-alpha.10');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.10');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=move\b/);
});

test('promote-latest skips when the released version already is latest', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.6' });
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.6');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=skip reason=already-latest\b/);
});

test('promote-latest never moves latest backwards inside a channel', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.6' });
  const manifest = writeManifest(t, '0.1.0-alpha.5');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.5');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=skip reason=not-newer\b/);
});

const mismatches = [
  { name: 'alpha latest, new rc', latest: '0.1.0-alpha.5', version: '0.1.0-rc.1' },
  { name: 'alpha latest, new stable', latest: '0.1.0-alpha.5', version: '0.1.0' },
  { name: 'rc latest, new alpha', latest: '0.1.0-rc.2', version: '0.1.0-alpha.6' },
  { name: 'rc latest, new stable', latest: '0.1.0-rc.2', version: '0.1.0' },
  { name: 'stable latest, new alpha', latest: '0.1.0', version: '0.1.1-alpha.1' },
] as const;

for (const fixture of mismatches) {
  test(`promote-latest skips across channels: ${fixture.name}`, async (t) => {
    const registry = await withRegistry(t, { latest: fixture.latest });
    const manifest = writeManifest(t, fixture.version);
    const result = await dryRun(manifest, registry, fixture.version);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /action=skip reason=channel-mismatch\b/);
  });
}

test('promote-latest skips when latest does not exist', async (t) => {
  const registry = await withRegistry(t, { alpha: '0.1.0-alpha.6' });
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.6');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=skip reason=no-latest\b/);
});

test('promote-latest skips when latest is not a releasable channel', async (t) => {
  const registry = await withRegistry(t, { latest: '0.0.0-stage' });
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.6');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=skip reason=unknown-current-channel\b/);
});

test('promote-latest rejects a prerelease channel it does not support', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-beta.1' });
  const manifest = writeManifest(t, '0.1.0-beta.2');
  const result = await dryRun(manifest, registry, '0.1.0-beta.2');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXPECTED_VERSION|version/i);
});

test('promote-latest rejects a manifest that does not match the trigger', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.5' });
  const manifest = writeManifest(t, '0.1.0-alpha.5');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.6');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifest version/i);
});

test('promote-latest rejects a missing expected version', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.5' });
  const manifest = writeManifest(t, '0.1.0-alpha.5');
  const result = await dryRun(manifest, registry, '');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXPECTED_VERSION/);
});

test('promote-latest fails closed when the registry is unavailable', async (t) => {
  const registry = await withRegistry(t, null, 503);
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.6');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /503/);
});

test('promote-latest moves latest through npm and re-reads the registry', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'promote-latest-state-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const argsFile = join(state, 'npm-args.txt');
  const marker = join(state, 'promoted');
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.5', alpha: '0.1.0-alpha.5' }, 200,
    { publishedVersion: '0.1.0-alpha.6', promoteMarker: marker });
  const bin = writeFakeNpm(t, '11.21.1', { argsFile, marker });
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await run(['--registry', registry.url, manifest], {
    EXPECTED_VERSION: '0.1.0-alpha.6',
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /moved latest to 0\.1\.0-alpha\.6/);
  assert.match(readFileSync(argsFile, 'utf8'),
    /dist-tag add @zapsaang\/dsh-web-bridge@0\.1\.0-alpha\.6 latest --registry http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(registry.requests.some((request) => request.endsWith('/0.1.0-alpha.6')));
});

test('promote-latest refuses to move latest with an npm that lacks OIDC dist-tags', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'promote-latest-state-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const argsFile = join(state, 'npm-args.txt');
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.5' });
  const bin = writeFakeNpm(t, '11.19.0', { argsFile });
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await run(['--registry', registry.url, manifest], {
    EXPECTED_VERSION: '0.1.0-alpha.6',
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /11\.19\.0 cannot manage dist-tags/);
  assert.doesNotMatch(readFileSync(argsFile, 'utf8'), /dist-tag add/);
});

test('promote-latest dry runs never mutate the registry', async (t) => {
  const registry = await withRegistry(t, { latest: '0.1.0-alpha.5' });
  const manifest = writeManifest(t, '0.1.0-alpha.6');
  const result = await dryRun(manifest, registry, '0.1.0-alpha.6');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(registry.requests.length > 0);
  assert.ok(registry.requests.every((request) => request.startsWith('GET ')), registry.requests.join('\n'));
});
