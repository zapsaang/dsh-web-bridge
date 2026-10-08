import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Server } from 'node:http';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import { makeApply } from '../../src/dsh/apply.js';
import { Config, inject } from '../../src/dsh/index.js';
import { cleanup, tempDir } from '../lifecycle/helpers.js';
import { readinessIo, type VerificationBarrier } from './readiness-io.js';
import { authority, readinessUpstream, routes, token, type Route } from './readiness-wire.js';

export class ObservedServer extends Server {
  listenCalls = 0;
  closeCalls = 0;
  readonly arrivals: Route[] = [];
  readonly listeningObserved = Promise.withResolvers<void>();
  constructor() {
    super();
    for (const route of routes) this.on(route, () => this.arrivals.push(route));
    this.on('listening', () => this.listeningObserved.resolve());
  }
  override listen(path?: unknown): this {
    assert.equal(typeof path, 'string', 'apply uses only the approved Unix-path listen contract');
    if (typeof path !== 'string') assert.fail('unexpected non-path listen');
    this.listenCalls += 1;
    return super.listen(path);
  }
  override close(callback?: (error?: Error) => void): this {
    this.closeCalls += 1;
    return super.close(callback);
  }
}

export async function staleSocket(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import { createServer } from "node:http"; createServer().listen(process.argv[1], () => process.exit(0));', socketPath],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
}

export async function fixture(t: TestContext, options: {
  readonly stage: VerificationBarrier;
  readonly stale?: boolean;
  readonly preBind?: boolean;
  readonly disposeBeforeApplyResume?: boolean;
}) {
  const dir = await tempDir();
  const socketPath = join(dir, 'bridge.sock');
  if (options.stale) await staleSocket(socketPath);
  const upstream = await readinessUpstream();
  const ctx = new Context();
  let factoryCalls = 0;
  ctx.provide('webServer', { host: '127.0.0.1', port: upstream.port });
  ctx.provide('webRuntime', { trustedHosts: [authority] });
  ctx.provide('connection', { authenticatedUrl: (base: string) => {
    factoryCalls += 1;
    return `${base}?token=${token}`;
  } });
  const dependencies = readinessIo(socketPath, options.stage,
    options.disposeBeforeApplyResume ? () => { void fiber.dispose(); } : undefined);
  if (options.preBind) dependencies.holdOpenLock();
  const server = new ObservedServer();
  const apply = makeApply({ io: dependencies.io, createServer: () => server });
  const raw = Promise.withResolvers<Fiber>();
  const settled = Promise.withResolvers<(() => Promise<void>) | Error>();
  const events: string[] = [];
  const plugin = {
    name: 'readiness-fixture', Config, inject,
    apply: async (context: Context, config: Config) => {
      try {
        const dispose = await apply(context, config);
        events.push('apply-ready');
        settled.resolve(dispose);
        return dispose;
      } catch (error) {
        assert.ok(error instanceof Error);
        events.push('apply-rejected');
        settled.resolve(error);
        throw error;
      }
    },
  };
  ctx.on('internal/plugin', (fiber) => {
    if (fiber.runtime?.callback !== plugin.apply) return;
    if (fiber.uid !== null) raw.resolve(fiber);
    else events.push('disposal-intent');
  });
  const loading = ctx.plugin(plugin, { socketPath, authorities: [authority] });
  const fiber = await raw.promise;
  t.after(async () => {
    dependencies.release();
    const result = await settled.promise;
    if (typeof result === 'function') await result();
    await fiber.dispose();
    await ctx.fiber.dispose();
    await upstream.close();
    await cleanup(dir);
  });
  return { socketPath, ctx, fiber, loading, settled: settled.promise, events, dependencies, server, upstream,
    factoryCalls: () => factoryCalls };
}

export async function atVerification(app: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await app.dependencies.verification.entered;
  await app.server.listeningObserved.promise;
  assert.equal(app.server.listening, true, 'barrier is AFTER genuine native listening');
  assert.equal(app.server.listenCalls, 1);
}

export async function ready(app: Awaited<ReturnType<typeof fixture>>): Promise<() => Promise<void>> {
  app.dependencies.release();
  const result = await app.settled;
  assert.equal(typeof result, 'function');
  if (typeof result !== 'function') throw result;
  await app.loading;
  await app.fiber.await();
  return result;
}
