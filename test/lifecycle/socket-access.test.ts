import assert from 'node:assert/strict';
import { chmod, chown, lstat, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { acquire, defaultIo, dispose, LeaseError, type LeaseIo, type SocketLease } from '../../src/lib/socket.js';
import { cleanup, requestOverSocket, responder, tempDir } from './helpers.js';
import { fakeStat } from './stub-io.js';

const euid = process.geteuid?.() ?? 0;
const egid = process.getegid?.() ?? 0;

// §3.2 group fixtures need a parent directory whose GID differs from the
// process EGID (rules out accidental fsgid inheritance) and that this process
// may chgrp to: a locally existing supplementary group.
function sharedGid(): number | undefined {
  return process.getgroups?.().find((gid) => gid !== egid);
}

interface GroupFixture {
  readonly dir: string;
  readonly socketPath: string;
  readonly gid: number;
}

async function groupParent(t: test.TestContext, mode: number): Promise<GroupFixture | undefined> {
  const gid = sharedGid();
  if (gid === undefined) {
    t.skip('no supplementary group distinct from EGID; cannot chgrp the group-mode parent fixture');
    return undefined;
  }
  const root = await tempDir();
  t.after(() => cleanup(root));
  const dir = join(root, 'shared');
  await mkdir(dir);
  await chown(dir, euid, gid);
  await chmod(dir, mode);
  return { dir, socketPath: join(dir, 'bridge.sock'), gid };
}

async function expectDirectoryRejection(socketPath: string): Promise<void> {
  let lease: SocketLease | undefined;
  try {
    lease = await acquire(socketPath, responder(), new AbortController().signal, defaultIo, 'group');
  } catch (error) {
    assert.ok(error instanceof LeaseError, 'failure is a LeaseError');
    assert.equal(error.code, 'ERR_BRIDGE_LEASE_DIRECTORY');
    return;
  }
  await dispose(lease);
  assert.fail('group-mode acquisition unexpectedly succeeded');
}

for (const mode of [0o2710, 0o2750]) {
  test(`2: group parent with exact setgid mode ${mode.toString(8)} is accepted`, async (t) => {
    // Given
    const fixture = await groupParent(t, mode);
    if (!fixture) return;
    // When
    const lease = await acquire(fixture.socketPath, responder(), new AbortController().signal, defaultIo, 'group');
    t.after(() => dispose(lease));
    // Then
    assert.equal((await requestOverSocket(fixture.socketPath)).status, 200, 'group-mode lease serves');
    assert.notEqual(fixture.gid, egid, 'fixture parent GID genuinely differs from the process EGID');
  });
}

for (const [label, mode] of [
  ['missing setgid', 0o710],
  ['group write', 0o2770],
  ['other execute', 0o2711],
  ['no group traverse', 0o2700],
  ['strict-style 0700', 0o700],
] as const) {
  test(`2: group parent with ${label} (${mode.toString(8)}) fails closed`, async (t) => {
    // Given
    const fixture = await groupParent(t, mode);
    if (!fixture) return;
    // When / Then
    await expectDirectoryRejection(fixture.socketPath);
  });
}

test('2: symlink at the group parent path fails closed', async (t) => {
  // Given
  const fixture = await groupParent(t, 0o2710);
  if (!fixture) return;
  const root = await tempDir();
  t.after(() => cleanup(root));
  const link = join(root, 'link');
  await symlink(fixture.dir, link);
  // When / Then
  await expectDirectoryRejection(join(link, 'bridge.sock'));
});

test('2: group mode still rejects a group-writable ancestor', async (t) => {
  // Given
  const gid = sharedGid();
  if (gid === undefined) {
    t.skip('no supplementary group distinct from EGID; cannot chgrp the group-mode parent fixture');
    return;
  }
  const root = await tempDir();
  t.after(() => cleanup(root));
  const lax = join(root, 'lax');
  await mkdir(lax);
  await chmod(lax, 0o770);
  const dir = join(lax, 'shared');
  await mkdir(dir);
  await chown(dir, euid, gid);
  await chmod(dir, 0o2710);
  // When / Then
  await expectDirectoryRejection(join(dir, 'bridge.sock'));
});

test('2: group predicate does not weaken the strict default path', async (t) => {
  // Given: a group-shaped directory...
  const fixture = await groupParent(t, 0o2710);
  if (!fixture) return;
  // When / Then: ...is rejected under strict (mode & 077 preserves existing behavior)
  await assert.rejects(
    acquire(fixture.socketPath, responder(), new AbortController().signal),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_DIRECTORY',
  );
});

test('3: group socket ends 0660 with the parent GID inherited through setgid', async (t) => {
  // Given
  const fixture = await groupParent(t, 0o2710);
  if (!fixture) return;
  // When
  const lease = await acquire(fixture.socketPath, responder(), new AbortController().signal, defaultIo, 'group');
  t.after(() => dispose(lease));
  // Then
  const stat = await lstat(fixture.socketPath);
  assert.ok(stat.isSocket());
  assert.equal(stat.mode & 0o777, 0o660, 'group socket mode 0660');
  assert.equal(stat.uid, euid, 'socket owned by euid');
  assert.equal(stat.gid, fixture.gid, 'socket GID inherited from the setgid parent');
  assert.notEqual(stat.gid, egid, 'inherited GID is not the process EGID (no accidental fsgid pass)');
  assert.equal((await requestOverSocket(fixture.socketPath)).status, 200);
});

test('3: group bound socket with a GID other than the parent GID fails closed', async (t) => {
  // Given: a real group parent, but the bound-socket observation reports a drifted GID
  const fixture = await groupParent(t, 0o2710);
  if (!fixture) return;
  const realLstat = defaultIo.lstat;
  let socketStats = 0;
  const io: LeaseIo = {
    ...defaultIo,
    lstat: async (path) => {
      if (path !== fixture.socketPath) return realLstat(path);
      socketStats += 1;
      if (socketStats === 1) return realLstat(path); // initial ENOENT
      const stat = await realLstat(path);
      return fakeStat({ kind: 'socket', dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: egid, mode: stat.mode & 0o777 });
    },
  };
  // When / Then
  await assert.rejects(
    acquire(fixture.socketPath, responder(), new AbortController().signal, io, 'group'),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_STATE',
  );
});

test('3: strict mode leaves the socket GID unconstrained', async (t) => {
  // Given: a strict-shaped directory whose setgid bit is additionally set
  const root = await tempDir();
  t.after(() => cleanup(root));
  const dir = join(root, 'strict-setgid');
  await mkdir(dir);
  const gid = sharedGid();
  if (gid === undefined) {
    t.skip('no supplementary group distinct from EGID; cannot chgrp the fixture');
    return;
  }
  await chown(dir, euid, gid);
  await chmod(dir, 0o2700);
  // When
  const lease = await acquire(join(dir, 'bridge.sock'), responder(), new AbortController().signal);
  t.after(() => dispose(lease));
  // Then: strict accepts the parent-inherited GID and still pins mode 0600
  const stat = await lstat(join(dir, 'bridge.sock'));
  assert.equal(stat.gid, gid, 'setgid parent propagated its GID');
  assert.equal(stat.mode & 0o777, 0o600, 'strict socket mode 0600');
});

// §3.3 step 5: after the REAL chmod, the final lstat is wrapped so exactly one
// field drifts; the real socket stays untouched on disk.
function finalStatInjection(socketPath: string, drift: { uid?: number; gid?: number }): LeaseIo {
  const realLstat = defaultIo.lstat;
  let chmodded = false;
  return {
    ...defaultIo,
    chmod: async (path, mode) => {
      await defaultIo.chmod(path, mode);
      chmodded = true;
    },
    lstat: async (path) => {
      const stat = await realLstat(path);
      if (path !== socketPath || !chmodded) return stat;
      return fakeStat({
        kind: 'socket',
        dev: stat.dev,
        ino: stat.ino,
        uid: drift.uid ?? stat.uid,
        gid: drift.gid ?? stat.gid,
        mode: stat.mode & 0o777,
      });
    },
  };
}

test('4: strict post-chmod uid drift fails closed', async (t) => {
  // Given
  const root = await tempDir();
  t.after(() => cleanup(root));
  const socketPath = join(root, 'bridge.sock');
  const io = finalStatInjection(socketPath, { uid: euid === 0 ? 1 : 0 });
  // When / Then
  await assert.rejects(
    acquire(socketPath, responder(), new AbortController().signal, io),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_STATE',
  );
});

test('4: group post-chmod uid drift fails closed', async (t) => {
  // Given
  const fixture = await groupParent(t, 0o2710);
  if (!fixture) return;
  const io = finalStatInjection(fixture.socketPath, { uid: euid === 0 ? 1 : 0 });
  // When / Then
  await assert.rejects(
    acquire(fixture.socketPath, responder(), new AbortController().signal, io, 'group'),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_STATE',
  );
});

test('4: group post-chmod gid drift fails closed', async (t) => {
  // Given
  const fixture = await groupParent(t, 0o2710);
  if (!fixture) return;
  const io = finalStatInjection(fixture.socketPath, { gid: egid });
  // When / Then
  await assert.rejects(
    acquire(fixture.socketPath, responder(), new AbortController().signal, io, 'group'),
    (error: unknown) => error instanceof LeaseError && error.code === 'ERR_BRIDGE_LEASE_STATE',
  );
});

test('4: strict post-chmod gid drift stays accepted (strict GID unconstrained)', async (t) => {
  // Given
  const root = await tempDir();
  t.after(() => cleanup(root));
  const socketPath = join(root, 'bridge.sock');
  const gid = sharedGid();
  if (gid === undefined) {
    t.skip('no supplementary group distinct from EGID; cannot drift the final GID');
    return;
  }
  const io = finalStatInjection(socketPath, { gid });
  // When
  const lease = await acquire(socketPath, responder(), new AbortController().signal, io);
  t.after(() => dispose(lease));
  // Then
  assert.equal((await requestOverSocket(socketPath)).status, 200);
});
