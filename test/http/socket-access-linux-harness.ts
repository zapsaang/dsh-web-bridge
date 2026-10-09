import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, chown, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identities as id, LinuxChild } from './socket-access-linux-process.js';
import type { Subject } from './socket-access-linux-process.js';

export class LinuxPrerequisiteError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'LinuxPrerequisiteError'; }
}
const service: Subject = { uid: id.service, gid: id.serviceGid, groups: [] };
const primary: Subject = { uid: id.peer, gid: id.group, groups: [] };
const supplementary: Subject = { uid: id.peer, gid: id.peerGid, groups: [id.group] };
const foreign: Subject = { uid: id.peer, gid: id.peerGid, groups: [] };

async function baseAcl(path: string): Promise<void> {
  const acl = spawnSync('getfacl', ['-cp', '--', path], { encoding: 'utf8', timeout: 5000 });
  if (acl.error || acl.status !== 0) throw new LinuxPrerequisiteError('getfacl cannot inspect the isolated fixture path');
  const entries = acl.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (entries.length !== 3 || !entries.every(line => /^(user::|group::|other::)[rwx-]{3}$/.test(line))) {
    throw new LinuxPrerequisiteError('fixture path has unsupported extended/default ACL entries');
  }
}
async function prerequisites(): Promise<void> {
  if (process.env['DSH_SOCKET_ACCESS_PREREQUISITE_TEST'] === 'missing-capability') {
    throw new LinuxPrerequisiteError('injected unavailable identity-switch capability at harness boundary');
  }
  if (process.platform !== 'linux') throw new LinuxPrerequisiteError('real Linux /proc and Unix DAC required');
  for (const tool of ['setpriv', 'flock', 'getfacl']) {
    const probe = spawnSync(tool, ['--version'], { stdio: 'ignore', timeout: 5000 });
    if (probe.error || probe.status !== 0) throw new LinuxPrerequisiteError(`${tool} unavailable`);
  }
  const drop = spawnSync('setpriv', ['--reuid=61001', '--regid=61002', '--clear-groups',
    '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
    process.execPath, '-e', 'process.exit(process.geteuid() === 61001 ? 0 : 1)'], { stdio: 'ignore', timeout: 5000 });
  if (drop.error || drop.status !== 0) throw new LinuxPrerequisiteError('setpriv cannot launch an ordinary foreign UID with cleared capabilities');
  for (const path of ['/', '/run']) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o005) !== 0o005) {
      throw new LinuxPrerequisiteError(`${path} is not a trusted traversable Linux runtime ancestor`);
    }
    await baseAcl(path);
  }
  if (process.geteuid?.() !== 0) throw new LinuxPrerequisiteError('secure /run fixture orchestration requires explicit privileged invocation');
  // Credential and pinned-installation launch checks happen before feature assertions; only this phase may BLOCK/SKIP.
  for (const subject of [service, primary, supplementary, foreign]) {
    try {
      await using child = new LinuxChild(subject, { role: 'probe', root: '', directory: '' });
      const reply = await child.next();
      if (reply.status !== 'done') throw new LinuxPrerequisiteError(`genuine pinned DSH prerequisite unavailable: ${reply.phase}`);
      console.log(JSON.stringify({ case: 'ordinary-credentials', credentials: reply.credentials }));
    } catch (error) {
      if (error instanceof LinuxPrerequisiteError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new LinuxPrerequisiteError(`ordinary worker launch/credentials or pinned DSH installation unavailable: ${detail}`);
    }
  }
}

export async function runLinuxAcceptance(): Promise<{ readonly groupPositive: number; readonly strictNegative: number }> {
  await prerequisites();
  let root: string;
  try { root = await mkdtemp('/run/dsh-bridge-linux-'); }
  catch { throw new LinuxPrerequisiteError('cannot create unique secure /run fixture'); }
  try {
    await chmod(root, 0o755);
    await writeFile(join(root, 'witness'), 'traversable', { mode: 0o644 });
    const home = join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    await chown(home, id.service, id.serviceGid);
    await baseAcl(root);
    const directory = join(root, 'socket');
    await mkdir(directory, { mode: 0o700 });
    await chown(directory, id.service, id.group);
    await writeFile(join(directory, 'witness'), 'traversable', { mode: 0o644 });
    assert.notEqual(service.gid, id.group, 'service EGID differs from captured parentGID');
    assert.notEqual(foreign.uid, service.uid, 'foreign peer is not socket owner');
    let groupPositive = 0;
    let strictNegative = 0;
    for (const mode of [0o2710, 0o2750]) {
      await chmod(directory, mode);
      await baseAcl(directory);
      const parent = await lstat(directory);
      assert.equal(parent.gid, id.group);
      assert.equal(parent.mode & 0o7777, mode);
      await using owner = new LinuxChild(service, { role: 'service', root, directory, access: 'group' });
      const ready = await owner.next();
      assert.equal(ready.status, 'ready', `feature service failed at ${ready.phase}`);
      assert.equal(ready.socketMode, 0o660);
      assert.equal(ready.socketGid, parent.gid, 'native setgid inheritance, not service EGID');
      await baseAcl(join(directory, 'bridge.sock'));
      const lock = await lstat(join(directory, 'bridge.sock.lock'));
      assert.equal(lock.mode & 0o777, 0o600);
      await baseAcl(join(directory, 'bridge.sock.lock'));
      for (const subject of [primary, supplementary]) {
        await using peer = new LinuxChild(subject, { role: 'peer', root, directory, member: true });
        const result = await peer.next();
        assert.equal(result.status, 'done', `ordinary peer assertion failed at ${result.phase}`);
        groupPositive++;
        console.log(JSON.stringify({ case: 'group', mode, credentials: result.credentials, status: 'PASS' }));
      }
      await using denied = new LinuxChild(foreign, { role: 'peer', root, directory, member: false });
      const denial = await denied.next();
      assert.equal(denial.status, 'done', `nonmember assertion failed at ${denial.phase}`);
      owner.process.send('dispose');
      assert.equal((await owner.next()).status, 'done');
    }
    await chmod(directory, 0o700);
    for (const access of [undefined, 'strict'] as const) {
      await using owner = new LinuxChild(service, { role: 'service', root, directory, ...(access ? { access } : {}) });
      const ready = await owner.next();
      assert.equal(ready.status, 'ready', `strict service assertion failed at ${ready.phase}`);
      assert.equal(ready.socketMode, 0o600, 'default and explicit strict have equivalent owner-only socket mode');
      await using peer = new LinuxChild(foreign, { role: 'peer', root, directory, member: false });
      const denial = await peer.next();
      assert.equal(denial.status, 'done', `strict foreign UID assertion failed at ${denial.phase}`);
      strictNegative++;
      owner.process.send('dispose');
      assert.equal((await owner.next()).status, 'done');
    }
    assert.equal(groupPositive, 4);
    assert.equal(strictNegative, 2);
    return { groupPositive, strictNegative };
  } finally { await rm(root, { recursive: true, force: true }); }
}
