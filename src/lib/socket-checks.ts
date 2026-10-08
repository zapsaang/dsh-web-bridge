import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { euid, LeaseError, type LockHandle, type PathStat, type SocketAccess } from './socket-types.js';

type Work = <T>(operation: () => Promise<T>) => Promise<T>;

export function assertPathConstraints(socketPath: string): void {
  if (!isAbsolute(socketPath) || socketPath.includes('\0') || socketPath.split('/').includes('..')
    || Buffer.byteLength(socketPath, 'utf8') > 107) {
    throw new LeaseError('ERR_BRIDGE_LEASE_PATH',
      'socket path must be absolute, NUL-free, traversal-free, and at most 107 UTF-8 bytes');
  }
}

function parentModeTrusted(mode: number, access: SocketAccess): boolean {
  switch (access) {
    case 'strict': return (mode & 0o077) === 0;
    case 'group': {
      const full = mode & 0o7777;
      return full === 0o2710 || full === 0o2750;
    }
  }
}

function assertParentDirectory(stat: PathStatLike, access: SocketAccess): void {
  if (!stat.isDirectory() || stat.uid !== euid() || !parentModeTrusted(stat.mode, access)) {
    throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY', access === 'group'
      ? 'group socket parent must be an euid-owned real directory with mode exactly 02710 or 02750'
      : 'socket parent directory must be euid-owned and inaccessible to group/other');
  }
}

interface PathStatLike {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  isDirectory(): boolean;
}

async function lstatParent(socketPath: string, work: Work): Promise<PathStatLike> {
  return work(() => lstat(dirname(socketPath))).catch((error: unknown) => {
    if (error instanceof LeaseError) throw error;
    throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY', 'socket parent directory is not accessible', { cause: error });
  });
}

export async function assertTrustedDirectory(socketPath: string, access: SocketAccess, work: Work): Promise<number> {
  let current = dirname(socketPath);
  const parent = await lstatParent(socketPath, work);
  assertParentDirectory(parent, access);
  while (dirname(current) !== current) {
    current = dirname(current);
    const stat = await work(() => lstat(current)).catch((error: unknown) => {
      if (error instanceof LeaseError) throw error;
      throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY', 'socket ancestor is not accessible', { cause: error });
    });
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== euid()) || (stat.mode & 0o022) !== 0) {
      throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY',
        'socket ancestors must be root/euid-owned real directories without group/other write');
    }
  }
  return parent.gid;
}

// §3.3 phase two: after the stable flock, immediately before bind, the parent
// is re-inspected with the native lstat and the fresh GID is authoritative.
export async function recheckParentDirectory(socketPath: string, access: SocketAccess, work: Work): Promise<number> {
  const parent = await lstatParent(socketPath, work);
  assertParentDirectory(parent, access);
  return parent.gid;
}

export async function checkLock(handle: LockHandle, viaPath: Promise<PathStat>, work: Work): Promise<void> {
  try {
    // Observe viaPath before work can synchronously throw on reentrant cancellation.
    const [viaHandle, pathStat] = await Promise.all([Promise.resolve().then(() => work(() => handle.stat())), viaPath]);
    if (!viaHandle.isFile() || !pathStat.isFile() || viaHandle.dev !== pathStat.dev || viaHandle.ino !== pathStat.ino
      || viaHandle.uid !== euid() || (viaHandle.mode & 0o777) !== 0o600) {
      throw new LeaseError('ERR_BRIDGE_LEASE_LOCK',
        'lock file must be the same euid-owned regular inode with mode 0600');
    }
  } catch (error) {
    if (error instanceof LeaseError) throw error;
    throw new LeaseError('ERR_BRIDGE_LEASE_LOCK', 'lock file identity check failed', { cause: error });
  }
}
