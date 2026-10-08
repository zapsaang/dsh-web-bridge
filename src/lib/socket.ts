import { defaultIo } from './socket-io.js';
import { assertPathConstraints, assertTrustedDirectory, checkLock, recheckParentDirectory } from './socket-checks.js';
import { ShutdownOwner } from './socket-owner.js';
import { codeOf, euid, LeaseError, stateError, throwIfAborted,
  type LeaseIo, type LeaseServer, type SocketAccess, type SocketLease } from './socket-types.js';
export * from './socket-types.js';
export { defaultIo } from './socket-io.js';

/** Acquire stable flock inode before socket mutations; bind/mode checks (§9).
 * The five arguments are the approved public lease contract. */
export async function acquire(
  socketPath: string,
  server: LeaseServer,
  signal: AbortSignal,
  io: LeaseIo = defaultIo,
  socketAccess: SocketAccess = 'strict',
): Promise<SocketLease> {
  assertPathConstraints(socketPath);
  throwIfAborted(signal);
  const targetMode = socketAccess === 'group' ? 0o660 : 0o600;
  const owner = new ShutdownOwner(socketPath, server, { io, signal });
  const work = <T>(operation: () => Promise<T>) => owner.step(operation);
  try {
    let parentGid = await assertTrustedDirectory(socketPath, socketAccess, work);
    const lock = await owner.openLock().catch((error: unknown) => {
      if (error instanceof LeaseError) throw error;
      throw new LeaseError('ERR_BRIDGE_LEASE_LOCK', 'lock file cannot be opened safely', { cause: error });
    });
    await checkLock(lock, work(() => io.lstat(owner.lockPath)), work);
    let exitCode: number;
    try { exitCode = await owner.flock(lock.fd); }
    catch (error) {
      if (error instanceof LeaseError) throw error;
      throw new LeaseError('ERR_BRIDGE_LEASE_FLOCK', 'flock helper failed before granting the lease', { cause: error });
    }
    if (exitCode === 75) throw new LeaseError('ERR_BRIDGE_LEASE_CONFLICT', 'socket lease is held by another process');
    if (exitCode !== 0) throw new LeaseError('ERR_BRIDGE_LEASE_FLOCK', `flock helper exited with status ${exitCode}`);
    const initial = await work(() => io.lstat(socketPath)).then((stat) => stat, (error: unknown) => {
      if (error instanceof LeaseError) throw error;
      if (codeOf(error) === 'ENOENT') return null;
      throw stateError('socket path cannot be inspected', error);
    });
    owner.check();
    if (initial !== null) {
      if (!initial.isSocket() || initial.uid !== euid()) throw stateError('socket path exists and is not an euid-owned socket');
      const probeError = await work(() => io.probe(socketPath)).then(() => null, (error: unknown) => error);
      owner.check();
      if (probeError === null) throw stateError('socket has a live listener');
      if (codeOf(probeError) !== 'ECONNREFUSED') throw stateError('socket probe did not prove a stale listener', probeError);
      const recheck = await work(() => io.lstat(socketPath)).then((stat) => stat, (error: unknown) => {
        if (error instanceof LeaseError) throw error;
        if (codeOf(error) === 'ENOENT') return null;
        throw stateError('socket path cannot be reinspected', error);
      });
      if (recheck === null || !recheck.isSocket() || recheck.uid !== euid()
        || recheck.dev !== initial.dev || recheck.ino !== initial.ino) {
        throw stateError('socket identity drifted between probe and reclaim');
      }
      await work(() => io.unlink(socketPath)).catch((error: unknown) => {
        if (error instanceof LeaseError) throw error;
        throw stateError('stale socket cannot be unlinked', error);
      });
    }
    parentGid = await recheckParentDirectory(socketPath, socketAccess, work);
    try { await owner.bind(); }
    catch (error) {
      if (error instanceof LeaseError) throw error;
      throw stateError('socket bind failed', error);
    }
    owner.check();
    const bound = await work(() => io.lstat(socketPath).then((stat) => {
      if (stat.isSocket() && stat.uid === euid()) owner.recordBound(stat);
      return stat;
    })).then((stat) => stat, (error: unknown) => {
      if (error instanceof LeaseError) throw error;
      throw stateError('bound socket cannot be inspected', error);
    });
    if (!bound.isSocket() || bound.uid !== euid()) throw stateError('bound path is not an euid-owned socket');
    if (socketAccess === 'group' && bound.gid !== parentGid) {
      throw stateError('bound socket GID does not match the parent directory group');
    }
    await work(() => io.chmod(socketPath, targetMode)).catch((error: unknown) => {
      if (error instanceof LeaseError) throw error;
      throw stateError(`bound socket cannot be chmodded to 0${targetMode.toString(8)}`, error);
    });
    const verified = await work(() => io.lstat(socketPath)).then((stat) => stat, (error: unknown) => {
      if (error instanceof LeaseError) throw error;
      throw stateError('bound socket cannot be re-inspected after chmod', error);
    });
    if (!verified.isSocket() || verified.dev !== bound.dev || verified.ino !== bound.ino
      || verified.uid !== euid() || (verified.mode & 0o777) !== targetMode) {
      throw stateError('bound socket identity or mode verification failed');
    }
    if (socketAccess === 'group' && verified.gid !== parentGid) {
      throw stateError('bound socket GID drifted from the parent directory group after chmod');
    }
    owner.check();
    return owner;
  } catch (error) {
    await owner.dispose();
    if (error instanceof LeaseError) throw error;
    throw stateError('socket lease acquisition failed', error);
  }
}

export async function dispose(lease: SocketLease): Promise<void> { await lease.dispose(); }
