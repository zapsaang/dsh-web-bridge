import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { headerValue, makeRuntime, rawExchange, startBridge, startUpstream, callBridge } from './helpers.js';

describe('T-H11 inbound token query boundary', () => {
  test('token query on plain request is 400 no-store with zero upstream hits', async () => {
    // Given an upstream that records every hit
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When requests carry a token key in various spellings
      for (const path of ['/?token=abc', '/?x=1&token=&y=2', '/?%74oken=abc', '/?token=a&token=b']) {
        const response = await callBridge(bridge.port, { path, headers: { host: 'dsh.example.com' } });
        // Then each is rejected generically before any upstream connection
        assert.equal(response.status, 400, path);
        assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store', path);
        assert.ok(!response.body.toString().includes('abc'), path);
      }
      // And upstream never saw any of them
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('token query on an upgrade request is rejected before any upstream upgrade', async () => {
    // Given an upgrade attempt carrying a token query
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the upgrade request reaches the bridge
      const raw = await rawExchange(bridge.port,
        'GET /?token=secret HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      // Then the denial is 400 and the body never contains the token value
      const text = raw.toString('latin1');
      assert.match(text, /^HTTP\/1\.1 400/);
      assert.ok(!text.includes('secret'));
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
