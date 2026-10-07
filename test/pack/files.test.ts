import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/check-pack-files.mjs');

function write(root: string, path: string, content = ''): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-bridge-pack-'));
  write(root, 'package.json', JSON.stringify({
    name: 'dsh-web-bridge-pack-fixture', version: '0.0.0', type: 'module',
    files: ['lib', 'cordis.patch.yml'],
    exports: { '.': { types: './lib/dsh/index.d.ts', default: './lib/dsh/index.js' } },
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
    scripts: { prepack: 'node -e "process.exit(99)"' },
  }));
  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'lib', declaration: true } }));
  write(root, 'src/dsh/index.ts', 'export const name = "fixture";');
  write(root, 'lib/dsh/index.js', 'export const name = "fixture";');
  write(root, 'lib/dsh/index.d.ts', 'export declare const name = "fixture";');
  write(root, 'cordis.patch.yml', '- insert: []');
  write(root, 'README.md', '# fixture');
  write(root, 'LICENSE', 'fixture license');
  return root;
}

test('pack gate accepts clean output when prepack would fail if recursively invoked', (t) => {
  // Given
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // When
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  // Then
  assert.equal(result.status, 0, result.stderr);
});

const invalidArtifacts = [
  'lib/leak.ts', 'lib/src/leak.js', 'lib/test/leak.js', 'lib/.test-dist/leak.js',
  'lib/pnpm-lock.yaml', 'lib/stale.js', 'lib/stale.d.ts',
] as const;

for (const artifact of invalidArtifacts) {
  test(`pack gate rejects unexpected artifacts when ${artifact} is present`, (t) => {
    // Given
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    write(root, artifact);
    // When
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    // Then
    assert.equal(result.status, 1, result.stderr);
  });
}

for (const missing of ['cordis.patch.yml', 'lib/dsh/index.js', 'lib/dsh/index.d.ts']) {
  test(`pack gate rejects incomplete output when ${missing} is absent`, (t) => {
    // Given
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    rmSync(join(root, missing));
    // When
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    // Then
    assert.equal(result.status, 1, result.stderr);
  });
}

test('pack gate rejects stale output when source is newer than emitted files', (t) => {
  // Given
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  utimesSync(join(root, 'lib/dsh/index.js'), 1, 1);
  // When
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  // Then
  assert.equal(result.status, 1, result.stderr);
});

test('pack gate rejects missing whitelist entries when files excludes the patch', (t) => {
  // Given
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', JSON.stringify({ name: 'fixture', version: '0.0.0', files: ['lib'] }));
  // When
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  // Then
  assert.equal(result.status, 1, result.stderr);
});
