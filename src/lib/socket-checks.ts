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
  const perm = mode & 0o7777;
  // Security principle: other must have no access (rwx) to prevent unauthorized foreign users
  if ((perm & 0o007) !== 0) return false;
  switch (access) {
    case 'strict':
      // Strict mode: no group write, no other access.
      // Permits standard 0700/02700 as well as group read/execute modes (e.g. 0750, 0710, 02750, 02710)
      // resulting from POSIX ACL mask or controlled read-only delegation.
      return (perm & 0o020) === 0;
    case 'group':
      // Group mode: group must have at least execute (traverse) permission.
      // Standard group-sharing modes (0770, 02770, 0750, 02750, 0710, 02710) are accepted.
      return (perm & 0o010) !== 0;
  }
}

function assertParentDirectory(stat: PathStatLike, access: SocketAccess): void {
  if (!stat.isDirectory() || stat.uid !== euid() || !parentModeTrusted(stat.mode, access)) {
    throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY', access === 'group'
      ? 'group socket parent must be an euid-owned real directory accessible to group and not writable by other'
      : 'socket parent directory must be euid-owned and not writable by group or other');
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

function isAncestorTrusted(stat: PathStatLike): boolean {
  if (!stat.isDirectory()) return false;
  // Ancestor directory must be owned by root (0) or the current process user (euid)
  if (stat.uid !== 0 && stat.uid !== euid()) return false;
  // POSIX / Linux FHS Sticky Bit (01000 / S_ISVTX): prevents non-owners from unlinking or renaming
  // files/subdirectories inside (e.g. /tmp, /run/user/UID), guaranteeing anti-tampering against symlink attacks.
  if ((stat.mode & 0o1000) !== 0) return true;
  // Without sticky bit, non-owners must not have write permissions (group write or other write)
  return (stat.mode & 0o022) === 0;
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
    if (!isAncestorTrusted(stat)) {
      throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY',
        'socket ancestors must be root/euid-owned real directories without group/other write or with sticky bit');
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
