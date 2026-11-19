import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/prepare-upstream-pr.mjs');

test('prepare-upstream-pr --check-only outputs structured JSON', () => {
  const result = spawnSync(process.execPath, [script, '--check-only', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(typeof data.hasUpdate, 'boolean');
  assert.equal(typeof data.currentDsh, 'string');
  assert.equal(typeof data.targetDsh, 'string');
  assert.equal(typeof data.currentPluginVersion, 'string');
  assert.equal(typeof data.nextPluginVersion, 'string');
  assert.ok(data.branchName.startsWith('chore/sync-dsh-'));
  assert.ok(data.prTitle.startsWith('chore(deps): sync DSH '));
});

test('prepare-upstream-pr with older target-dsh indicates no update', () => {
  const result = spawnSync(process.execPath, [script, '--check-only', '--json', '--target-dsh', '0.2.2-rc.1'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.hasUpdate, false);
  assert.equal(data.currentPluginVersion, data.nextPluginVersion);
});

test('prepare-upstream-pr with newer target-dsh projects next RC version', () => {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  const currentVersion = manifest.version;
  const match = /^(.+-rc\.)(\d+)$/.exec(currentVersion);
  assert.ok(match !== null, `expected current version to be an rc version, got ${currentVersion}`);
  const expectedNextVersion = `${match[1]}${Number(match[2]) + 1}`;

  const result = spawnSync(process.execPath, [script, '--check-only', '--json', '--target-dsh', '0.2.3-rc.1'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.hasUpdate, true);
  assert.equal(data.targetDsh, '0.2.3-rc.1');
  assert.equal(data.currentPluginVersion, currentVersion);
  assert.equal(data.nextPluginVersion, expectedNextVersion);
  assert.equal(data.branchName, 'chore/sync-dsh-0.2.3-rc.1');
  assert.equal(data.prTitle, `chore(deps): sync DSH 0.2.3-rc.1 baseline and bump to ${expectedNextVersion}`);
});

test('prepare-upstream-pr with --dry-run on older version exits clean without modifying files', () => {
  const result = spawnSync(process.execPath, [script, '--dry-run', '--json', '--target-dsh', '0.2.2-rc.1'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.hasUpdate, false);
});
