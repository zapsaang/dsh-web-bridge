import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// T-P5: deployment examples are repository-only, so a static gate keeps them
// pointed at the same socket path and authority as examples/overlay.example.yml
// and keeps the required TLS/auth/streaming directives in place.
test('T-P5: deployment examples stay consistent with the example overlay', () => {
  // Given / When
  const result = spawnSync(process.execPath, ['scripts/check-examples.mjs'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  // Then
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: deployment examples/);
});

// Negative control: a drifted example must fail the gate, not silently pass.
test('T-P5b: the example gate rejects an example that no longer preserves Host', () => {
  // Given a throwaway workspace copy with one nginx directive degraded
  const dir = mkdtempSync(join(tmpdir(), 'dsh-examples-'));
  try {
    cpSync('examples', join(dir, 'examples'), { recursive: true });
    cpSync('README.md', join(dir, 'README.md'));
    cpSync('package.json', join(dir, 'package.json'));
    const nginx = join(dir, 'examples/nginx.conf');
    writeFileSync(nginx, readFileSync(nginx, 'utf8')
      .replace('proxy_set_header Host $http_host;', 'proxy_set_header Host $host;'));
    // When the gate runs against that copy
    const result = spawnSync(process.execPath, [resolve('scripts/check-examples.mjs')], {
      cwd: dir, encoding: 'utf8', timeout: 30_000,
    });
    // Then it fails closed with the exact requirement named
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /ERR_EXAMPLES: nginx must preserve the exact Host/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
