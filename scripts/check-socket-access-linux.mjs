import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--compiled-dir'),
  'usage: node scripts/check-socket-access-linux.mjs [--compiled-dir DIRECTORY]');
process.env.DSH_SOCKET_ACCESS_GATE = 'release';
try {
  const { runLinuxAcceptance, LinuxPrerequisiteError } = await import(pathToFileURL(resolve(
    args[1] ?? '.test-dist-linux', 'test/http/socket-access-linux-harness.js')).href);
  try {
    const report = await runLinuxAcceptance();
    assert.deepEqual(report, { groupPositive: 4, strictNegative: 2 });
    console.log(`PASS A7-A9: groupPositive=${report.groupPositive} strictNegative=${report.strictNegative}; A10 NOT RUN`);
  } catch (error) {
    if (error instanceof LinuxPrerequisiteError) {
      console.error(`BLOCKED A7-A9: ${error.reason}; A10 NOT RUN`);
      process.exitCode = 2;
    } else {
      console.error('FAIL A7-A9: acceptance assertion or runtime failure; A10 NOT RUN');
      if (error instanceof assert.AssertionError) console.error(error.message);
      process.exitCode = 1;
    }
  }
} catch {
  console.error('BLOCKED A7-A9: compiled Linux harness unavailable; compile with tsc -p tsconfig.test.json --outDir .test-dist-linux');
  process.exitCode = 2;
}
