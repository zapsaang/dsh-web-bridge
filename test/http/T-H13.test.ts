import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { makeRuntime, startBridge, startUpstream } from './helpers.js';

describe('T-H13 timeout arming points and early final', () => {
  test('first-final-header timer arms only after outbound upload finishes', async () => {
    // Given an upstream that answers 250ms after the upload completes
    const upstream = await startUpstream((_request, response) => {
      setTimeout(() => response.end('ok'), 250);
    });
    // And a header deadline shorter than that delay
    const bridge = await startBridge(makeRuntime(upstream.port, { timeouts: { firstHeader: 100 } }));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    try {
      // When the client uploads slowly for 300ms before finishing
      await once(socket, 'connect');
      socket.write('POST /api/slow HTTP/1.1\r\nHost: dsh.example.com\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc');
      await new Promise((resolve) => setTimeout(resolve, 300));
      socket.write('def');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      await once(socket, 'close');
      const text = Buffer.concat(chunks).toString('latin1');
      // Then no 504 fired during the upload, and the post-finish header deadline produced 504
      assert.match(text, /^HTTP\/1\.1 504/);
      assert.equal(upstream.requests.length, 1);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('header timer does not fire while upload is still in progress', async () => {
    // Given an upstream that answers immediately once the body arrives
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port, { timeouts: { firstHeader: 100 } }));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    try {
      // When the upload itself takes longer than the header deadline
      await once(socket, 'connect');
      socket.write('POST /api/slow HTTP/1.1\r\nHost: dsh.example.com\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc');
      await new Promise((resolve) => setTimeout(resolve, 200));
      socket.write('def');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      await once(socket, 'close');
      const text = Buffer.concat(chunks).toString('latin1');
      // Then the request succeeded because the header timer was never armed during upload
      assert.match(text, /^HTTP\/1\.1 200/);
      assert.ok(text.includes('ok'));
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('early final response is relayed before connections close and cancels upload/header timers', async () => {
    // Given an upstream that finals immediately while the body is still arriving
    const upstreamServer = createServer((request, response) => {
      request.on('data', () => undefined);
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('early-final-body');
    });
    upstreamServer.listen(0, '127.0.0.1');
    await once(upstreamServer, 'listening');
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;
    const bridge = await startBridge(makeRuntime(upstreamPort, { timeouts: { upload: 500, firstHeader: 100 } }));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    try {
      // When the client uploads slowly and the upstream finals early
      await once(socket, 'connect');
      socket.write('POST /api/early HTTP/1.1\r\nHost: dsh.example.com\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\npartial');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      await once(socket, 'close');
      const text = Buffer.concat(chunks).toString('latin1');
      // Then the early response was fully relayed and neither 408 nor 504 fired
      assert.match(text, /^HTTP\/1\.1 200/);
      assert.ok(text.includes('early-final-body'));
      assert.ok(!text.includes('408') && !text.includes('504'));
    } finally {
      upstreamServer.close();
      await bridge.close();
    }
  });
});
