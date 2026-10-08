import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { LinuxPrerequisiteError, runLinuxAcceptance } from './socket-access-linux-harness.js';

test('A7-A9 real Linux ordinary identities authenticate through the public bridge', { timeout: 120000 }, async t => {
  // Given: a unique, precreated shared /run fixture and a real pinned native DSH.
  try {
    // When: the complete four-positive matrix and both strict foreign-UID denials run.
    const report = await runLinuxAcceptance();
    // Then: partial or skipped cases cannot produce formal PASS.
    assert.deepEqual(report, { groupPositive: 4, strictNegative: 2 });
  } catch (error) {
    if (!(error instanceof LinuxPrerequisiteError)) throw error;
    if (process.env['DSH_SOCKET_ACCESS_GATE'] === 'release') throw error;
    t.skip(error.reason);
  }
});

test('A9 release entry is BLOCKED while development can SKIP when identity capability is unavailable', () => {
  // Given: deterministic prerequisite loss at the harness boundary, not a plugin configuration backdoor.
  const compiled = fileURLToPath(new URL('../../', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_SOCKET_ACCESS_PREREQUISITE_TEST: 'missing-capability' };
  delete env['NODE_TEST_CONTEXT'];
  // When: invoke the actual formal entry and the exact development test in isolated processes.
  const formal = spawnSync(process.execPath, ['scripts/check-socket-access-linux.mjs', '--compiled-dir', compiled],
    { env, encoding: 'utf8', timeout: 20000 });
  const dev = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^A7-A9', fileURLToPath(import.meta.url)],
    { env: { ...env, DSH_SOCKET_ACCESS_GATE: 'development' }, encoding: 'utf8', timeout: 20000 });
  // Then: loss is classified, nonzero formally, and never a release PASS.
  assert.equal(formal.status, 2, formal.stderr);
  assert.match(formal.stderr, /BLOCKED/);
  assert.doesNotMatch(formal.stdout, /PASS/);
  assert.equal(dev.status, 0, dev.stderr);
  assert.match(dev.stdout, /# SKIP .*unavailable identity-switch capability/);
});
