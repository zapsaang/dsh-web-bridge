import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOOTSTRAP_HTML } from '../../src/lib/bootstrap.js';
import { callBridge, headerValue, headerValues, makeRuntime, startBridge, startUpstream } from './helpers.js';

const UNAUTHORIZED = 'dsh web authentication required; reopen the URL printed by dsh web.\n';
const NAV = { host: 'dsh.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } as const;

describe('T-H10 retry marker scope, byte-level strip and conversion discipline', () => {
  test('marked POST to root is stripped and stays an ordinary response', async () => {
    // Given an upstream answering POST normally
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'x-native': 'post' });
      response.end('post-ok');
    });
    let factoryCalls = 0;
    const bridge = await startBridge(makeRuntime(upstream.port, {
      endpoint: {
        port: upstream.port,
        authenticatedUrl: () => {
          factoryCalls += 1;
          return `http://127.0.0.1:${upstream.port}/?token=stub-token`;
        },
      },
    }));
    try {
      // When a marked POST crosses the bridge
      const response = await callBridge(bridge.port, {
        method: 'POST',
        path: '/?__dsh_bridge_retry=1',
        headers: { host: 'dsh.example.com', 'content-length': '1' },
        body: 'x',
      });
      // Then the marker never reached the upstream and the 200 was not converted
      assert.equal(upstream.requests[0]?.method, 'POST');
      assert.equal(upstream.requests[0]?.path, '/');
      assert.deepEqual(upstream.requests[0]?.body, Buffer.from('x'));
      assert.equal(response.status, 200);
      assert.equal(response.body.toString('utf8'), 'post-ok');
      assert.equal(headerValue(response.rawHeaders, 'x-native'), 'post');
      assert.equal(factoryCalls, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('marked API and asset responses stay ordinary; only marker segments are removed byte-exact', async () => {
    // Given an upstream echoing the received path
    const upstream = await startUpstream((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'x-native': 'api' });
      response.end(`served:${request.url ?? ''}`);
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When marked subresource/API requests carry duplicate, encoded and empty-value neighbours
      const api = await callBridge(bridge.port, {
        path: '/api/data?__dsh_bridge_retry=1&b=2&b=1',
        headers: { host: 'dsh.example.com' },
      });
      const asset = await callBridge(bridge.port, {
        path: '/asset.js?__dsh_bridge_retry=1',
        headers: { host: 'dsh.example.com' },
      });
      const byteLevel = await callBridge(bridge.port, {
        path: '/?a=%41&__dsh_bridge_retry=1&a=%41&__dsh_bridge_retry&z=',
        headers: { host: 'dsh.example.com' },
      });
      // Then all marker segments vanished byte-exactly and every 200 stayed ordinary
      assert.equal(upstream.requests[0]?.path, '/api/data?b=2&b=1');
      assert.equal(upstream.requests[1]?.path, '/asset.js');
      assert.equal(upstream.requests[2]?.path, '/?a=%41&a=%41&z=');
      assert.equal(api.status, 200);
      assert.equal(api.body.toString('utf8'), 'served:/api/data?b=2&b=1');
      assert.equal(headerValue(api.rawHeaders, 'x-native'), 'api');
      assert.equal(asset.status, 200);
      assert.equal(byteLevel.status, 200);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('marked HEAD to root is not converted to 303', async () => {
    // Given an upstream 200 for HEAD
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': '123' });
      response.end();
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When a marked HEAD to root arrives
      const response = await callBridge(bridge.port, {
        method: 'HEAD',
        path: '/?__dsh_bridge_retry=1',
        headers: { host: 'dsh.example.com' },
      });
      // Then only GET document navigations convert; HEAD stays ordinary
      assert.equal(upstream.requests[0]?.path, '/');
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('marked root GET document 200 converts to fixed 303 / with no-store and no native fields', async () => {
    // Given an upstream accepting the marked navigation
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, [
        'content-type', 'text/html; charset=utf-8',
        'set-cookie', 'dsh-auth-native=opaque; Path=/; HttpOnly',
      ]);
      response.end('<html>index</html>');
    });
    let factoryCalls = 0;
    const bridge = await startBridge(makeRuntime(upstream.port, {
      endpoint: {
        port: upstream.port,
        authenticatedUrl: () => {
          factoryCalls += 1;
          return `http://127.0.0.1:${upstream.port}/?token=stub-token`;
        },
      },
    }));
    try {
      // When the browser follows the bootstrap script with the issued cookie
      const response = await callBridge(bridge.port, {
        path: '/?__dsh_bridge_retry=1',
        headers: { ...NAV, cookie: 'dsh-auth-native=opaque' },
      });
      // Then the bridge discards the verification body and answers the fixed clean redirect
      assert.equal(upstream.requests[0]?.path, '/');
      assert.equal(response.status, 303);
      assert.equal(headerValue(response.rawHeaders, 'location'), '/');
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
      assert.equal(response.body.length, 0);
      assert.equal(headerValues(response.rawHeaders, 'set-cookie').length, 0);
      assert.equal(factoryCalls, 0, 'marked requests never exchange');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('marked root GET document 401 is terminal: raw 401, no exchange, no JS, no link rewrite', async () => {
    // Given an upstream still rejecting the marked navigation
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(UNAUTHORIZED);
    });
    let factoryCalls = 0;
    const bridge = await startBridge(makeRuntime(upstream.port, {
      endpoint: {
        port: upstream.port,
        authenticatedUrl: () => {
          factoryCalls += 1;
          return `http://127.0.0.1:${upstream.port}/?token=stub-token`;
        },
      },
    }));
    try {
      // When the marked retry still has no valid cookie
      const response = await callBridge(bridge.port, {
        path: '/?__dsh_bridge_retry=1',
        headers: { ...NAV },
      });
      // Then the original 401 is the terminal answer and no second exchange happens
      assert.equal(upstream.requests.length, 1);
      assert.equal(response.status, 401);
      assert.equal(response.body.toString('utf8'), UNAUTHORIZED);
      assert.equal(response.body.includes(BOOTSTRAP_HTML), false);
      assert.equal(headerValue(response.rawHeaders, 'location'), undefined);
      assert.equal(headerValues(response.rawHeaders, 'set-cookie').length, 0);
      assert.equal(factoryCalls, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('one unmarked eligible 401 triggers exactly one exchange', async () => {
    // Given an exchange-capable stub
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        response.writeHead(303, [
          'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer',
          'set-cookie',
          'dsh-auth-stub=opaque; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict',
        ]);
        response.end();
        return;
      }
      response.writeHead(401, { 'cache-control': 'no-store' });
      response.end(UNAUTHORIZED);
    });
    const bridge = await startBridge(makeRuntime(upstream.port, {
      endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/?token=stub-token` },
    }));
    try {
      // When one eligible navigation is rejected
      const response = await callBridge(bridge.port, { headers: { ...NAV } });
      // Then the recovery cycle used exactly one exchange for this request
      assert.equal(response.status, 200);
      assert.equal(upstream.requests.filter(captured => captured.path.startsWith('/?token=')).length, 1);
      assert.equal(upstream.requests.length, 2);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
