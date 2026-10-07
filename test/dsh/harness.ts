import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { Connection, Credentials, Frontend, WebApp, WebServerModule } from './dependencies.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    webRuntime: import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-web-app/lib/types/index.js').WebRuntimeValues;
  }
}

export const authority = 'probe.example.test';
export const unauthorized = 'dsh web authentication required; reopen the URL printed by dsh web.\n';
export type HttpResult = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly rawHeaders: readonly string[];
  readonly body: string;
};
export type ProbeRequest = {
  readonly path?: string;
  readonly method?: string;
  readonly headers?: OutgoingHttpHeaders;
};

export function send(port: number, input: ProbeRequest = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, agent: false,
      path: input.path ?? '/', method: input.method ?? 'GET',
      headers: { host: authority, ...input.headers }, signal: AbortSignal.timeout(5000),
    }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function cookiePair(result: HttpResult): string {
  const cookies = result.headers['set-cookie'];
  // Boolean assertions avoid printing credentials even on a failed assertion.
  assert.ok(cookies?.length === 1, 'exchange must issue exactly one cookie');
  const pair = cookies[0]?.split(';', 1)[0];
  assert.ok(typeof pair === 'string' && pair.length > 0, 'cookie pair exists');
  return pair;
}

export async function temporaryHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-native-probes-'));
}

export class Harness implements AsyncDisposable {
  // Lifecycle operations must target the raw Fiber, not the ctx.plugin()
  // PromiseLike wrapper: restart() on the wrapper writes state onto the
  // wrapper while services stay registered on the raw fiber (cordis
  // 4.0.5-alpha.1 registry.ts wrapped=Object.create(fiber)); see T-DSH4b.
  private constructor(readonly ctx: Context, readonly connectionFiber: Awaited<ReturnType<Context['plugin']>>) {}

  static async start(home: string): Promise<Harness> {
    const ctx = new Context();
    try {
      await ctx.plugin(Credentials.LocalCredentialProvider, {
        path: join(home, '.credentials.yaml'), dshHome: home, watch: false,
      });
      await ctx.plugin(WebServerModule.WebServer, { host: '127.0.0.1', port: 0 });
      await ctx.plugin(WebApp, {
        printUrl: false, openBrowser: false, surfaceContext: false, trustedHosts: [authority],
      });
      const connectionFiber = await ctx.plugin({
        name: 'native-probe-connection', inject: ['credentials', 'webRuntime', 'webServer'],
        apply: (active: Context) => Connection.apply(active, { trustedHosts: active.webRuntime.trustedHosts }),
      });
      const fallback = ctx.registry.get(Frontend);
      assert.ok(fallback, 'shipped frontend fallback is registered');
      await Promise.all([...fallback.fibers].map(fiber => fiber.await()));
      return new Harness(ctx, connectionFiber);
    } catch (error) {
      await ctx.fiber.dispose();
      throw error;
    }
  }

  get port(): number { return this.ctx.webServer.port; }
  token(): string {
    const token = new URL(this.ctx.connection.authenticatedUrl(`http://127.0.0.1:${this.port}/`)).searchParams.get('token');
    assert.ok(token, 'process token exists');
    return token;
  }
  exchange(host = authority): Promise<HttpResult> {
    return send(this.port, { path: `/?token=${encodeURIComponent(this.token())}`, headers: { host } });
  }
  async reload(): Promise<void> {
    await this.connectionFiber.restart();
    const fallback = this.ctx.registry.get(Frontend);
    assert.ok(fallback);
    await Promise.all([...fallback.fibers].map(fiber => fiber.await()));
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.ctx.fiber.dispose(); }
}

export async function isolated(): Promise<Harness & AsyncDisposable> {
  const home = await temporaryHome();
  try {
    const harness = await Harness.start(home);
    const dispose = harness[Symbol.asyncDispose].bind(harness);
    harness[Symbol.asyncDispose] = async () => {
      try { await dispose(); }
      finally { await rm(home, { recursive: true, force: true }); }
    };
    return harness;
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
