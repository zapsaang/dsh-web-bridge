import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// §14.7 T-P4 (manifest half): the published manifest must carry the exact
// engines / exports / types / dsh.bundle.patch / pinned peer contract from
// §10.2-§10.3, and the exports map must resolve to real built artifacts whose
// module surface matches the Cordis plugin shape.

interface Manifest {
  name: string;
  version: string;
  type: string;
  exports: Record<string, { types: string; default: string }>;
  files: string[];
  dsh: { bundle: { patch: string[] } };
  engines: { node: string };
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
  packageManager: string;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;
}

test('T-P4: engines and module format pin the declared runtime', () => {
  // Given / When
  const json = manifest();
  // Then
  assert.equal(json.type, 'module');
  assert.equal(json.engines.node, '>=24.21.0 <25', 'Node 24 runtime declaration (§10.2)');
  assert.match(json.packageManager, /^pnpm@/);
});

test('T-P4: exports resolve to the built plugin entry and its declaration', async () => {
  // Given / When
  const json = manifest();
  // Then
  assert.deepEqual(Object.keys(json.exports), ['.']);
  const entry = json.exports['.'];
  assert.ok(entry, 'root export exists');
  assert.equal(entry.types, './lib/dsh/index.d.ts');
  assert.equal(entry.default, './lib/dsh/index.js');
  assert.ok(existsSync('lib/dsh/index.d.ts'), 'declaration artifact exists (build gate runs before test)');
  assert.ok(existsSync('lib/dsh/index.js'), 'runtime artifact exists');
  // §10.2 plugin surface; the URL anchor reaches the repo root from the compiled .test-dist/test/pack/ location.
  const plugin: unknown = await import(new URL('../../../lib/dsh/index.js', import.meta.url).href);
  assert.ok(typeof plugin === 'object' && plugin !== null);
  const surface = plugin as Record<string, unknown>;
  assert.equal(surface['name'], '@zapsaang/dsh-web-bridge');
  assert.deepEqual(surface['inject'], ['connection', 'webServer']);
  assert.equal(typeof surface['Config'], 'function');
  assert.equal(typeof surface['apply'], 'function');
});

test('T-P4: bundle metadata declares exactly the shipped patch file', () => {
  // Given / When
  const json = manifest();
  // Then
  assert.deepEqual(json.dsh.bundle.patch, ['./cordis.patch.yml'], 'bundlePatchPaths loads this list (profile.ts L54-75)');
  assert.ok(existsSync('cordis.patch.yml'), 'declared patch file exists');
  assert.deepEqual([...json.files].sort(), ['cordis.patch.yml', 'lib'], 'published files are lib + patch only');
});

const EXACT_PEER_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|rc)\.(?:0|[1-9]\d*))?$/;

test('T-P4: peer dependencies are an exact pinned trio synchronized with devDependencies and README', () => {
  // Given / When
  const json = manifest();
  const readme = readFileSync('README.md', 'utf8');
  // Then
  assert.deepEqual(
    Object.keys(json.peerDependencies).sort(),
    ['@deepseek-ai/cordis', '@deepseek-ai/dsh', '@deepseek-ai/schemastery'],
  );
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'] as const) {
    const version = json.peerDependencies[name];
    assert.ok(typeof version === 'string' && EXACT_PEER_VERSION.test(version),
      `peerDependencies[${name}] must be an exact version, got ${String(version)}`);
    assert.equal(json.devDependencies[name], version,
      `devDependencies[${name}] must stay synchronized with peerDependencies`);
    assert.ok(readme.includes(`| \`${name}\` | \`${version}\` |`),
      `README.md peer table must declare ${name} ${version}`);
  }
  assert.ok(!('dependencies' in json), 'runtime comes only from the host-provided peers');
});
