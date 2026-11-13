import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const script = resolve('scripts/sync-dsh-baseline.mjs');

interface RegistryData {
  readonly distTags: Readonly<Record<string, string>>;
  readonly dshVersions: Readonly<Record<string, { readonly cordis: string; readonly schemastery: string }>>;
  readonly cordisVersions: readonly string[];
  readonly schemasteryVersions: readonly string[];
}

interface MockRegistry {
  readonly url: string;
  readonly requests: string[];
  readonly server: ReturnType<typeof createServer>;
}

const startRegistry = async (data: RegistryData): Promise<MockRegistry> => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(`${request.method ?? ''} ${url}`);
    const sendJson = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && url === '/-/package/%40deepseek-ai%2Fdsh/dist-tags') {
      sendJson(200, data.distTags);
      return;
    }
    if (request.method === 'GET' && url.startsWith('/%40deepseek-ai%2Fdsh/')) {
      const version = decodeURIComponent(url.slice('/%40deepseek-ai%2Fdsh/'.length));
      const entry = data.dshVersions[version];
      if (entry === undefined) {
        sendJson(404, { error: 'not found' });
        return;
      }
      sendJson(200, {
        name: '@deepseek-ai/dsh',
        version,
        dependencies: {
          '@deepseek-ai/cordis': entry.cordis,
          '@deepseek-ai/schemastery': entry.schemastery,
        },
      });
      return;
    }
    if (request.method === 'GET' && url === '/%40deepseek-ai%2Fcordis') {
      sendJson(200, {
        name: '@deepseek-ai/cordis',
        versions: Object.fromEntries(data.cordisVersions.map((v) => [v, { version: v }])),
      });
      return;
    }
    if (request.method === 'GET' && url === '/%40deepseek-ai%2Fschemastery') {
      sendJson(200, {
        name: '@deepseek-ai/schemastery',
        versions: Object.fromEntries(data.schemasteryVersions.map((v) => [v, { version: v }])),
      });
      return;
    }
    sendJson(404, { error: 'unhandled route' });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, requests, server };
};

const withRegistry = async (t: TestContext, data: RegistryData): Promise<MockRegistry> => {
  const registry = await startRegistry(data);
  t.after(() => {
    registry.server.closeAllConnections();
    registry.server.close();
  });
  return registry;
};

const defaultRegistryData = (): RegistryData => ({
  distTags: { latest: '0.2.2-rc.1', next: '0.2.2-rc.2', alpha: '0.2.2-alpha.3' },
  dshVersions: {
    '0.2.2-rc.1': { cordis: '~4.1.0', schemastery: '~3.19.0' },
    '0.2.2-rc.2': { cordis: '~4.1.0', schemastery: '~3.19.0' },
  },
  cordisVersions: ['4.0.5', '4.1.0'],
  schemasteryVersions: ['3.18.5', '3.19.0'],
});

interface FixtureOptions {
  readonly dsh?: string;
  readonly cordis?: string;
  readonly schemastery?: string;
  readonly readmeContent?: string;
  readonly failCommand?: string;
}

