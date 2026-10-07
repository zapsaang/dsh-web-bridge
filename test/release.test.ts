import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const guard = resolve('scripts/check-release.mjs');
const version = '0.1.0-alpha.1';
const manifest = {
  name: '@zapsaang/dsh-web-bridge', version,
  publishConfig: { access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org/' },
} as const;

const cases = [
  { name: 'valid alpha', json: manifest, expected: version, ref: 'refs/heads/main', code: 0 },
  { name: 'wrong identity', json: { ...manifest, name: 'other-package' }, code: 1 },
  { name: 'version mismatch', expected: '0.1.0-alpha.2', code: 1 },
  { name: 'stable version', json: { ...manifest, version: '0.1.0' }, expected: '0.1.0', code: 1 },
  { name: 'rc version', json: { ...manifest, version: '0.1.0-rc.1' }, expected: '0.1.0-rc.1', code: 1 },
  { name: 'alpha with build metadata', json: { ...manifest, version: `${version}+build` }, expected: `${version}+build`, code: 1 },
  { name: 'leading-zero alpha', json: { ...manifest, version: '0.1.0-alpha.01' }, expected: '0.1.0-alpha.01', code: 1 },
  { name: 'branch ref', ref: 'refs/heads/topic', code: 1 },
  { name: 'tag ref', ref: `refs/tags/v${version}`, code: 1 },
  { name: 'missing expected version', expected: '', code: 1 },
  { name: 'missing ref', ref: '', code: 1 },
  { name: 'missing publish defaults', json: { name: manifest.name, version }, code: 1 },
  { name: 'restricted access', json: { ...manifest, publishConfig: { ...manifest.publishConfig, access: 'restricted' } }, code: 1 },
  { name: 'latest tag', json: { ...manifest, publishConfig: { ...manifest.publishConfig, tag: 'latest' } }, code: 1 },
  { name: 'other registry', json: { ...manifest, publishConfig: { ...manifest.publishConfig, registry: 'https://example.com/' } }, code: 1 },
] as const;

for (const fixture of cases) {
  for (const packed of [false, true]) {
    test(`release guard returns ${fixture.code} when ${fixture.name} (${packed ? 'tarball' : 'manifest'})`, (t) => {
      // Given: isolated manifest or a real tar archive, never the repository manifest.
      const dir = mkdtempSync(join(tmpdir(), 'release-guard-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const json = 'json' in fixture ? fixture.json : manifest;
      mkdirSync(join(dir, 'package'));
      writeFileSync(join(dir, 'package/package.json'), JSON.stringify(json));
      const output = join(dir, 'output');
      mkdirSync(output);
      if (packed) execFileSync('tar', ['-czf', join(output, 'release.tgz'), '-C', dir, 'package']);
      // When: the same CLI boundary used by the release jobs is invoked.
      const result = spawnSync(process.execPath, [guard, ...(packed
        ? ['--pack-dir', output] : [join(dir, 'package/package.json')])], {
        encoding: 'utf8',
        env: { ...process.env, EXPECTED_VERSION: 'expected' in fixture ? fixture.expected : version,
          GITHUB_REF: 'ref' in fixture ? fixture.ref : 'refs/heads/main' },
      });
      // Then: invalid releases fail closed; the valid fixture proves the CLI actually works.
      assert.equal(result.status, fixture.code, result.stderr);
    });
  }
}

for (const count of [0, 2]) {
  test(`release guard rejects pack output when it has ${count} tarballs`, (t) => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), 'release-output-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (let i = 0; i < count; i++) writeFileSync(join(dir, `${i}.tgz`), 'not a tarball');
    // When
    const result = spawnSync(process.execPath, [guard, '--pack-dir', dir], {
      encoding: 'utf8', env: { ...process.env, EXPECTED_VERSION: version, GITHUB_REF: 'refs/heads/main' },
    });
    // Then
    assert.equal(result.status, 1, result.stderr);
  });
}
