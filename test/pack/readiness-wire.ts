import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export const authority = 'readiness.example.test';
export const token = 'readiness-launch-secret';
export const cookie = 'dsh-auth-readiness=opaque-session; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';
export type Route = 'request' | 'checkContinue' | 'checkExpectation' | 'upgrade';
export const routes: readonly Route[] = ['request', 'checkContinue', 'checkExpectation', 'upgrade'];

export function probeBytes(route: Route): string {
  switch (route) {
    case 'request': return `GET / HTTP/1.1\r\nHost: ${authority}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`;
    case 'checkContinue': return `POST /api/probe HTTP/1.1\r\nHost: ${authority}\r\nExpect: 100-continue\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    case 'checkExpectation': return `GET / HTTP/1.1\r\nHost: ${authority}\r\nExpect: bridge-probe\r\nConnection: close\r\n\r\n`;
    case 'upgrade': return `GET /ws HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    default: route satisfies never; throw new Error('unreachable route');
  }
}

/** A timeout or transport error rejects; only observed close completes a probe. */
export function rawProbe(socketPath: string, bytes: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = connect({ path: socketPath });
    const chunks: Buffer[] = [];
    client.setTimeout(1000, () => {
      client.destroy();
      reject(new Error('raw readiness probe timed out before connection close'));
    });
    client.on('connect', () => client.write(bytes));
    client.on('data', (chunk: Buffer) => chunks.push(chunk));
    client.on('error', reject);
    client.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

/** Same real wire, but keep WS alive until the 101 header has been observed. */
export function wsProbe(socketPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = connect({ path: socketPath });
    const chunks: Buffer[] = [];
    let headersObserved = false;
    client.setTimeout(1000, () => {
      client.destroy();
      reject(new Error('WS readiness control timed out'));
    });
    client.on('connect', () => client.write(probeBytes('upgrade')));
    client.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes('\r\n\r\n')) { headersObserved = true; client.destroy(); }
    });
    client.on('error', reject);
    client.on('close', () => {
      if (!headersObserved) reject(new Error('WS readiness control closed before headers'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

/** Real upstream business routes make zero-interaction assertions meaningful. */
export async function readinessUpstream() {
  const paths: string[] = [];
  const recordedHeaders: string[][] = [];
  const sockets = new Set<Socket | Duplex>();
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    recordedHeaders.push([...request.rawHeaders]);
    request.resume();
    if (request.url === `/?token=${token}`) {
      response.writeHead(303, { location: './', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'set-cookie': cookie });
      response.end();
    } else if (request.url === '/') {
      response.writeHead(401);
      response.end('authentication required');
    } else {
      response.end('readiness-api-ok');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    paths.push(request.url ?? '');
    recordedHeaders.push([...request.rawHeaders]);
    const key = request.headers['sec-websocket-key'];
    assert.equal(typeof key, 'string');
    const accept = createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return {
    port: address.port, paths, headers: recordedHeaders,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function successControls(socketPath: string, upstream: Awaited<ReturnType<typeof readinessUpstream>>) {
  const before = upstream.paths.length;
  const navigation = (await rawProbe(socketPath, probeBytes('request'))).toString('latin1');
  assert.match(navigation, /^HTTP\/1\.1 200 /);
  assert.ok(navigation.includes(`set-cookie: ${cookie}; Secure`));
  assert.equal(navigation.includes(token), false, 'launch token never reaches the browser');
  const api = (await rawProbe(socketPath, `GET /api/probe HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`)).toString('latin1');
  assert.match(api, /^HTTP\/1\.1 200 /);
  assert.ok(api.includes('readiness-api-ok'));
  assert.match((await wsProbe(socketPath)).toString('latin1'), /^HTTP\/1\.1 101 /);
  assert.deepEqual(upstream.paths.slice(before), ['/', `/?token=${token}`, '/api/probe', '/ws'],
    'NEW ready controls exercise real navigation, exchange, API and WS upstream paths');
}
