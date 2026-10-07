import type { LeaseIo, PathStat, FlockHelper, LockHandle } from '../../src/lib/socket.js';

export function fakeStat(fields: {
  kind: 'socket' | 'file' | 'dir';
  dev?: number;
  ino?: number;
  uid?: number;
  mode?: number;
}): PathStat {
  return {
    dev: fields.dev ?? 1,
    ino: fields.ino ?? 1,
    uid: fields.uid ?? process.geteuid?.() ?? 0,
    mode: fields.mode ?? 0o600,
    isSocket: () => fields.kind === 'socket',
    isFile: () => fields.kind === 'file',
    isDirectory: () => fields.kind === 'dir',
  };
}

export function enoent(): Error & { code: string } {
  return Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
}

export interface StubIo extends LeaseIo {
  readonly events: string[];
  readonly calls: { probe: number; unlink: number; chmod: number };
  settleHelper(outcome: { code?: number; error?: Error }): void;
}

export function stubIo(overrides: {
  lstat?: (path: string) => Promise<PathStat>;
  probe?: (path: string) => Promise<void>;
  helperAuto?: 'success' | 'conflict' | 'spawnError' | 'pending';
  events?: string[];
} = {}): StubIo {
  const events: string[] = overrides.events ?? [];
  const calls = { probe: 0, unlink: 0, chmod: 0 };
  let settle: ((outcome: { code?: number; error?: Error }) => void) | undefined;
  const io: StubIo = {
    events,
    calls,
    settleHelper: (outcome) => settle?.(outcome),
    openLock: async () => {
      events.push('lock-open');
      const handle: LockHandle = {
        fd: 3,
        stat: async () => fakeStat({ kind: 'file', mode: 0o600 }),
        close: async () => { events.push('lock-close'); },
      };
      return handle;
    },
    lstat: async (path) => {
      if (path.endsWith('.lock')) return fakeStat({ kind: 'file', mode: 0o600 });
      if (overrides.lstat) return overrides.lstat(path);
      throw enoent();
    },
    probe: async (path) => {
      calls.probe += 1;
      await (overrides.probe ?? (async () => { throw enoent(); }))(path);
    },
    unlink: async () => { calls.unlink += 1; events.push('unlink'); },
    chmod: async () => { calls.chmod += 1; },
    spawnFlock: () => {
      events.push('flock-spawn');
      const mode = overrides.helperAuto ?? 'success';
      if (mode === 'spawnError') {
        events.push('flock-error');
        return {
          done: Promise.reject(Object.assign(new Error('spawn flock ENOENT'), { code: 'ENOENT' })),
          kill: () => { events.push('flock-kill'); },
        };
      }
      let resolveDone!: (code: number) => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<number>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      settle = ({ code, error }) => {
        events.push('flock-reap');
        if (error) rejectDone(error);
        else resolveDone(code ?? 0);
      };
      if (mode === 'success') queueMicrotask(() => settle?.({ code: 0 }));
      if (mode === 'conflict') queueMicrotask(() => settle?.({ code: 75 }));
      return { done, kill: () => { events.push('flock-kill'); queueMicrotask(() => settle?.({ code: 137 })); } };
    },
  };
  return io;
}
