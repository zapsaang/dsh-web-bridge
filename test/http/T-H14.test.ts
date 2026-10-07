import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, LeaseError } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, spawnFixture, tempDir } from '../lifecycle/helpers.js';

test('T-H14a: same-uid second process conflicts on the lease without disturbing the owner', async (t) => {
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const holder = spawnFixture('hold-lease.mjs', [dir]);
  t.after(() => holder.kill('SIGKILL'));
  await holder.waitReady();

  await assert.rejects(
    acquire(socketPath, responder(), new AbortController().signal),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_CONFLICT',
  );
  assert.equal((await requestOverSocket(socketPath)).body, 'held', 'holder keeps serving after conflict');
});

function canDropUid(): boolean {
  const probe = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'true'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

test('T-H14b: other-uid process is denied by DAC (permission denied)', async (t) => {
  if (!canDropUid()) {
    t.skip('setpriv cannot drop to uid 65534 without privileges; DAC denial not observable here');
    return;
  }
  const dir = await tempDir();
  t.after(() => cleanup(dir));
  const socketPath = join(dir, 'bridge.sock');
  const lease = await acquire(socketPath, responder(), new AbortController().signal);
  t.after(() => lease.dispose());

  const script = `import('node:net').then(({connect}) => {
    const c = connect({ path: process.argv[1] }, () => { c.destroy(); process.exit(0); });
    c.on('error', (e) => { process.stdout.write(e.code ?? 'UNKNOWN'); process.exit(1); });
  })`;
  const attempt = spawnSync('setpriv', [
    '--reuid=65534', '--regid=65534', '--clear-groups',
    process.execPath, '--input-type=module', '-e', script, socketPath,
  ], { encoding: 'utf8' });
  assert.notEqual(attempt.status, 0, 'foreign uid cannot use the socket');
  assert.equal(attempt.stdout.trim(), 'EACCES', 'denial is a DAC permission error');
});
