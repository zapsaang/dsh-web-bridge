import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute } from 'node:path';

export interface PathStat {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  isSocket(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FlockHelper {
  readonly done: Promise<number>;
  kill(): void;
}

export interface LockHandle {
  readonly fd: number;
  stat(): Promise<PathStat>;
  close(): Promise<void>;
}

export interface LeaseIo {
  openLock(path: string): Promise<LockHandle>;
  lstat(path: string): Promise<PathStat>;
  probe(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  spawnFlock(fd: number): FlockHelper;
}

export interface LeaseServer {
  listen(path: string): unknown;
  close(callback?: (error?: Error) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  readonly listening: boolean;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
}

export class LeaseError extends Error {
  constructor(
    readonly code:
      | 'ERR_BRIDGE_LEASE_PATH'
      | 'ERR_BRIDGE_LEASE_DIRECTORY'
      | 'ERR_BRIDGE_LEASE_LOCK'
      | 'ERR_BRIDGE_LEASE_CONFLICT'
      | 'ERR_BRIDGE_LEASE_FLOCK'
      | 'ERR_BRIDGE_LEASE_STATE'
      | 'ERR_BRIDGE_LEASE_CANCELLED'
      | 'ERR_BRIDGE_DISPOSE_TIMEOUT',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LeaseError';
  }
}

/** Real filesystem/process primitives; lease behavior tests stub this seam. */
export const defaultIo: LeaseIo = {
  openLock: (path) => open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600),
  lstat,
  probe: (path) => new Promise<void>((resolve, reject) => {
    const client = connect({ path }, () => {
      client.destroy();
      resolve();
    });
    client.setTimeout(1000, () => {
      client.destroy();
      reject(Object.assign(new Error('socket probe timed out'), { code: 'ETIMEDOUT' }));
    });
    client.on('error', (error) => {
      client.destroy();
      reject(error);
    });
  }),
  unlink,
  chmod,
  spawnFlock: (fd) => {
    const helper = spawn(
      'flock',
      ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'],
      { stdio: ['ignore', 'ignore', 'pipe', fd] },
    );
    return {
      done: new Promise<number>((resolve, reject) => {
        helper.once('error', reject);
        helper.once('exit', (code, signal) => {
          if (signal !== null) reject(new Error(`flock helper killed by ${signal}`));
          else resolve(code ?? 1);
        });
      }),
      kill: () => { helper.kill('SIGKILL'); },
    };
  },
};

export interface SocketLease {
  readonly socketPath: string;
  readonly lockPath: string;
  dispose(): Promise<void>;
}

const DISPOSE_BUDGET_MS = 2000;
const FLOCK_CONFLICT_EXIT = 75;
const MAX_SOCKET_PATH_BYTES = 107;

function euid(): number {
  return process.geteuid?.() ?? 0;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function cancelled(): LeaseError {
  return new LeaseError('ERR_BRIDGE_LEASE_CANCELLED', 'socket lease startup cancelled');
}

function stateError(message: string, cause?: unknown): LeaseError {
  return new LeaseError('ERR_BRIDGE_LEASE_STATE', message, cause === undefined ? undefined : { cause });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function assertPathConstraints(socketPath: string): void {
  if (
    !isAbsolute(socketPath)
    || socketPath.includes('\0')
    || socketPath.split('/').includes('..')
    || Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES
  ) {
    throw new LeaseError(
      'ERR_BRIDGE_LEASE_PATH',
      'socket path must be absolute, NUL-free, traversal-free, and at most 107 UTF-8 bytes',
    );
  }
}

async function assertTrustedDirectory(socketPath: string): Promise<void> {
  let current = dirname(socketPath);
  const parent = await lstat(current).catch((error: unknown) => {
    throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY', 'socket parent directory is not accessible', { cause: error });
  });
  if (!parent.isDirectory() || parent.uid !== euid() || (parent.mode & 0o077) !== 0) {
    throw new LeaseError(
      'ERR_BRIDGE_LEASE_DIRECTORY',
      'socket parent directory must be euid-owned and inaccessible to group/other',
    );
  }
  while (dirname(current) !== current) {
    current = dirname(current);
    const stat = await lstat(current).catch((error: unknown) => {
      throw new LeaseError('ERR_BRIDGE_LEASE_DIRECTORY', 'socket ancestor is not accessible', { cause: error });
    });
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== euid()) || (stat.mode & 0o022) !== 0) {
      throw new LeaseError(
        'ERR_BRIDGE_LEASE_DIRECTORY',
        'socket ancestors must be root/euid-owned real directories without group/other write',
      );
    }
  }
}

async function openLockChecked(io: LeaseIo, lockPath: string): Promise<LockHandle> {
  const handle = await io.openLock(lockPath).catch((error: unknown) => {
    throw new LeaseError('ERR_BRIDGE_LEASE_LOCK', 'lock file cannot be opened safely', { cause: error });
  });
  try {
    const [viaHandle, viaPath] = await Promise.all([handle.stat(), io.lstat(lockPath)]);
    if (
      !viaHandle.isFile()
      || !viaPath.isFile()
      || viaHandle.dev !== viaPath.dev
      || viaHandle.ino !== viaPath.ino
      || viaHandle.uid !== euid()
      || (viaHandle.mode & 0o777) !== 0o600
    ) {
      throw new LeaseError(
        'ERR_BRIDGE_LEASE_LOCK',
        'lock file must be the same euid-owned regular inode with mode 0600',
      );
    }
  } catch (error) {
    await handle.close();
    if (error instanceof LeaseError) throw error;
    throw new LeaseError('ERR_BRIDGE_LEASE_LOCK', 'lock file identity check failed', { cause: error });
  }
  return handle;
}

async function closeServer(server: LeaseServer): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      server.close(() => done());
    } catch {
      done();
    }
    if (!server.listening) done();
  });
}

