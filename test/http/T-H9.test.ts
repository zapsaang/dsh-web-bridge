import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOOTSTRAP_HTML } from '../../src/lib/bootstrap.js';
import { callBridge, headerValue, headerValues, makeRuntime, startBridge, startUpstream } from './helpers.js';

const COOKIE_ONE =
  'dsh-auth-one=payload-one; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';
const COOKIE_TWO =
  'dsh-auth-two=payload-two; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';

describe('T-H9 two authorities bootstrap independently', () => {
  test('each authority exchanges with its own raw Host and receives its own secured cookie', async () => {
    // Given a stub upstream issuing a distinct cookie per exchange Host
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        const host = request.headers.host;
        const cookie = host === 'dsh2.example.com' ? COOKIE_TWO : COOKIE_ONE;
        response.writeHead(303, [
          'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer', 'set-cookie', cookie,
        ]);
        response.end();
        return;
      }
      response.writeHead(401, { 'cache-control': 'no-store' });
      response.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    });
    const runtime = makeRuntime(upstream.port, {
      authorities: ['dsh.example.com', 'dsh2.example.com'],
      endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/?token=stub-token` },
    });
    const bridge = await startBridge(runtime);
    try {
      // When each approved authority navigates to root unauthenticated
      const first = await callBridge(bridge.port, {
        headers: { host: 'dsh.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      const second = await callBridge(bridge.port, {
        headers: { host: 'dsh2.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      // Then each gets its own authority-bound cookie with Secure appended
      assert.equal(first.status, 200);
      assert.equal(first.body.toString('utf8'), BOOTSTRAP_HTML);
      assert.deepEqual(headerValues(first.rawHeaders, 'set-cookie'), [COOKIE_ONE + '; Secure']);
      assert.equal(second.status, 200);
      assert.deepEqual(headerValues(second.rawHeaders, 'set-cookie'), [COOKIE_TWO + '; Secure']);
      // And the exchange requests carried the respective raw Host wire values
      const exchanges = upstream.requests.filter(captured => captured.path.startsWith('/?token='));
      assert.equal(exchanges.length, 2);
      assert.deepEqual(
        exchanges.map(captured => headerValue(captured.rawHeaders, 'host')),
        ['dsh.example.com', 'dsh2.example.com'],
      );
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('an authority outside the approved list is 403 with zero upstream and zero exchange', async () => {
    // Given a dual-authority bridge
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(401, { 'cache-control': 'no-store' });
      response.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    });
    let factoryCalls = 0;
    const runtime = makeRuntime(upstream.port, {
      authorities: ['dsh.example.com', 'dsh2.example.com'],
      endpoint: {
        port: upstream.port,
        authenticatedUrl: () => {
          factoryCalls += 1;
          return `http://127.0.0.1:${upstream.port}/?token=stub-token`;
        },
      },
    });
    const bridge = await startBridge(runtime);
    try {
      // When an unapproved authority navigates
      const response = await callBridge(bridge.port, {
        headers: { host: 'other.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      // Then it is rejected before any upstream or exchange
      assert.equal(response.status, 403);
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
      assert.equal(upstream.requests.length, 0);
      assert.equal(factoryCalls, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
