import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const identities = { service: 61001, serviceGid: 61002, peer: 61003, peerGid: 61004, group: 61010 } as const;
export type Subject = { readonly uid: number; readonly gid: number; readonly groups: readonly number[] };
export type Credentials = {
  readonly uid: readonly number[]; readonly gid: readonly number[]; readonly groups: readonly number[];
  readonly CapEff: string; readonly CapPrm: string; readonly CapInh: string; readonly CapAmb: string;
};
export type Job = {
  readonly role: 'probe' | 'service' | 'peer'; readonly root: string; readonly directory: string;
  readonly access?: 'strict' | 'group'; readonly member?: boolean;
};
export type Reply = {
  readonly status: 'ready' | 'done' | 'failed'; readonly credentials: Credentials;
  readonly phase: string; readonly socketMode: number; readonly socketGid: number;
};

function numbers(value: unknown): readonly number[] {
  assert.ok(Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isInteger(item)));
  return value;
}
export function parseReply(value: unknown): Reply {
  assert.ok(typeof value === 'object' && value !== null);
  assert.ok('status' in value && (value.status === 'ready' || value.status === 'done' || value.status === 'failed'));
  assert.ok('phase' in value && typeof value.phase === 'string');
  assert.ok('socketMode' in value && typeof value.socketMode === 'number');
  assert.ok('socketGid' in value && typeof value.socketGid === 'number');
  assert.ok('credentials' in value && typeof value.credentials === 'object' && value.credentials !== null);
  const c = value.credentials;
  assert.ok('uid' in c && 'gid' in c && 'groups' in c);
  assert.ok('CapEff' in c && typeof c.CapEff === 'string');
  assert.ok('CapPrm' in c && typeof c.CapPrm === 'string');
  assert.ok('CapInh' in c && typeof c.CapInh === 'string');
  assert.ok('CapAmb' in c && typeof c.CapAmb === 'string');
  return { status: value.status, phase: value.phase, socketMode: value.socketMode, socketGid: value.socketGid,
    credentials: { uid: numbers(c.uid), gid: numbers(c.gid), groups: numbers(c.groups),
      CapEff: c.CapEff, CapPrm: c.CapPrm, CapInh: c.CapInh, CapAmb: c.CapAmb } };
}

export function assertCredentials(actual: Credentials, expected: Subject): void {
  assert.notEqual(expected.uid, 0);
  assert.deepEqual(actual.uid, [expected.uid, expected.uid, expected.uid, expected.uid], 'real/effective/saved/fs uid');
  assert.deepEqual(actual.gid, [expected.gid, expected.gid, expected.gid, expected.gid], 'real/effective/saved/fs gid');
  assert.deepEqual([...actual.groups].sort((a, b) => a - b), [...expected.groups].sort((a, b) => a - b));
  for (const cap of [actual.CapEff, actual.CapPrm, actual.CapInh, actual.CapAmb]) {
    assert.equal(BigInt(`0x${cap}`), 0n, 'ordinary subject has no active/permitted/inheritable/ambient capabilities');
  }
  // CapBnd is deliberately not an admission condition: unused bounding power is not active DAC power.
}

export class LinuxChild implements AsyncDisposable {
  readonly process: ChildProcess;
  private readonly replies: Reply[] = [];
  private pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  private failure: Error | undefined;
  constructor(readonly subject: Subject, job: Job) {
    this.process = spawn('setpriv', [
      `--reuid=${subject.uid}`, `--regid=${subject.gid}`,
      ...(subject.groups.length ? [`--groups=${subject.groups.join(',')}`] : ['--clear-groups']),
      '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
      process.execPath, fileURLToPath(new URL('./socket-access-linux-worker.js', import.meta.url)),
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
    this.process.on('message', (value: unknown) => {
      try {
        const reply = parseReply(value);
        assertCredentials(reply.credentials, subject);
        const pending = this.pending;
        this.pending = undefined;
        if (pending) pending.resolve(reply); else this.replies.push(reply);
      } catch (error) {
        assert.ok(error instanceof Error);
        this.fail(error);
      }
    });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(`Linux worker exited: code=${code} signal=${signal}`)));
    this.process.send(job);
  }
  private fail(error: Error): void {
    this.failure = error;
    this.pending?.reject(error);
    this.pending = undefined;
  }
  async next(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return queued;
    if (this.failure) throw this.failure;
    const signal = AbortSignal.timeout(15000);
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.pending = undefined; reject(new Error('Linux worker IPC deadline exceeded')); };
      signal.addEventListener('abort', abort, { once: true });
      this.pending = { resolve: reply => { signal.removeEventListener('abort', abort); resolve(reply); },
        reject: error => { signal.removeEventListener('abort', abort); reject(error); } };
    });
  }
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>(resolve => this.process.once('exit', () => resolve()));
    this.process.kill('SIGKILL');
    await exited;
  }
}
