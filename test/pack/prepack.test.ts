import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('npm pack builds through prepack when pnpm is unavailable', (t) => {
  // Given: real manifest scripts and compiler, with all build output isolated.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-bridge-prepack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['src/dsh', 'scripts', 'node_modules/.bin']) {
    mkdirSync(join(dir, path), { recursive: true });
  }
  for (const path of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'scripts/check-pack-files.mjs']) {
    copyFileSync(path, join(dir, path));
  }
  writeFileSync(join(dir, 'src/dsh/index.ts'), 'export const name = "isolated-pack-fixture";\n');
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { rootDir: 'src', outDir: 'lib', declaration: true },
    include: ['src/**/*.ts'],
  }));
  symlinkSync(realpathSync('node_modules/.bin/tsc'), join(dir, 'node_modules/.bin/tsc'));
  // npm prepends this directory to lifecycle PATH, even if pnpm exists globally.
  writeFileSync(join(dir, 'node_modules/.bin/pnpm'), '#!/bin/sh\nprintf "pnpm: not found\\n" >&2\nexit 127\n', { mode: 0o755 });

  // When: scripts are explicitly enabled, including the non-recursive pack gate.
  const pack = spawnSync('npm', ['pack', '--ignore-scripts=false'], {
    cwd: dir, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, npm_config_ignore_scripts: 'false', npm_config_cache: join(dir, '.npm-cache') },
  });

  // Then: a fresh build is present in the real tarball, not merely a dry-run list.
  assert.equal(pack.status, 0, `${pack.stdout}\n${pack.stderr}`);
  assert.ok(existsSync(join(dir, 'lib/dsh/index.js')));
  assert.ok(existsSync(join(dir, 'lib/dsh/index.d.ts')));
  const manifest: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.ok(typeof manifest === 'object' && manifest !== null && 'name' in manifest && 'version' in manifest);
  const tarball = join(dir, `${manifest.name}-${manifest.version}.tgz`);
  const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.trim().split('\n');
  for (const path of ['lib/dsh/index.js', 'lib/dsh/index.d.ts', 'LICENSE', 'cordis.patch.yml']) {
    assert.ok(files.includes(`package/${path}`), `required packed artifact: ${path}`);
  }
});
