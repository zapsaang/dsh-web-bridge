import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import type { Credentials, Job, Reply } from './socket-access-linux-process.js';

async function credentials(): Promise<Credentials> {
  const status = await readFile('/proc/self/status', 'utf8');
  const field = (name: string): string => {
    const found = status.split('\n').find(line => line.startsWith(`${name}:`));
    assert.ok(found, `Linux credential field ${name} exists`);
    return found.slice(name.length + 1).trim();
  };
  const ids = (name: string): readonly number[] => field(name).split(/\s+/).filter(Boolean).map(Number);
  return { uid: ids('Uid'), gid: ids('Gid'), groups: ids('Groups'),
    CapEff: field('CapEff'), CapPrm: field('CapPrm'), CapInh: field('CapInh'), CapAmb: field('CapAmb') };
}
function parseJob(value: unknown): Job {
  assert.ok(typeof value === 'object' && value !== null);
  assert.ok('role' in value && (value.role === 'probe' || value.role === 'service' || value.role === 'peer'));
  assert.ok('root' in value && typeof value.root === 'string');
  assert.ok('directory' in value && typeof value.directory === 'string');
  assert.ok(!('access' in value) || value.access === 'strict' || value.access === 'group');
  assert.ok(!('member' in value) || typeof value.member === 'boolean');
  return { role: value.role, root: value.root, directory: value.directory,
    ...('access' in value && (value.access === 'strict' || value.access === 'group') ? { access: value.access } : {}),
    ...('member' in value && typeof value.member === 'boolean' ? { member: value.member } : {}) };
}
function send(reply: Reply): void { process.send?.(reply); }

function call(socketPath: string, input: { readonly path: string; readonly navigation?: boolean; readonly cookie?: string }) {
  return new Promise<{ readonly status: number; readonly body: string; readonly cookies: readonly string[] }>((resolve, reject) => {
    const req = request({ socketPath, path: input.path, agent: false, signal: AbortSignal.timeout(5000),
      headers: { host: 'probe.example.test', ...(input.navigation ? {
        accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none',
      } : {}), ...(input.cookie ? { cookie: input.cookie } : {}) } }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cookies: res.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    req.end();
  });
}
const denied = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'EACCES';

process.once('message', (value: unknown) => { void run(value); });
async function run(value: unknown): Promise<void> { // no-excuse-ok: catch — worker IPC boundary, never emit secret-bearing errors
  const c = await credentials();
  let phase = 'parse-job';
  try {
    const job = parseJob(value);
    const socketPath = join(job.directory, 'bridge.sock');
    switch (job.role) {
      case 'probe': {
        phase = 'pinned-native-dependencies';
        await import('../dsh/dependencies.js');
        send({ status: 'done', credentials: c, phase, socketMode: 0, socketGid: 0 });
        process.disconnect();
        return;
      }
      case 'service': {
        phase = 'native-service-start';
        const { Harness } = await import('../dsh/harness.js');
        const { apply, Config } = await import('../../src/dsh/index.js');
        await using app = await Harness.start(join(job.root, 'home'));
        app.ctx.connection.fetch.register({ path: '/api/native-probe', methods: ['GET'], requestBody: 'buffered',
          fetch: async () => new Response('native-admitted') });
        const raw = { socketPath, authorities: ['probe.example.test'], ...(job.access ? { socketAccess: job.access } : {}) };
        phase = 'public-config-apply';
        const dispose = await apply(app.ctx, Config(raw));
        try {
          const stat = await lstat(socketPath);
          assert.ok(stat.isSocket());
          assert.equal(stat.uid, c.uid[1]);
          send({ status: 'ready', credentials: c, phase, socketMode: stat.mode & 0o777, socketGid: stat.gid });
          await new Promise<void>(resolve => process.once('message', () => resolve()));
        } finally { await dispose(); }
        send({ status: 'done', credentials: c, phase: 'disposed', socketMode: 0, socketGid: 0 });
        process.disconnect();
        return;
      }
      case 'peer': {
        phase = 'ancestor-witness';
        assert.equal(await readFile(join(job.root, 'witness'), 'utf8'), 'traversable');
        // This witness proves /, /run and the shared fixture root, not a launcher or private-HOME denial.
        if (job.member) {
          phase = 'parent-traverse-witness';
          assert.equal(await readFile(join(job.directory, 'witness'), 'utf8'), 'traversable');
          await access(job.directory, constants.X_OK);
          phase = 'parent-list-permission';
          if (((await lstat(job.directory)).mode & 0o7777) === 0o2710) {
            await assert.rejects(readdir(job.directory), denied);
          } else {
            assert.ok((await readdir(job.directory)).includes('witness'));
          }
          phase = 'native-no-cookie';
          assert.equal((await call(socketPath, { path: '/api/native-probe' })).status, 401);
          phase = 'public-navigation-bootstrap';
          const boot = await call(socketPath, { path: '/', navigation: true });
          assert.equal(boot.status, 200);
          assert.ok(boot.cookies.length === 1, 'genuine navigation issued one cookie');
          const cookie = boot.cookies[0]?.split(';', 1)[0];
          assert.ok(typeof cookie === 'string' && cookie.length > 0, 'issued cookie exists');
          phase = 'native-issued-cookie';
          const api = await call(socketPath, { path: '/api/native-probe', cookie });
          assert.equal(api.status, 200);
          assert.ok(api.body === 'native-admitted', 'native authenticated API marker');
          phase = 'member-unlink';
          await assert.rejects(unlink(socketPath), denied);
          phase = 'member-lock-open';
          await assert.rejects(open(`${socketPath}.lock`, constants.O_RDWR), denied);
        } else {
          phase = 'nonmember-connect';
          await assert.rejects(call(socketPath, { path: '/api/native-probe' }), denied);
        }
        send({ status: 'done', credentials: c, phase, socketMode: 0, socketGid: 0 });
        process.disconnect();
        return;
      }
      default: { const exhaustive: never = job.role; throw new Error(String(exhaustive)); }
    }
  } catch {
    send({ status: 'failed', credentials: c, phase, socketMode: 0, socketGid: 0 });
    process.exitCode = 1;
    process.disconnect();
  }
}
