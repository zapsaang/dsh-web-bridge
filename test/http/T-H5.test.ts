import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connect } from 'node:net';
import { headerValue, makeRuntime, rawExchange, startBridge, startUpstream, callBridge } from './helpers.js';

describe('T-H5 502/504 semantics and post-commit destroy-only', () => {
  test('upstream connection refusal before commit yields 502 no-store', async () => {
    // Given an upstream port that is already closed
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const deadPort = upstream.port;
    await upstream.close();
    const bridge = await startBridge(makeRuntime(deadPort));
    try {
      // When the bridge cannot connect
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then it answers 502 with no-store before committing anything else
      assert.equal(response.status, 502);
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
    } finally {
      await bridge.close();
    }
  });

  test('first final header deadline exceeded yields 504 no-store', async () => {
    // Given an upstream that accepts but never answers
    const upstream = await startUpstream(() => {
      /* never responds */
    });
    const bridge = await startBridge(makeRuntime(upstream.port, { timeouts: { firstHeader: 100 } }));
    try {
      // When the first final header does not arrive within the deadline
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then the bridge answers 504 with no-store
      assert.equal(response.status, 504);
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('connect timer is cleared on connect success (fast request survives tight connect budget)', async () => {
    // Given a normal upstream and a very tight connect budget
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port, { timeouts: { connect: 50 } }));
    try {
      // When the connection establishes quickly
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then the request succeeds, proving the connect timer disarmed on connect
      assert.equal(response.status, 200);
      assert.equal(response.body.toString(), 'ok');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('post-commit upstream error aborts both sides without rewriting the status', async () => {
    // Given an upstream that commits 200 headers then destroys mid-body
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial-');
      setTimeout(() => response.destroy(new Error('upstream boom')), 20);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the upstream dies after committing
      const raw = await rawExchange(bridge.port,
        'GET /stream HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: close\r\n\r\n');
      // Then the client saw the committed 200 head and an aborted body, never a rewritten 502
      const text = raw.toString('latin1');
      assert.match(text, /^HTTP\/1\.1 200/);
      assert.ok(text.includes('partial-'));
      assert.ok(!text.includes('502'));
      assert.ok(!text.endsWith('0\r\n\r\n'), 'chunked body must not be terminated cleanly');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('advertised Trailer header on upstream response yields 502 before any downstream header', async () => {
    // Given an upstream advertising a Trailer response header
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { trailer: 'x-checksum', 'transfer-encoding': 'chunked' });
      response.end('body');
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the advertised trailer reaches the bridge
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then the bridge refuses with 502 instead of committing the response
      assert.equal(response.status, 502);
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
