import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { handleCheckContinue, handleRequest, handleUpgrade, type BridgeRuntime } from '../../src/lib/bridge.js';

export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
}

export interface Upstream {
  readonly port: number;
  readonly requests: CapturedRequest[];
  readonly close: () => Promise<void>;
}

export type UpstreamHandler = (request: IncomingMessage, response: ServerResponse, captured: CapturedRequest) => void;

export async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        rawHeaders: [...request.rawHeaders],
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      handler(request, response, captured);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}

export function makeRuntime(upstreamPort: number, overrides?: Partial<BridgeRuntime>): BridgeRuntime {
  return {
    endpoint: {
      port: upstreamPort,
      authenticatedUrl: () => {
        throw new Error('exchange is out of scope for this test');
      },
    },
    authorities: ['dsh.example.com'],
    signal: new AbortController().signal,
    ...overrides,
  };
}

export interface Bridge {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export async function startBridge(runtime: BridgeRuntime): Promise<Bridge> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime).catch(() => {
      request.destroy();
      response.destroy();
    });
  });
  server.on('checkContinue', (request: IncomingMessage, response: ServerResponse) => {
    void handleCheckContinue(request, response, runtime).catch(() => {
      request.destroy();
      response.destroy();
    });
  });
  server.on('checkExpectation', (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, runtime).catch(() => {
      request.destroy();
      response.destroy();
    });
  });
  server.on('upgrade', (request: IncomingMessage, socket, head: Buffer) => {
    try {
      handleUpgrade(request, socket, head, runtime);
    } catch {
      socket.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}

export interface RawResponse {
  readonly status: number;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
}

export function callBridge(port: number, options: {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string> | readonly string[];
  readonly body?: Buffer | string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.headers as Record<string, string>,
      setHost: options.headers === undefined,
    });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        rawHeaders: [...response.rawHeaders],
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/** Raw socket round-trip for byte/casing-level assertions; resolves on connection end. */
export function rawExchange(port: number, bytes: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(bytes));
  });
}

export function headerValue(rawHeaders: readonly string[], name: string): string | undefined {
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) return rawHeaders[index + 1];
  }
  return undefined;
}

export function headerValues(rawHeaders: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      const value = rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}
