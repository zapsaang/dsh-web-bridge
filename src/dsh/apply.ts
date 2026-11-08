import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Config } from './index.js';
import { BridgeAuthorityTrustError, BridgeLoopbackGuardError, BridgeNotImplementedError } from './errors.js';
import { acquire, cancelled, type LeaseIo, type SocketLease } from '../lib/socket.js';
import { isAuthorityTrusted, parseAuthority } from '../lib/authority.js';
import { handleCheckContinue, handleRequest, handleUpgrade, type BridgeRuntime } from '../lib/bridge.js';

// As of dsh 0.2.1-rc.2 the web-runtime row no longer owns trustedHosts: the
// connection row is the one that applies the Host/Origin fence and holds the
// active authority list. The field is private to HostConnectionService, so this
// check reads it structurally (like the previous webRuntime.trustedHosts
// anchor) and fails closed when it is absent or not a string list.
function readTrustedHosts(ctx: Context): readonly string[] {
  const value: unknown = ctx.get('connection');
  if (typeof value !== 'object' || value === null || !('trustedHosts' in value)) throw new BridgeAuthorityTrustError();
  const trusted: unknown = value.trustedHosts;
  if (!Array.isArray(trusted) || !trusted.every((entry: unknown): entry is string => typeof entry === 'string')) {
    throw new BridgeAuthorityTrustError();
  }
  return trusted;
}

// Mirror the /api Host fence: loopback names and the listener bind address are
// accepted by DSH without a trustedHosts entry; everything else must be covered
// by an entry that DSH would also accept for this authority (bare name matches
// any port, host:port is exact). Fails closed before any socket is created.
function assertAuthorityTrust(ctx: Context, authorities: readonly string[], bindHost: string): void {
  const trusted = readTrustedHosts(ctx);
  for (const candidate of authorities) {
    const authority = parseAuthority(candidate);
    if (authority === undefined || !isAuthorityTrusted(authority, trusted, bindHost)) {
      throw new BridgeAuthorityTrustError();
    }
  }
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

function webServerBinding(ctx: Context): { readonly host: string; readonly port: number } {
  const value: unknown = ctx.get('webServer');
  if (typeof value !== 'object' || value === null || !('host' in value) || !('port' in value)) {
    throw new BridgeLoopbackGuardError();
  }
  const { host, port } = value;
  if (host !== '127.0.0.1' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BridgeLoopbackGuardError();
  }
  return { host, port };
}

export function makeApply(dependencies: {
  readonly io: LeaseIo;
  readonly createServer: () => Server;
}): (ctx: Context, config: Config) => Promise<() => Promise<void>> {
  return async (ctx, config) => {
    const binding = webServerBinding(ctx);
    assertAuthorityTrust(ctx, config.authorities, binding.host);
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
      endpoint: { port: binding.port, authenticatedUrl: connectionUrlFactory(ctx) },
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
