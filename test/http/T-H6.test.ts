import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { makeRuntime, startBridge, startUpstream, callBridge } from './helpers.js';

describe('T-H6 downstream abort cancels the chain; normal close is not an abort', () => {
  test('client abort mid-upload destroys the upstream request', async () => {
    // Given an upstream that records how its request stream ends
    const events: string[] = [];
    const rawUpstream = createServer((request, response) => {
      request.on('data', () => undefined);
      request.on('aborted', () => events.push('aborted'));
      request.on('close', () => {
        events.push(request.complete ? 'complete-close' : 'incomplete-close');
        response.destroy();
      });
    });
    rawUpstream.listen(0, '127.0.0.1');
    await once(rawUpstream, 'listening');
    const upstreamPort = (rawUpstream.address() as AddressInfo).port;
    const bridge = await startBridge(makeRuntime(upstreamPort));
    const socket = connect({ host: '127.0.0.1', port: bridge.port });
    try {
      // When the client sends a partial body then aborts
      await once(socket, 'connect');
      socket.write('POST /api/upload HTTP/1.1\r\nHost: dsh.example.com\r\nContent-Length: 1000000\r\n\r\npartial');
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Then the upstream observed an incomplete request close
      assert.ok(events.includes('incomplete-close'), `events: ${events.join(',')}`);
    } finally {
      rawUpstream.close();
      await bridge.close();
    }
  });

  test('normal request completion then connection close is not treated as abort', async () => {
    // Given a normal upstream
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When a request completes fully and the connection then closes
      const first = await callBridge(bridge.port, { headers: { host: 'dsh.example.com', connection: 'close' } });
      assert.equal(first.status, 200);
      assert.equal(first.body.toString(), 'ok');
      // Then a subsequent request still works (no poisoned state)
      const second = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      assert.equal(second.status, 200);
      assert.equal(upstream.requests.length, 2);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
