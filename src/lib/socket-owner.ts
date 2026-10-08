import type { Socket } from 'node:net';
import { normalize } from 'node:path';
import { codeOf, euid, LeaseError, raceAbort, stateError, throwIfAborted,
  type FlockHelper, type LeaseIo, type LeaseServer, type LockHandle, type PathStat, type SocketLease } from './socket-types.js';

// These references intentionally survive rejected acquire/dispose and GC.
const owners = new Set<ShutdownOwner>();
const terminalBindCodes = new Set(['EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL',
  'ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG', 'ENOMEM', 'ENOBUFS', 'EMFILE', 'ENFILE', 'EROFS']);
type ListenerState = 'unattempted' | 'pending' | 'failed' | 'uncertain' | 'established';

export class ShutdownOwner implements SocketLease {
  readonly lockPath: string;
  private readonly registryPath: string;
  readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly inbound = new Map<Socket, Promise<void>>();
  private lock?: LockHandle;
  private helper?: FlockHelper;
  private helperSettled = true;
  private listener: ListenerState = 'unattempted';
  private identity?: PathStat;
  private closeProof?: Promise<void>;
  private terminal?: Promise<void>;
  private rejectTerminal?: (error: LeaseError) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = Infinity;
  private quarantined = false;
  private readonly onAbort = () => { void this.dispose(); };

  constructor(readonly socketPath: string, private readonly server: LeaseServer,
    private readonly dependencies: { readonly io: LeaseIo; readonly signal: AbortSignal }) {
    this.registryPath = normalize(socketPath);
    if ([...owners].some((owner) => owner.registryPath === this.registryPath && owner.quarantined)) {
      throw stateError('socket path is quarantined until process exit');
    }
    this.lockPath = `${socketPath}.lock`;
    owners.add(this);
    server.on?.('connection', (socket) => {
      const closed = new Promise<void>((resolve) => socket.once('close', () => {
        this.inbound.delete(socket);
        resolve();
      }));
      this.inbound.set(socket, closed);
      if (this.controller.signal.aborted) socket.destroy();
    });
    dependencies.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  check(): void { throwIfAborted(this.controller.signal); }

  private observe<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  step<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    const settlement = Promise.withResolvers<T>();
    const tracked = this.observe(settlement.promise);
    try { settlement.resolve(operation()); }
    catch (error) { settlement.reject(error); }
    return raceAbort(tracked, this.controller.signal);
  }

  openLock(): Promise<LockHandle> {
    return this.step(() => this.dependencies.io.openLock(this.lockPath).then((handle) => {
      this.lock = handle;
      return handle;
    }));
  }

  flock(fd: number): Promise<number> {
    this.check();
    this.helperSettled = false;
    const settlement = Promise.withResolvers<number>();
    const done = this.observe(settlement.promise);
    void done.then(() => this.reaped(), () => this.reaped());
    try {
      this.helper = this.dependencies.io.spawnFlock(fd);
      settlement.resolve(this.helper.done);
      if (this.controller.signal.aborted) this.helper.kill();
    } catch (error) {
      settlement.reject(error);
      if (this.controller.signal.aborted) this.quarantine(stateError('flock helper could not be stopped', error));
    }
    return raceAbort(done, this.controller.signal);
  }

  private reaped(): void {
    this.helperSettled = true;
    this.startClose();
  }

  bind(): Promise<void> {
    this.check();
    this.listener = 'pending';
    const settlement = Promise.withResolvers<void>();
    const bound = this.observe(settlement.promise);
    const { resolve, reject } = settlement;
    const listening = () => {
      this.server.off('error', failed);
      this.listener = 'established';
      resolve();
      this.startClose();
    };
    const failed = (error: Error) => {
      // Only a native listen syscall's terminal error proves no late listener.
      const terminalBindFailure = 'syscall' in error && error.syscall === 'listen'
        && terminalBindCodes.has(codeOf(error) ?? '');
      this.listener = terminalBindFailure ? 'failed' : 'uncertain';
      if (terminalBindFailure) this.server.off('listening', listening);
      reject(error);
      this.startClose();
    };
    this.server.once('listening', listening);
    this.server.once('error', failed);
    try { this.server.listen(this.socketPath); }
    catch (error) {
      this.server.off('error', failed);
      this.listener = 'uncertain';
      reject(error);
    }
    return raceAbort(bound, this.controller.signal);
  }

  recordBound(stat: PathStat): void { this.identity = stat; }

  dispose(): Promise<void> {
    if (this.terminal !== undefined) return this.terminal;
    const terminal = Promise.withResolvers<void>();
    this.terminal = terminal.promise;
    this.rejectTerminal = terminal.reject;
    // Observe the result even when an abort precedes acquire's catch/disposer.
    void Promise.allSettled([terminal.promise]);
    this.deadline = performance.now() + 2000;
    this.timer = setTimeout(() => this.timeout(), 2000);
    this.controller.abort();
    for (const socket of this.inbound.keys()) socket.destroy();
    try { if (!this.helperSettled) this.helper?.kill(); }
    catch (error) { this.quarantine(stateError('flock helper could not be stopped', error)); }
    this.startClose();
    void this.finish().then(() => {
      if (!this.canRelease()) return;
      clearTimeout(this.timer);
      this.dependencies.signal.removeEventListener('abort', this.onAbort);
      owners.delete(this);
      terminal.resolve();
    }, (error: unknown) => this.quarantine(error instanceof LeaseError ? error : stateError('socket shutdown failed', error)));
    return terminal.promise;
  }

  private quarantine(error: LeaseError): void {
    if (this.quarantined) return;
    this.quarantined = true;
    clearTimeout(this.timer);
    this.rejectTerminal?.(error);
  }

  private timeout(): void {
    this.quarantine(new LeaseError('ERR_BRIDGE_DISPOSE_TIMEOUT',
      'cannot prove shutdown within 2s from intent; the owner is quarantined'));
  }

  private canRelease(): boolean {
    if (performance.now() >= this.deadline) this.timeout();
    return !this.quarantined;
  }

  private startClose(): void {
    if (!this.controller.signal.aborted || !this.helperSettled || this.closeProof !== undefined) return;
    switch (this.listener) {
      case 'unattempted':
      case 'pending':
      case 'failed': return;
      case 'uncertain':
      case 'established': break;
      default: this.listener satisfies never;
    }
    const proof = Promise.withResolvers<void>();
    this.closeProof = proof.promise;
    void proof.promise.then(undefined, (error: unknown) => this.quarantine(stateError('native listener close failed', error)));
    try {
      this.server.close((error) => error === undefined ? proof.resolve() : proof.reject(error));
    } catch (error) { proof.reject(error); }
  }

  private async finish(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    this.startClose();
    await this.closeProof;
    while (this.inbound.size > 0) await Promise.all(this.inbound.values());
    if (!this.canRelease()) return;
    const io = this.dependencies.io;
    const identity = this.identity;
    if (identity !== undefined) {
      const residual = await this.observe(io.lstat(this.socketPath)).then((stat) => stat, (error: unknown) => {
        if (codeOf(error) === 'ENOENT') return null;
        throw stateError('residual socket cannot be inspected', error);
      });
      if (!this.canRelease()) return;
      if (residual !== null && residual.isSocket() && residual.uid === euid()
        && residual.dev === identity.dev && residual.ino === identity.ino) {
        await this.observe(io.unlink(this.socketPath));
      }
    }
    if (!this.canRelease()) return;
    if (this.lock !== undefined) await this.observe(this.lock.close());
  }
}
