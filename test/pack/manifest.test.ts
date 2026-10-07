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
  assert.deepEqual(surface['inject'], ['connection', 'webServer', 'webRuntime']);
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

test('T-P4: peer dependencies are exactly the pinned alpha trio with no runtime deps', () => {
  // Given / When
  const json = manifest();
  // Then
  assert.deepEqual(json.peerDependencies, {
    '@deepseek-ai/cordis': '4.0.5-alpha.1',
    '@deepseek-ai/dsh': '0.2.1-alpha.1',
    '@deepseek-ai/schemastery': '3.18.5-alpha.1',
  });
  assert.ok(!('dependencies' in json), 'runtime comes only from the host-provided peers');
});
