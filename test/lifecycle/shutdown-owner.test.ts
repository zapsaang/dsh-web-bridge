import test from 'node:test';
import { cleanup, tempDir } from './helpers.js';
import { shutdownChild } from './shutdown-child.js';

for (const scenario of [
  'close-hang-not-listening', 'close-callback-error', 'close-throw',
  'late-bind-past-deadline', 'chmod-hang-cancel', 'upgraded-ws-open',
  'bind-failure-release', 'close-not-running-error',
  'sync-lock-path-abort', 'sync-lock-handle-abort',
  'pending-open', 'pending-open-sync-abort', 'pending-lock-stat', 'pending-lock-path-stat', 'pending-initial-stat',
  'pending-probe', 'pending-stale-unlink', 'pending-bound-stat', 'pending-final-stat',
  'pending-residual-stat', 'pending-residual-unlink', 'pending-helper-reap',
]) {
  test(`5: shutdown owner ${scenario}`, { timeout: 10000 }, async (t) => {
    // Given: each quarantine fixture owns an isolated directory/process.
    const dir = await tempDir();
    t.after(() => cleanup(dir));
    // When / Then: exit is the ONLY fixture teardown; assertions run in the child.
    await shutdownChild(scenario, dir);
  });
}
