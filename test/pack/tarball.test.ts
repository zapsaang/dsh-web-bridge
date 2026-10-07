import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// §14.7 T-P4 (artifact half): the real `npm pack` tarball — not just the
// dry-run listing — must contain only publishable artifacts: built lib output
// and the overlay, never test sources, build scaffolding, lockfiles, or any
// secret-bearing file.

function walk(directory: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), `symlink in tarball: ${rel}`);
    if (stat.isDirectory()) files.push(...walk(path, rel));
    else files.push(rel);
  }
  return files;
}

const FORBIDDEN_PARTS = new Set(['src', 'test', '.test-dist', '.test-dist-soak', 'node_modules', 'scripts', 'docs', 'examples']);
const SECRET_NAME = /(?:^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key|p12|pfx)|id_[a-z0-9]+|credentials[^/]*\.ya?ml)$/i;

test('T-P4: packed tarball carries only built artifacts, the overlay, and metadata', (t) => {
  // Given
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-bridge-tarball-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // --ignore-scripts keeps this invocation from recursing into prepack.
  const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  assert.ok(tarball, 'tarball produced');
  // When
  const extract = join(dir, 'extract');
  mkdirSync(extract);
  const untar = spawnSync('tar', ['-xzf', join(dir, tarball), '-C', extract], { encoding: 'utf8' });
  assert.equal(untar.status, 0, untar.stderr);
  const files = walk(join(extract, 'package'));
  // Then
  assert.ok(files.length > 0, 'tarball is not empty');
  for (const rel of files) {
    assert.ok(!rel.split('/').some((part) => FORBIDDEN_PARTS.has(part)), `no source/test/scaffold path: ${rel}`);
    assert.ok(!/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/.test(rel), `no lockfile: ${rel}`);
    assert.ok(!rel.endsWith('.ts') || rel.endsWith('.d.ts'), `no TypeScript source: ${rel}`);
    assert.ok(!SECRET_NAME.test(rel), `no secret-bearing filename: ${rel}`);
    assert.ok(!readFileSync(join(extract, 'package', rel), 'utf8').includes('PRIVATE KEY'), `no key material: ${rel}`);
  }
  for (const required of ['package.json', 'README.md', 'cordis.patch.yml', 'lib/dsh/index.js', 'lib/dsh/index.d.ts']) {
    assert.ok(files.includes(required), `required entry present: ${required}`);
  }
  // Every src module has its built js + d.ts pair inside the tarball.
  const sources = walk('src').filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  assert.ok(sources.length > 0, 'src modules discovered');
  for (const source of sources) {
    const stem = `lib/${source.slice(0, -3)}`;
    assert.ok(files.includes(`${stem}.js`), `built module present: ${stem}.js`);
    assert.ok(files.includes(`${stem}.d.ts`), `built declaration present: ${stem}.d.ts`);
  }
});
