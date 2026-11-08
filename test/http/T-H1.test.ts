import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { headerValue, makeRuntime, rawExchange, startBridge, startUpstream, callBridge } from './helpers.js';

describe('T-H1 full proxy round-trip fidelity', () => {
  test('mixed-case raw Host forwarded byte-identical, method/target/end-to-end headers preserved', async () => {
    // Given an upstream that echoes its received request line and headers
    const upstream = await startUpstream((request, response) => {
      response.writeHead(200, ['x-echo', 'ok', 'X-Mixed-Case', 'Preserved']);
      response.end('upstream-body');
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When a request carries a mixed-case Host for an approved authority
      const raw = await rawExchange(bridge.port,
        'GET /some/path?x=1&x=2 HTTP/1.1\r\nHost: DsH.Example.com\r\nX-Custom: Value-One\r\nConnection: close\r\n\r\n');
      // Then upstream observed the raw Host wire value and target unchanged
      assert.equal(upstream.requests.length, 1);
      const seen = upstream.requests[0];
      assert.equal(seen?.method, 'GET');
      assert.equal(seen?.path, '/some/path?x=1&x=2');
      assert.equal(headerValue(seen.rawHeaders, 'host'), 'DsH.Example.com');
      assert.equal(headerValue(seen.rawHeaders, 'x-custom'), 'Value-One');
      // And the downstream response carried upstream status, headers and body
      const text = raw.toString('latin1');
      assert.match(text, /^HTTP\/1\.1 200/);
      assert.match(text, /X-Mixed-Case: Preserved\r\n/);
      assert.ok(text.includes('upstream-body'));
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('POST body bytes forwarded and response body bytes preserved', async () => {
    // Given an upstream that returns a binary body
    const binary = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);
    const upstream = await startUpstream((request, response, captured) => {
      response.writeHead(201, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.concat([captured.body, binary]));
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When posting a binary body through the bridge
      const payload = Buffer.from([9, 8, 7, 0, 255]);
      const response = await callBridge(bridge.port, {
        method: 'POST',
        path: '/api/upload',
        headers: { host: 'dsh.example.com', 'content-length': String(payload.length) },
        body: payload,
      });
      // Then upstream received the exact bytes and the bridge returned exact bytes
      assert.deepEqual(upstream.requests[0]?.body, payload);
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, Buffer.concat([payload, binary]));
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('hop-by-hop fields filtered and Cf-Access-Jwt-Assertion stripped upstream', async () => {
    // Given a request carrying hop-by-hop and Access JWT headers
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the request nominates x-extra via Connection and carries the JWT header
      await callBridge(bridge.port, {
        headers: {
          'host': 'dsh.example.com',
          'connection': 'keep-alive, X-Extra',
          'keep-alive': 'timeout=5',
          'x-extra': 'nominated',
          'cf-access-jwt-assertion': 'synthetic.jwt.value',
          'te': 'trailers',
        },
      });
      // Then upstream never saw hop-by-hop, nominated, or JWT fields
      const seen = upstream.requests[0];
      assert.equal(headerValue(seen?.rawHeaders ?? [], 'x-extra'), undefined);
      assert.equal(headerValue(seen?.rawHeaders ?? [], 'keep-alive'), undefined);
      assert.equal(headerValue(seen?.rawHeaders ?? [], 'cf-access-jwt-assertion'), undefined);
      assert.equal(headerValue(seen?.rawHeaders ?? [], 'te'), undefined);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('Authorization is stripped on the request direction; the response direction is untouched', async () => {
    // Given an upstream that reports the request headers it received and sets
    // an Authorization response header (DSH never does; this pins the decision).
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, [
        'authorization', 'Bearer upstream-template',
        'cf-access-jwt-assertion', 'synthetic.response.jwt',
      ]);
      response.end('ok');
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the access layer leaves proxy credentials in the request
      const response = await callBridge(bridge.port, {
        headers: {
          'host': 'dsh.example.com',
          'authorization': 'Basic dXNlcjpwYXNz',
          'cf-access-jwt-assertion': 'synthetic.request.jwt',
        },
      });
      // Then DSH receives neither credential (D2: request direction strips Authorization)
      const seen = upstream.requests[0]?.rawHeaders ?? [];
      assert.equal(headerValue(seen, 'authorization'), undefined);
      assert.equal(headerValue(seen, 'cf-access-jwt-assertion'), undefined);
      // And the response keeps Authorization untouched while the JWT header is stripped
      assert.equal(headerValue(response.rawHeaders, 'authorization'), 'Bearer upstream-template');
      assert.equal(headerValue(response.rawHeaders, 'cf-access-jwt-assertion'), undefined);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('Connection nominating a protected header is rejected with 400 and zero upstream hits', async () => {
    // Given a request whose Connection header nominates Cookie
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the protected nomination reaches the bridge
      const response = await callBridge(bridge.port, {
        headers: { host: 'dsh.example.com', connection: 'Cookie', cookie: 'a=b' },
      });
      // Then it is rejected before any upstream connection
      assert.equal(response.status, 400);
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
      assert.equal(upstream.requests.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('proxied request appends RFC 9110 compliant Via header upstream', async () => {
    // Given an upstream that captures request headers
    const upstream = await startUpstream((_request, response) => response.end('ok'));
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When a request without Via arrives
      await callBridge(bridge.port, {
        headers: { host: 'dsh.example.com' },
      });
      // Then upstream observes the mandatory Via: 1.1 dsh-web-bridge header
      assert.equal(upstream.requests.length, 1);
      assert.equal(headerValue(upstream.requests[0]?.rawHeaders ?? [], 'via'), '1.1 dsh-web-bridge');

      // When a request with an existing Via arrives
      await callBridge(bridge.port, {
        headers: { host: 'dsh.example.com', via: '1.0 test-gateway' },
      });
      // Then upstream observes the appended Via header list
      assert.equal(upstream.requests.length, 2);
      assert.equal(headerValue(upstream.requests[1]?.rawHeaders ?? [], 'via'), '1.0 test-gateway, 1.1 dsh-web-bridge');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