class LeaseImpl implements SocketLease {
  private disposePromise?: Promise<void>;

  constructor(
    readonly socketPath: string,
    readonly lockPath: string,
    private readonly server: LeaseServer,
    private readonly lock: LockHandle,
    private readonly dev: number,
    private readonly ino: number,
    private readonly io: LeaseIo,
  ) {}

  dispose(): Promise<void> {
    this.disposePromise ??= this.runDispose();
    return this.disposePromise;
  }

  private async runDispose(): Promise<void> {
    const closeProof = closeServer(this.server).then(() => true);
    const proven = await Promise.race([
      closeProof,
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), DISPOSE_BUDGET_MS);
        void closeProof.then(() => clearTimeout(timer), () => clearTimeout(timer));
      }),
    ]);
    if (!proven) {
      throw new LeaseError(
        'ERR_BRIDGE_DISPOSE_TIMEOUT',
        'cannot prove the listener closed within 2s; the lease is retained',
      );
    }
    let residualError: unknown;
    try {
      const residual = await this.io.lstat(this.socketPath).then(
        (stat) => stat,
        (error: unknown) => (codeOf(error) === 'ENOENT' ? null : Promise.reject(error)),
      );
      if (
        residual
        && residual.isSocket()
        && residual.uid === euid()
        && residual.dev === this.dev
        && residual.ino === this.ino
      ) {
        await this.io.unlink(this.socketPath);
      }
    } catch (error) {
      residualError = error;
    }
    await this.lock.close();
    if (residualError !== undefined) throw residualError;
  }
}

