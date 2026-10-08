import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Config } from './index.js';
import { BridgeAuthorityTrustError, BridgeLoopbackGuardError, BridgeNotImplementedError } from './errors.js';
import { acquire, cancelled, type LeaseIo, type SocketLease } from '../lib/socket.js';
import { handleCheckContinue, handleRequest, handleUpgrade, type BridgeRuntime } from '../lib/bridge.js';

function assertAuthorityTrust(ctx: Context, authorities: readonly string[]): void {
  const value: unknown = ctx.get('webRuntime');
  if (typeof value !== 'object' || value === null || !('trustedHosts' in value)) throw new BridgeAuthorityTrustError();
  const trusted: unknown = value.trustedHosts;
  if (!Array.isArray(trusted) || !trusted.every((entry: unknown): entry is string => typeof entry === 'string')) {
    throw new BridgeAuthorityTrustError();
  }
  const bare = new Set(trusted.filter((entry) => !entry.includes(':')).map((entry) => entry.toLowerCase()));
  if (!authorities.every((authority) => bare.has(authority))) throw new BridgeAuthorityTrustError();
}

function connectionUrlFactory(ctx: Context): (baseUrl: string) => string {
  const value: unknown = ctx.get('connection');
  return (baseUrl: string): string => {
    if (typeof value !== 'object' || value === null || !('authenticatedUrl' in value)
      || typeof value.authenticatedUrl !== 'function') throw new BridgeNotImplementedError();
    const result: unknown = value.authenticatedUrl.call(value, baseUrl);
    if (typeof result !== 'string') throw new BridgeNotImplementedError();
    return result;
  };
}

function loopbackPort(ctx: Context): number {
  const value: unknown = ctx.get('webServer');
  if (typeof value !== 'object' || value === null || !('host' in value) || !('port' in value)) {
    throw new BridgeLoopbackGuardError();
  }
  const { host, port } = value;
  if (host !== '127.0.0.1' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BridgeLoopbackGuardError();
  }
  return port;
}

export function makeApply(dependencies: {
  readonly io: LeaseIo;
  readonly createServer: () => Server;
}): (ctx: Context, config: Config) => Promise<() => Promise<void>> {
  return async (ctx, config) => {
    const port = loopbackPort(ctx);
    assertAuthorityTrust(ctx, config.authorities);
    const server = dependencies.createServer();
    const controller = new AbortController();
    let ready = false;
    let lease: SocketLease | undefined;
    let disposal: Promise<void> | undefined;
    const invalidate = (): void => { ready = false; controller.abort(); };
    const cleanup = (): Promise<void> => {
      invalidate();
      // A failed/pending acquire owns its own shutdown; only cache an acquired lease's disposal.
      if (lease === undefined) return Promise.resolve();
      disposal ??= lease.dispose();
      return disposal;
    };
    ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) invalidate();
    });
    ctx.effect(() => cleanup);
    const runtime: BridgeRuntime = {
      endpoint: { port, authenticatedUrl: connectionUrlFactory(ctx) },
      authorities: config.authorities,
      signal: controller.signal,
    };
    const destroy = (request: IncomingMessage, response: ServerResponse): void => {
      request.destroy();
      response.destroy();
    };
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      if (!ready) { request.socket.destroy(); return; }
      void handleRequest(request, response, runtime).catch(() => destroy(request, response));
    });
    server.on('checkContinue', (request: IncomingMessage, response: ServerResponse) => {
      if (!ready) { request.socket.destroy(); return; }
      void handleCheckContinue(request, response, runtime).catch(() => destroy(request, response));
    });
    server.on('checkExpectation', (request: IncomingMessage, response: ServerResponse) => {
      if (!ready) { request.socket.destroy(); return; }
      void handleRequest(request, response, runtime).catch(() => destroy(request, response));
    });
    server.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => {
      if (!ready) { socket.destroy(); return; }
      try { handleUpgrade(request, socket, head, runtime); }
      catch { socket.destroy(); }
    });
    lease = await acquire(config.socketPath, server, controller.signal, dependencies.io, config.socketAccess);
    if (controller.signal.aborted || ctx.fiber.uid === null) {
      await cleanup();
      throw cancelled();
    }
    ready = true;
    return cleanup;
  };
}
