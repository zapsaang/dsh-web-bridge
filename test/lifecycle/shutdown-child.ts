import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function shutdownChild(scenario: string, dir: string): Promise<void> {
  const fixture = fileURLToPath(new URL('../../../test/lifecycle/fixtures/shutdown-owner.mjs', import.meta.url));
  const socketJs = fileURLToPath(new URL('../../src/lib/socket.js', import.meta.url));
  const result = await promisify(execFile)(process.execPath, ['--expose-gc', fixture, socketJs, scenario, dir], { timeout: 6500 });
  assert.equal(result.stdout.trim(), `PASS ${scenario}`);
}