/** Acquire stable flock inode before socket mutations; bind/mode checks (§9). */
export async function acquire(
  socketPath: string,
  server: LeaseServer,
  signal: AbortSignal,
  io: LeaseIo = defaultIo,
): Promise<SocketLease> {
  assertPathConstraints(socketPath);
  throwIfAborted(signal);
  await assertTrustedDirectory(socketPath);

  const lockPath = `${socketPath}.lock`;
  let lock: LockHandle | undefined;
  let helper: FlockHelper | undefined;
  let helperSettled = false;
  let listenAttempted = false;
  let listening = false;
  let bindWait: Promise<void> | undefined;
  try {
    lock = await openLockChecked(io, lockPath);
    throwIfAborted(signal);

    helper = io.spawnFlock(lock.fd);
    helper.done.then(
      () => { helperSettled = true; },
      () => { helperSettled = true; },
    );
    let exitCode: number;
    try {
      exitCode = await raceAbort(helper.done, signal);
    } catch (error) {
      if (error instanceof LeaseError) throw error;
      throw new LeaseError('ERR_BRIDGE_LEASE_FLOCK', 'flock helper failed before granting the lease', { cause: error });
    }
    if (exitCode === FLOCK_CONFLICT_EXIT) {
      throw new LeaseError('ERR_BRIDGE_LEASE_CONFLICT', 'socket lease is held by another process');
    }
    if (exitCode !== 0) {
      throw new LeaseError('ERR_BRIDGE_LEASE_FLOCK', `flock helper exited with status ${exitCode}`);
    }

    const initial = await io.lstat(socketPath).then(
      (stat) => stat,
      (error: unknown) => {
        if (codeOf(error) === 'ENOENT') return null;
        throw stateError('socket path cannot be inspected', error);
      },
    );
    throwIfAborted(signal);
    if (initial !== null) {
      if (!initial.isSocket() || initial.uid !== euid()) {
        throw stateError('socket path exists and is not an euid-owned socket');
      }
      const probeError = await io.probe(socketPath).then(
        () => null,
        (error: unknown) => error,
      );
      throwIfAborted(signal);
      if (probeError === null) throw stateError('socket has a live listener');
      if (codeOf(probeError) !== 'ECONNREFUSED') {
        throw stateError('socket probe did not prove a stale listener', probeError);
      }
      const recheck = await io.lstat(socketPath).then(
        (stat) => stat,
        (error: unknown) => {
          if (codeOf(error) === 'ENOENT') return null;
          throw stateError('socket path cannot be reinspected', error);
        },
      );
      if (
        recheck === null
        || !recheck.isSocket()
        || recheck.uid !== euid()
        || recheck.dev !== initial.dev
        || recheck.ino !== initial.ino
      ) {
        throw stateError('socket identity drifted between probe and reclaim');
      }
      await io.unlink(socketPath).catch((error: unknown) => {
        throw stateError('stale socket cannot be unlinked', error);
      });
    }

    bindWait = new Promise<void>((resolve, reject) => {
      server.once('listening', () => {
        listening = true;
        resolve();
      });
      server.once('error', (error: Error) => {
        reject(error);
      });
    });
    bindWait.catch(() => undefined);
    listenAttempted = true;
    server.listen(socketPath);
    try {
      await raceAbort(bindWait, signal);
    } catch (error) {
      if (error instanceof LeaseError) throw error;
      throw stateError('socket bind failed', error);
    }
    throwIfAborted(signal);

    const bound = await io.lstat(socketPath).then(
      (stat) => stat,
      (error: unknown) => {
        throw stateError('bound socket cannot be inspected', error);
      },
    );
    if (!bound.isSocket() || bound.uid !== euid()) {
      throw stateError('bound path is not an euid-owned socket');
    }
    await io.chmod(socketPath, 0o600).catch((error: unknown) => {
      throw stateError('bound socket cannot be chmodded to 0600', error);
    });
    const verified = await io.lstat(socketPath).then(
      (stat) => stat,
      (error: unknown) => {
        throw stateError('bound socket cannot be re-inspected after chmod', error);
      },
    );
    if (
      !verified.isSocket()
      || verified.dev !== bound.dev
      || verified.ino !== bound.ino
      || (verified.mode & 0o777) !== 0o600
    ) {
      throw stateError('bound socket identity or mode verification failed');
    }
    throwIfAborted(signal);

    return new LeaseImpl(socketPath, lockPath, server, lock, bound.dev, bound.ino, io);
  } catch (error) {
    if (listenAttempted) {
      await bindWait?.then(
        () => undefined,
        () => undefined,
      );
      if (listening) await closeServer(server);
    }
    if (helper !== undefined && !helperSettled) {
      helper.kill();
      await helper.done.then(
        () => undefined,
        () => undefined,
      );
    }
    if (lock !== undefined) await lock.close();
    if (error instanceof LeaseError) throw error;
    throw stateError('socket lease acquisition failed', error);
  }
}

/** Idempotent shutdown; retain lease unless full closure is proven within 2s. */
export async function dispose(lease: SocketLease): Promise<void> {
  await lease.dispose();
}
