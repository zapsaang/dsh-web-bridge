import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { headerValue, makeRuntime, rawExchange, startBridge, startUpstream, callBridge } from './helpers.js';

describe('T-H7 ordinary HTTP semantics', () => {
  test('request advertising a Trailer header is 501 before any upstream connection', async () => {
    // Given a request that advertises trailers
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When it reaches the bridge (chunked upload makes the advertised trailer wire-legal)
      const response = await callBridge(bridge.port, {
        method: 'POST',
        headers: { host: 'dsh.example.com', trailer: 'x-checksum' },
        body: 'x',
      });
      // Then it is refused with 501 and zero upstream hits
      assert.equal(response.status, 501);
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('unexpected actual trailer on the upstream stream aborts both sides, never fakes success', async () => {
    // Given a raw upstream that sends an unadvertised trailer after the last chunk
    const rawUpstream = createTcpServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
      socket.write('5\r\nhello\r\n');
      setTimeout(() => socket.end('0\r\nX-Sneaky-Trailer: 1\r\n\r\n'), 50);
    });
    rawUpstream.listen(0, '127.0.0.1');
    await once(rawUpstream, 'listening');
    const upstreamPort = (rawUpstream.address() as AddressInfo).port;
    const bridge = await startBridge(makeRuntime(upstreamPort));
    try {
      // When the client reads the response
      const raw = await rawExchange(bridge.port,
        'GET /data HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: close\r\n\r\n');
      const text = raw.toString('latin1');
      // Then the body delivery was aborted, not cleanly terminated
      assert.match(text, /^HTTP\/1\.1 200/);
      assert.ok(!text.endsWith('0\r\n\r\n'), 'downstream must not see a clean chunked terminator');
    } finally {
      await bridge.close();
      rawUpstream.close();
    }
  });

  test('gzip bytes, Content-Encoding and Content-Length pass through unchanged', async () => {
    // Given an upstream serving gzip-encoded bytes with explicit Content-Length
    const compressed = gzipSync('compressed-payload-'.repeat(20));
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
      });
      response.end(compressed);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the response passes the bridge
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then encoding, length and bytes are byte-identical
      assert.equal(headerValue(response.rawHeaders, 'content-encoding'), 'gzip');
      assert.equal(headerValue(response.rawHeaders, 'content-length'), String(compressed.length));
      assert.deepEqual(response.body, compressed);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('SSE body flushes incrementally without buffering', async () => {
    // Given an upstream that emits two SSE events 200ms apart
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setTimeout(() => {
        response.write('data: second\n\n');
        response.end();
      }, 200);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the client reads the stream
      const arrivals: { at: number; chunk: string }[] = [];
      const start = Date.now();
      const socket = connect({ host: '127.0.0.1', port: bridge.port });
      await once(socket, 'connect');
      socket.write('GET /api/events HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: close\r\n\r\n');
      socket.on('data', (chunk: Buffer) => arrivals.push({ at: Date.now() - start, chunk: chunk.toString('latin1') }));
      await once(socket, 'close');
      // Then the first event arrived well before the second was sent (no store-and-forward)
      const first = arrivals.find((arrival) => arrival.chunk.includes('first'));
      const second = arrivals.find((arrival) => arrival.chunk.includes('second'));
      assert.ok(first && second, `arrivals: ${JSON.stringify(arrivals)}`);
      assert.ok(first.at < 150, `first event arrived at ${first.at}ms`);
      assert.ok(second.at >= 180, `second event arrived at ${second.at}ms`);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('Expect: 100-continue gets exactly one 100 after validation and upstream never sees Expect', async () => {
    // Given an upstream echoing a posted body
    const upstream = await startUpstream((_request, response, captured) => {
      response.writeHead(200, { 'content-length': String(captured.body.length) });
      response.end(captured.body);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    try {
      // When the client waits for the continue before sending the body
      await once(socket, 'connect');
      socket.write('POST /api/upload HTTP/1.1\r\nHost: dsh.example.com\r\nContent-Length: 4\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n');
      const chunks: Buffer[] = [];
      let continued = false;
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (!continued && chunk.toString('latin1').includes('100')) {
          continued = true;
          socket.write('body');
        }
      });
      await once(socket, 'close');
      const text = Buffer.concat(chunks).toString('latin1');
      // Then exactly one 100 preceded the final 200, and upstream got the body without Expect
      const continuCount = text.split('HTTP/1.1 100').length - 1;
      assert.equal(continuCount, 1, text);
      assert.match(text, /HTTP\/1\.1 200/);
      assert.ok(text.endsWith('body'));
      assert.equal(headerValue(upstream.requests[0]?.rawHeaders ?? [], 'expect'), undefined);
      assert.equal(upstream.requests[0]?.body.toString(), 'body');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('any other Expect value is refused with 417', async () => {
    // Given a request with an unsupported Expect
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When it reaches the bridge
      const response = await callBridge(bridge.port, {
        headers: { host: 'dsh.example.com', expect: 'magic' },
      });
      // Then it is refused with 417 and zero upstream hits
      assert.equal(response.status, 417);
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('HEAD keeps representation Content-Length without a body', async () => {
    // Given an upstream answering HEAD with representation metadata
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-length': '1234', 'content-type': 'text/html' });
      response.end();
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When a HEAD passes the bridge
      const response = await callBridge(bridge.port, { method: 'HEAD', headers: { host: 'dsh.example.com' } });
      // Then metadata survives and the body stays empty
      assert.equal(response.status, 200);
      assert.equal(headerValue(response.rawHeaders, 'content-length'), '1234');
      assert.equal(response.body.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('204 carries no body and no Content-Length', async () => {
    // Given an upstream answering 204 with a stray Content-Length
    const rawUpstream = createTcpServer((socket) => {
      socket.on('data', () => {
        socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 5\r\nConnection: close\r\n\r\n');
      });
    });
    rawUpstream.listen(0, '127.0.0.1');
    await once(rawUpstream, 'listening');
    const upstreamPort = (rawUpstream.address() as AddressInfo).port;
    const bridge = await startBridge(makeRuntime(upstreamPort));
    try {
      // When the 204 passes the bridge
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then the downstream 204 has no body and no Content-Length
      assert.equal(response.status, 204);
      assert.equal(headerValue(response.rawHeaders, 'content-length'), undefined);
      assert.equal(response.body.length, 0);
    } finally {
      await bridge.close();
      rawUpstream.close();
    }
  });

  test('304 keeps representation metadata without a body', async () => {
    // Given an upstream answering 304 with validators
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=60' });
      response.end();
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the 304 passes the bridge
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then validators survive and the body stays empty
      assert.equal(response.status, 304);
      assert.equal(headerValue(response.rawHeaders, 'etag'), '"v1"');
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'max-age=60');
      assert.equal(response.body.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('upload exceeding its deadline before commit is refused with 408', async () => {
    // Given an upstream waiting for a body that never finishes
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port, { timeouts: { upload: 100 } }));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    try {
      // When the client stalls mid-upload beyond the upload deadline
      await once(socket, 'connect');
      socket.write('POST /api/upload HTTP/1.1\r\nHost: dsh.example.com\r\nContent-Length: 1000\r\nConnection: close\r\n\r\npartial');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      await once(socket, 'close');
      // Then the bridge refused with 408 before committing anything upstream
      const text = Buffer.concat(chunks).toString('latin1');
      assert.match(text, /^HTTP\/1\.1 408/);
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('slow-reader backpressure preserves byte integrity for a large body', async () => {
    // Given an upstream serving 1 MiB of patterned bytes
    const size = 1024 * 1024;
    const pattern = Buffer.alloc(size);
    for (let index = 0; index < size; index++) pattern[index] = index % 251;
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-length': String(size), 'content-type': 'application/octet-stream' });
      response.end(pattern);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    try {
      // When the client reads slowly with pauses
      await once(socket, 'connect');
      socket.write('GET /big HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: close\r\n\r\n');
      const chunks: Buffer[] = [];
      let paused = false;
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (!paused && chunks.length > 4) {
          paused = true;
          socket.pause();
          setTimeout(() => socket.resume(), 100);
        }
      });
      await once(socket, 'close');
      // Then every byte survived the backpressure
      const received = Buffer.concat(chunks);
      const headerEnd = received.indexOf('\r\n\r\n');
      const body = received.subarray(headerEnd + 4);
      assert.equal(body.length, size);
      assert.deepEqual(body, pattern);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
