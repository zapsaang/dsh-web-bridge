export type SocketAccess = 'strict' | 'group';

export interface PathStat {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
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
  once(event: 'error' | 'listening', listener: (error: Error) => void): unknown;
  off(event: 'error' | 'listening', listener: (error: Error) => void): unknown;
  on?(event: 'connection', listener: (socket: Socket) => void): unknown;
  readonly listening: boolean;
  closeAllConnections?(): void;
  closeIdleConnections?(): void;
}

export interface SocketLease {
  readonly socketPath: string;
  readonly lockPath: string;
  dispose(): Promise<void>;
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

export function euid(): number { return process.geteuid?.() ?? 0; }

export function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

export function cancelled(): LeaseError {
  return new LeaseError('ERR_BRIDGE_LEASE_CANCELLED', 'socket lease startup cancelled');
}

export function stateError(message: string, cause?: unknown): LeaseError {
  return new LeaseError('ERR_BRIDGE_LEASE_STATE', message, cause === undefined ? undefined : { cause });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
import type { Socket } from 'node:net';
