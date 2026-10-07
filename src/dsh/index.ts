import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { acquire } from '../lib/socket.js';
import { handleCheckContinue, handleRequest, handleUpgrade, type BridgeRuntime } from '../lib/bridge.js';

export const name = '@zapsaang/dsh-web-bridge';
export const inject = ['connection', 'webServer', 'webRuntime'];

export interface Config {
  readonly socketPath: string;
  readonly authorities: readonly string[];
}

const fields = z.object({
  socketPath: z.string().default('/run/dsh-web/session-bridge.sock'),
  authorities: z.array(z.string().max(253).pattern(
    /^(?![0-9]+(?:\.[0-9]+){3}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
  ).required()).min(1).required(),
});

export const Config: Schemastery<{
  readonly socketPath?: string | null;
  readonly authorities?: string[] | null;
}, Config> = z.transform(fields, (value): Config => {
  if (Object.keys(value).some((key) => key !== 'socketPath' && key !== 'authorities')) {
    throw new z.ValidationError('Unexpected bridge configuration key.', {});
  }
  return {
    socketPath: value.socketPath ?? '/run/dsh-web/session-bridge.sock',
    authorities: value.authorities ?? [],
  };
});

export class BridgeNotImplementedError extends Error {
  readonly code = 'ERR_BRIDGE_NOT_IMPLEMENTED';
  constructor() {
    super('Bridge behavior is not implemented.');
    this.name = 'BridgeNotImplementedError';
  }
}

export class BridgeLoopbackGuardError extends Error {
  readonly code = 'ERR_BRIDGE_LOOPBACK_GUARD';
  constructor() {
    super('dsh web bridge requires the dsh web server bound to 127.0.0.1 with a valid bound port.');
    this.name = 'BridgeLoopbackGuardError';
  }
}

export class BridgeAuthorityTrustError extends Error {
  readonly code = 'ERR_BRIDGE_AUTHORITY_TRUST';
  constructor() {
    super('dsh web bridge authorities must be bare public names accepted by the web runtime trustedHosts.');
    this.name = 'BridgeAuthorityTrustError';
  }
}

interface WebServerView {
  host: unknown;
  port: unknown;
}

interface WebRuntimeView {
  trustedHosts: unknown;
}

// §12.1: fail closed unless every configured authority is a bare (port-less)
// entry of the ACTIVE web runtime trustedHosts; CLI extras stay native-only
// and never widen the bridge authority set.
function assertAuthorityTrust(ctx: Context, authorities: readonly string[]): void {
  const value: unknown = ctx.get('webRuntime');
  const view = (typeof value === 'object' && value !== null ? value : {}) as Partial<WebRuntimeView>;
  const trusted = view.trustedHosts;
  if (!Array.isArray(trusted) || !trusted.every((entry) => typeof entry === 'string')) {
    throw new BridgeAuthorityTrustError();
  }
  const bare = new Set(trusted.filter((entry) => !entry.includes(':')).map((entry) => entry.toLowerCase()));
  if (!authorities.every((authority) => bare.has(authority))) throw new BridgeAuthorityTrustError();
}

interface ConnectionView {
  authenticatedUrl: (baseUrl: string) => string;
}

// §6.1: delegate to the ACTIVE connection service; a missing factory fails
// closed as an exchange 'factory' failure, never as a synthesized token.
function connectionUrlFactory(ctx: Context): (baseUrl: string) => string {
  const value: unknown = ctx.get('connection');
  const view = (typeof value === 'object' && value !== null ? value : {}) as Partial<ConnectionView>;
  const factory = view.authenticatedUrl;
  return (baseUrl: string): string => {
    if (typeof factory !== 'function') throw new BridgeNotImplementedError();
    return factory.call(view, baseUrl);
  };
}

function loopbackPort(ctx: Context): number {
  const value: unknown = ctx.get('webServer');
  const view = (typeof value === 'object' && value !== null ? value : {}) as WebServerView;
  const { host, port } = view;
  if (
    host !== '127.0.0.1'
    || typeof port !== 'number'
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
  ) {
    throw new BridgeLoopbackGuardError();
  }
  return port;
}

// §13.2: readiness is the awaited apply itself — the returned promise settles
// only after acquire() has bound the listener and verified its mode, so an
// ACTIVE fiber implies a checked listener. The returned disposer is awaited
// on unload.
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const port = loopbackPort(ctx);
  assertAuthorityTrust(ctx, config.authorities);
  const server = createServer();
  const controller = new AbortController();
  const runtime: BridgeRuntime = {
    endpoint: {
      port,
      authenticatedUrl: connectionUrlFactory(ctx),
    },
    authorities: config.authorities,
    signal: controller.signal,
  };
  const destroy = (request: IncomingMessage, response: ServerResponse): void => {
    request.destroy();
    response.destroy();
  };
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, runtime).catch(() => destroy(request, response));
  });
  server.on('checkContinue', (request: IncomingMessage, response: ServerResponse) => {
    void handleCheckContinue(request, response, runtime).catch(() => destroy(request, response));
  });
  server.on('checkExpectation', (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, runtime).catch(() => destroy(request, response));
  });
  server.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => {
    try {
      handleUpgrade(request, socket, head, runtime);
    } catch {
      socket.destroy();
    }
  });
  const lease = await acquire(config.socketPath, server, controller.signal);
  return async () => {
    controller.abort();
    await lease.dispose();
  };
}