const createFixture = (t: TestContext, options: FixtureOptions = {}): {
  readonly root: string;
  readonly bin: string;
  readonly commandsFile: string;
} => {
  const root = mkdtempSync(join(tmpdir(), 'sync-dsh-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dsh = options.dsh ?? '0.2.2-rc.1';
  const cordis = options.cordis ?? '4.1.0';
  const schemastery = options.schemastery ?? '3.19.0';

  const manifest = {
    name: '@zapsaang/dsh-web-bridge',
    version: '0.1.0-rc.1',
    publishConfig: { registry: 'https://registry.npmjs.org/' },
    peerDependencies: {
      '@deepseek-ai/cordis': cordis,
      '@deepseek-ai/dsh': dsh,
      '@deepseek-ai/schemastery': schemastery,
    },
    devDependencies: {
      '@deepseek-ai/cordis': cordis,
      '@deepseek-ai/dsh': dsh,
      '@deepseek-ai/schemastery': schemastery,
    },
  };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const readme = options.readmeContent ?? [
    '# @zapsaang/dsh-web-bridge',
    '',
    '| Peer | Version |',
    '|---|---|',
    `| \`@deepseek-ai/dsh\` | \`${dsh}\` |`,
    `| \`@deepseek-ai/cordis\` | \`${cordis}\` |`,
    `| \`@deepseek-ai/schemastery\` | \`${schemastery}\` |`,
    '',
  ].join('\n');
  writeFileSync(join(root, 'README.md'), readme);
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# initial-lock\n");

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/check-examples.mjs'),
    "if (process.env.SYNC_FAIL_CMD === 'check-examples') process.exit(1);\nconsole.log('PASS: examples');\n");
  writeFileSync(join(root, 'scripts/check-pack-files.mjs'),
    "if (process.env.SYNC_FAIL_CMD === 'check-pack-files') process.exit(1);\nconsole.log('PASS: pack');\n");

  mkdirSync(join(root, '.test-dist/test/dsh'), { recursive: true });
  writeFileSync(join(root, '.test-dist/test/dsh/smoke.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('stub dsh test', () => { assert.notEqual(process.env.SYNC_FAIL_CMD, 'dsh-tests'); });",
    '',
  ].join('\n'));

  mkdirSync(join(root, '.test-dist/test/browser'), { recursive: true });
  writeFileSync(join(root, '.test-dist/test/browser/smoke.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('stub browser test', () => { assert.notEqual(process.env.SYNC_FAIL_CMD, 'browser-tests'); });",
    '',
  ].join('\n'));

  const dshDir = join(root, 'node_modules/@deepseek-ai/dsh');
  const appBootDir = join(root, 'node_modules/@deepseek-ai/dsh-app-boot');
  mkdirSync(dshDir, { recursive: true });
  mkdirSync(appBootDir, { recursive: true });
  writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dsh }));
  writeFileSync(join(appBootDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot',
    version: dsh,
    type: 'module',
    exports: { '.': './index.js' },
  }));
  writeFileSync(join(appBootDir, 'index.js'), [
    'export function evaluatePluginCompatibility(manifest, _exemptions, runtimeVersion) {',
    "  const req = manifest.peerDependencies?.['@deepseek-ai/dsh'];",
    '  if (req === runtimeVersion) return undefined;',
    "  return { name: manifest.name, version: manifest.version, runtimeVersion, requirements: { '@deepseek-ai/dsh': req }, exempted: false };",
    '}',
    '',
  ].join('\n'));

  const bin = join(root, '.fake-bin');
  mkdirSync(bin, { recursive: true });
  const commandsFile = join(root, '.fake-commands.log');
  writeFileSync(join(bin, 'corepack'), [
    '#!/usr/bin/env node',
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(commandsFile)}, args.join(' ') + '\\n');`,
    "const root = process.cwd();",
    "const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));",
    "const dshVer = pkg.devDependencies['@deepseek-ai/dsh'];",
    "if (args[0] === 'pnpm' && args[1] === 'install') {",
    "  if (args.includes('--no-frozen-lockfile')) {",
    "    writeFileSync(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\\n# updated-${'${dshVer}'}\\n`);",
    '  }',
    "  writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVer }));",
    '  process.exit(0);',
    '}',
    "if (args[0] === 'pnpm' && args[1] === 'run') {",
    '  const scriptName = args[2];',
    "  if (process.env.SYNC_FAIL_CMD === scriptName) process.exit(1);",
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n'), { mode: 0o755 });

  return { root, bin, commandsFile };
};

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<RunResult> =>
  new Promise((done, fail) => {
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

test('sync-dsh-baseline discovers newest tag across latest/next, resolves peers, updates files, and passes gates', async (t) => {
  const registry = await withRegistry(t, defaultRegistryData());
  const fixture = createFixture(t);
  const result = await run(['--root', fixture.root, '--registry', registry.url], {
    PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=upgrade\b/);
  assert.match(result.stdout, /target=0\.2\.2-rc\.2\b/);

  const updatedPkg = JSON.parse(readFileSync(join(fixture.root, 'package.json'), 'utf8')) as {
    peerDependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(updatedPkg.peerDependencies['@deepseek-ai/dsh'], '0.2.2-rc.2');
  assert.equal(updatedPkg.devDependencies['@deepseek-ai/dsh'], '0.2.2-rc.2');
  assert.equal(updatedPkg.peerDependencies['@deepseek-ai/cordis'], '4.1.0');
  assert.equal(updatedPkg.peerDependencies['@deepseek-ai/schemastery'], '3.19.0');

  const updatedReadme = readFileSync(join(fixture.root, 'README.md'), 'utf8');
  assert.ok(updatedReadme.includes('| `@deepseek-ai/dsh` | `0.2.2-rc.2` |'));
  assert.match(readFileSync(fixture.commandsFile, 'utf8'), /pnpm install --no-frozen-lockfile/);
});

test('sync-dsh-baseline skips idempotently when already at the target baseline', async (t) => {
  const registry = await withRegistry(t, defaultRegistryData());
  const fixture = createFixture(t, { dsh: '0.2.2-rc.2' });
  const result = await run(['--root', fixture.root, '--registry', registry.url], {
    PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=skip reason=already-at-baseline\b/);
  assert.throws(() => readFileSync(fixture.commandsFile, 'utf8'), /ENOENT/);
});

test('sync-dsh-baseline --dry-run reports upgrade without mutating files or running install', async (t) => {
  const registry = await withRegistry(t, defaultRegistryData());
  const fixture = createFixture(t);
  const pkgBefore = readFileSync(join(fixture.root, 'package.json'), 'utf8');
  const readmeBefore = readFileSync(join(fixture.root, 'README.md'), 'utf8');
  const lockBefore = readFileSync(join(fixture.root, 'pnpm-lock.yaml'), 'utf8');

  const result = await run(['--dry-run', '--root', fixture.root, '--registry', registry.url], {
    PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=upgrade\b/);
  assert.match(result.stdout, /dry run/i);
  assert.equal(readFileSync(join(fixture.root, 'package.json'), 'utf8'), pkgBefore);
  assert.equal(readFileSync(join(fixture.root, 'README.md'), 'utf8'), readmeBefore);
  assert.equal(readFileSync(join(fixture.root, 'pnpm-lock.yaml'), 'utf8'), lockBefore);
});

test('sync-dsh-baseline honors explicit --tag and --version', async (t) => {
  const registry = await withRegistry(t, defaultRegistryData());
  const fixtureTag = createFixture(t);
  const byTag = await run(['--tag', 'latest', '--root', fixtureTag.root, '--registry', registry.url], {
    PATH: `${fixtureTag.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(byTag.status, 0, byTag.stderr);
  assert.match(byTag.stdout, /action=skip reason=already-at-baseline\b/);

  const fixtureVersion = createFixture(t);
  const byVersion = await run(['--version', '0.2.2-rc.2', '--root', fixtureVersion.root, '--registry', registry.url], {
    PATH: `${fixtureVersion.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(byVersion.status, 0, byVersion.stderr);
  assert.match(byVersion.stdout, /action=upgrade\b/);
  assert.match(byVersion.stdout, /target=0\.2\.2-rc\.2\b/);
});

test('sync-dsh-baseline guards against downgrades on default discovery and explicit --version', async (t) => {
  const registry = await withRegistry(t, {
    distTags: { latest: '0.2.2-rc.1', next: '0.2.2-rc.1' },
    dshVersions: {
      '0.2.2-rc.1': { cordis: '~4.1.0', schemastery: '~3.19.0' },
    },
    cordisVersions: ['4.1.0'],
    schemasteryVersions: ['3.19.0'],
  });

  const fixtureAuto = createFixture(t, { dsh: '0.2.2-rc.2' });
  const autoResult = await run(['--root', fixtureAuto.root, '--registry', registry.url], {
    PATH: `${fixtureAuto.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(autoResult.status, 0, autoResult.stderr);
  assert.match(autoResult.stdout, /action=skip reason=not-newer\b/);

  const fixtureExplicit = createFixture(t, { dsh: '0.2.2-rc.2' });
  const pkgBefore = readFileSync(join(fixtureExplicit.root, 'package.json'), 'utf8');
  const explicitResult = await run(['--version', '0.2.2-rc.1', '--root', fixtureExplicit.root, '--registry', registry.url], {
    PATH: `${fixtureExplicit.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(explicitResult.status, 1);
  assert.match(explicitResult.stderr, /downgrade|older/i);
  assert.equal(readFileSync(join(fixtureExplicit.root, 'package.json'), 'utf8'), pkgBefore);
});

test('sync-dsh-baseline atomically rolls back files and lockfile when a verification gate fails', async (t) => {
  const registry = await withRegistry(t, defaultRegistryData());
  const fixture = createFixture(t);
  const pkgBefore = readFileSync(join(fixture.root, 'package.json'), 'utf8');
  const readmeBefore = readFileSync(join(fixture.root, 'README.md'), 'utf8');
  const lockBefore = readFileSync(join(fixture.root, 'pnpm-lock.yaml'), 'utf8');

  const result = await run(['--root', fixture.root, '--registry', registry.url], {
    PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
    SYNC_FAIL_CMD: 'dsh-tests',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /action=rollback\b/);
  assert.equal(readFileSync(join(fixture.root, 'package.json'), 'utf8'), pkgBefore);
  assert.equal(readFileSync(join(fixture.root, 'README.md'), 'utf8'), readmeBefore);
  assert.equal(readFileSync(join(fixture.root, 'pnpm-lock.yaml'), 'utf8'), lockBefore);
  assert.match(readFileSync(fixture.commandsFile, 'utf8'), /pnpm install --frozen-lockfile/);
});

test('sync-dsh-baseline fails without modifying files when a peer dependency range cannot be resolved', async (t) => {
  const registry = await withRegistry(t, {
    distTags: { latest: '0.2.2-rc.1', next: '0.2.2-rc.2' },
    dshVersions: {
      '0.2.2-rc.2': { cordis: '~9.9.0', schemastery: '~3.19.0' },
    },
    cordisVersions: ['4.1.0'],
    schemasteryVersions: ['3.19.0'],
  });
  const fixture = createFixture(t);
  const pkgBefore = readFileSync(join(fixture.root, 'package.json'), 'utf8');
  const result = await run(['--root', fixture.root, '--registry', registry.url], {
    PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@deepseek-ai\/cordis/);
  assert.equal(readFileSync(join(fixture.root, 'package.json'), 'utf8'), pkgBefore);
});

test('sync-dsh-baseline restores package.json and fails when README peer table rows are missing', async (t) => {
  const registry = await withRegistry(t, defaultRegistryData());
  const fixture = createFixture(t, { readmeContent: '# Missing peer table\n' });
  const pkgBefore = readFileSync(join(fixture.root, 'package.json'), 'utf8');
  const result = await run(['--root', fixture.root, '--registry', registry.url], {
    PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md/);
  assert.equal(readFileSync(join(fixture.root, 'package.json'), 'utf8'), pkgBefore);
});
