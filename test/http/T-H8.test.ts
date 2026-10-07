import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { makeRuntime, startBridge } from './helpers.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

function acceptFor(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

interface RawUpstream {
  readonly port: number;
  readonly requests: Buffer[];
  readonly closed: boolean[];
  readonly respond: (socket: Socket, bytes: string | Buffer) => void;
  readonly close: () => Promise<void>;
}

/** Raw TCP WS upstream stub; the responder controls the exact wire bytes. */
async function startRawUpstream(responder: (socket: Socket, requestHead: Buffer, reply: (bytes: string | Buffer) => void) => void): Promise<RawUpstream> {
  const requests: Buffer[] = [];
  const closed: boolean[] = [];
  const server = createTcpServer((socket) => {
    const chunks: Buffer[] = [];
    const reply = (bytes: string | Buffer): void => {
      socket.write(bytes);
    };
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const end = buffer.indexOf('\r\n\r\n');
      if (end >= 0 && requests.length === 0) {
        requests.push(buffer.subarray(0, end + 4));
        responder(socket, buffer.subarray(0, end + 4), reply);
      } else if (requests.length > 0) {
        requests.push(chunk);
      }
    });
    socket.on('close', () => closed.push(true));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    closed,
    respond: (socket, bytes) => socket.write(bytes),
    close: async () => {
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}

function handshakeRequest(extra?: { path?: string; key?: string; version?: string; method?: string; extraHeaders?: string }): string {
  return `${extra?.method ?? 'GET'} ${extra?.path ?? '/ws'} HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${extra?.key ?? KEY}\r\nSec-WebSocket-Version: ${extra?.version ?? '13'}\r\n${extra?.extraHeaders ?? ''}\r\n`;
}

async function rawWsRoundTrip(bridgePort: number, bytes: string, waitMs = 300): Promise<Buffer> {
  const socket = connect({ host: '127.0.0.1', port: bridgePort });
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await once(socket, 'connect');
  socket.write(bytes);
  await Promise.race([once(socket, 'close'), new Promise((resolve) => setTimeout(resolve, waitMs))]);
  socket.destroy();
  return Buffer.concat(chunks);
}

describe('T-H8 WebSocket stub matrix (no fabricated DSH route)', () => {
  test('malformed handshakes are 400 with zero upstream connections', async () => {
    // Given a bridge whose upstream counts connections
    let connections = 0;
    const counter = createTcpServer((socket) => {
      connections++;
      socket.destroy();
    });
    counter.listen(0, '127.0.0.1');
    await once(counter, 'listening');
    const bridge = await startBridge(makeRuntime((counter.address() as AddressInfo).port));
    try {
      // When the handshake is malformed in each pinned way
      const cases = [
        handshakeRequest({ method: 'POST' }),
        handshakeRequest({ version: '12' }),
        handshakeRequest({ key: '!!!!' }),
        handshakeRequest({ key: 'AAAA' }),
        `GET /ws HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        `GET /ws HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\nContent-Length: 5\r\n\r\n`,
      ];
      // Then each is refused 400 and none reached upstream
      for (const bytes of cases) {
        const raw = await rawWsRoundTrip(bridge.port, bytes);
        assert.match(raw.toString('latin1'), /^HTTP\/1\.1 400/, JSON.stringify(bytes));
      }
      assert.equal(connections, 0);
    } finally {
      await bridge.close();
      counter.close();
    }
  });

  test('non-WebSocket upgrade is 501 with zero upstream connections', async () => {
    // Given an h2c upgrade attempt
    const counter = createTcpServer((socket) => socket.destroy());
    counter.listen(0, '127.0.0.1');
    await once(counter, 'listening');
    const bridge = await startBridge(makeRuntime((counter.address() as AddressInfo).port));
    try {
      // When the upgrade token is not websocket
      const raw = await rawWsRoundTrip(bridge.port,
        'GET / HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n');
      // Then it is refused 501
      assert.match(raw.toString('latin1'), /^HTTP\/1\.1 501/);
    } finally {
      await bridge.close();
      counter.close();
    }
  });

  test('wrong upstream Sec-WebSocket-Accept yields 502 before commit and destroys the upstream socket', async () => {
    // Given an upstream answering 101 with a forged accept value
    const upstream = await startRawUpstream((socket, _head, reply) => {
      reply(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor('wrong')}\r\n\r\n`);
      setTimeout(() => socket.destroy(), 500);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the handshake is proxied
      const raw = await rawWsRoundTrip(bridge.port, handshakeRequest());
      // Then the bridge refused the invalid 101 with 502 and tore the upstream side down
      assert.match(raw.toString('latin1'), /^HTTP\/1\.1 502/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(upstream.closed.length > 0, 'upstream socket must be destroyed');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('unoffered protocol, double protocol, or unrequested extension in the 101 are refused with 502', async () => {
    // Given a client offering one protocol and one extension
    const offer = handshakeRequest({ extraHeaders: 'Sec-WebSocket-Protocol: chat\r\nSec-WebSocket-Extensions: permessage-deflate; x=1\r\n' });
    const badReplies = [
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(KEY)}\r\nSec-WebSocket-Protocol: smtp\r\n\r\n`,
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(KEY)}\r\nSec-WebSocket-Protocol: chat, extra\r\n\r\n`,
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(KEY)}\r\nSec-WebSocket-Extensions: x-unknown-ext\r\n\r\n`,
    ];
    // When upstream answers each invalid 101
    for (const reply of badReplies) {
      const upstream = await startRawUpstream((socket, _head, respond) => {
        respond(reply);
        setTimeout(() => socket.destroy(), 500);
      });
      const bridge = await startBridge(makeRuntime(upstream.port));
      try {
        // Then the bridge refuses with 502
        const raw = await rawWsRoundTrip(bridge.port, offer);
        assert.match(raw.toString('latin1'), /^HTTP\/1\.1 502/, reply);
      } finally {
        await bridge.close();
        await upstream.close();
      }
    }
  });

  test('valid handshake relays both heads exactly once and then echoes bidirectionally', async () => {
    // Given an upstream that completes the handshake, notes byte order, and echoes
    const upstreamOrder: string[] = [];
    const upstream = await startRawUpstream((socket, _head, reply) => {
      reply(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(KEY)}\r\nSec-WebSocket-Protocol: chat\r\n\r\n`);
      reply(Buffer.from('UPSTREAM-HEAD'));
      socket.on('data', (chunk: Buffer) => {
        upstreamOrder.push(chunk.toString('latin1'));
        socket.write(Buffer.from(`echo:${chunk.toString('latin1')}`));
      });
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    const received: Buffer[] = [];
    try {
      // When the client pipelines early bytes with the handshake and later writes more
      await once(socket, 'connect');
      socket.write(handshakeRequest({ extraHeaders: 'Sec-WebSocket-Protocol: chat\r\n' }) + 'CLIENT-HEAD');
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      await new Promise((resolve) => setTimeout(resolve, 200));
      socket.write('FRAME-2');
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Then the client saw the 101 head then the upstream head then echoes
      const text = Buffer.concat(received).toString('latin1');
      assert.match(text, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
      assert.ok(text.includes('Sec-WebSocket-Protocol: chat'));
      const upstreamHeadAt = text.indexOf('UPSTREAM-HEAD');
      assert.ok(upstreamHeadAt > text.indexOf('\r\n\r\n'), 'upstream head must follow the 101 head');
      assert.ok(text.includes('echo:FRAME-2'));
      // And the upstream saw the client head exactly once, before later frames
      assert.deepEqual(upstreamOrder[0], 'CLIENT-HEAD');
      assert.equal(upstreamOrder.filter((chunk) => chunk === 'CLIENT-HEAD').length, 1);
      assert.ok(upstreamOrder.some((chunk) => chunk === 'FRAME-2'));
    } finally {
      socket.destroy();
      await bridge.close();
      await upstream.close();
    }
  });

  test('non-101 upstream response uses the close-delimited serializer', async () => {
    // Given an upstream answering the upgrade with a chunked gzip 200
    const compressed = gzipSync('denied-payload');
    const upstream = await startRawUpstream((socket, _head, reply) => {
      reply(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\nSet-Cookie: dsh-auth-x=v; Path=/\r\n\r\n${compressed.length.toString(16)}\r\n`);
      reply(compressed);
      setTimeout(() => reply('\r\n0\r\n\r\n'), 50);
      setTimeout(() => socket.end(), 150);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the client upgrades
      const raw = await rawWsRoundTrip(bridge.port, handshakeRequest(), 600);
      const text = raw.toString('latin1');
      // Then the denial is serialized close-delimited: no TE/CL/Trailer, Connection: close, gzip preserved
      assert.match(text, /^HTTP\/1\.1 200/);
      assert.match(text, /\r\nConnection: close\r\n/i);
      assert.equal(/transfer-encoding:/i.test(text.slice(0, text.indexOf('\r\n\r\n'))), false);
      assert.equal(/content-length:/i.test(text.slice(0, text.indexOf('\r\n\r\n'))), false);
      assert.match(text.slice(0, text.indexOf('\r\n\r\n')), /Content-Encoding: gzip/i);
      assert.match(text.slice(0, text.indexOf('\r\n\r\n')), /dsh-auth-x=v; Path=\/; Secure/);
      const body = raw.subarray(raw.indexOf('\r\n\r\n') + 4);
      assert.deepEqual(body, compressed);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('non-101 HEAD/204/304 responses carry no body', async () => {
    // Given upstreams answering 204 and 304 to the upgrade request
    const replies = [
      'HTTP/1.1 204 No Content\r\nContent-Length: 9\r\nX-Meta: a\r\n\r\n',
      'HTTP/1.1 304 Not Modified\r\nETag: "v1"\r\n\r\n',
    ];
    for (const reply of replies) {
      const upstream = await startRawUpstream((socket, _head, respond) => {
        respond(reply);
        setTimeout(() => socket.destroy(), 300);
      });
      const bridge = await startBridge(makeRuntime(upstream.port));
      try {
        // When the denial is relayed
        const raw = await rawWsRoundTrip(bridge.port, handshakeRequest(), 500);
        const text = raw.toString('latin1');
        // Then no body follows the head and the connection closes
        assert.ok(text.startsWith(reply.slice(0, reply.indexOf('\r\n'))), text);
        assert.ok(!text.includes('\r\n\r\n ') && !raw.subarray(raw.indexOf('\r\n\r\n') + 4).length,
          `unexpected body bytes: ${JSON.stringify(text)}`);
      } finally {
        await bridge.close();
        await upstream.close();
      }
    }
  });
});
