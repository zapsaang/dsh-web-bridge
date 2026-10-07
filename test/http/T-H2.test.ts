import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOOTSTRAP_CSP, BOOTSTRAP_HTML } from '../../src/lib/bootstrap.js';
import { callBridge, headerValue, headerValues, makeRuntime, rawExchange, startBridge, startUpstream } from './helpers.js';

const NATIVE_COOKIE =
  'dsh-auth-stub=opaque-payload; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';
const SECURED_COOKIE = NATIVE_COOKIE + '; Secure';

async function startBootstrapStub(): Promise<ReturnType<typeof startUpstream>> {
  return startUpstream((request, response) => {
    if ((request.url ?? '').startsWith('/?token=')) {
      response.writeHead(303, [
        'location', './',
        'cache-control', 'no-store',
        'referrer-policy', 'no-referrer',
        'set-cookie', NATIVE_COOKIE,
      ]);
      response.end();
      return;
    }
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
}

describe('T-H2 exchange mechanics and bootstrap response', () => {
  test('eligible 401 bootstraps: exact HTML/CSP/no-store, raw Host on exchange, no credential forwarding, no redirect follow', async () => {
    // Given an upstream that 401s navigations and answers the internal exchange per §6
    const upstream = await startBootstrapStub();
    const runtime = makeRuntime(upstream.port, {
      endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/?token=stub-token-1` },
    });
    const bridge = await startBridge(runtime);
    try {
      // When a qualified navigation carrying browser credentials hits the bridge
      const raw = await rawExchange(bridge.port,
        'GET / HTTP/1.1\r\nHost: DsH.Example.com\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n' +
        'Cookie: CF_Authorization=synthetic\r\nAuthorization: Bearer synthetic\r\nOrigin: https://evil.example\r\n' +
        'Connection: close\r\n\r\n');
      // Then the browser receives the fixed bootstrap response with the secured native cookie
      const text = raw.toString('latin1');
      assert.match(text, /^HTTP\/1\.1 200/);
      assert.ok(text.includes(`\r\ncontent-security-policy: ${BOOTSTRAP_CSP}\r\n`));
      assert.ok(text.includes('\r\ncache-control: no-store\r\n'));
      assert.ok(text.includes('\r\nreferrer-policy: no-referrer\r\n'));
      assert.ok(text.includes(`\r\nset-cookie: ${SECURED_COOKIE}\r\n`));
      assert.ok(text.includes(BOOTSTRAP_HTML));
      // And the upstream saw exactly the original request plus one exchange (no redirect follow to './')
      assert.equal(upstream.requests.length, 2);
      assert.equal(upstream.requests[0]?.path, '/');
      const exchangeRequest = upstream.requests[1];
      assert.equal(exchangeRequest?.method, 'GET');
      assert.equal(exchangeRequest?.path, '/?token=stub-token-1');
      // And the exchange carried the browser raw Host wire value but no browser credentials/metadata
      assert.equal(headerValue(exchangeRequest?.rawHeaders ?? [], 'host'), 'DsH.Example.com');
      assert.equal(headerValue(exchangeRequest?.rawHeaders ?? [], 'cookie'), undefined);
      assert.equal(headerValue(exchangeRequest?.rawHeaders ?? [], 'authorization'), undefined);
      assert.equal(headerValue(exchangeRequest?.rawHeaders ?? [], 'origin'), undefined);
      assert.ok(!(exchangeRequest?.rawHeaders ?? []).some((name, index) => index % 2 === 0 && name.toLowerCase().startsWith('sec-fetch-')));
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('legacy navigation with a single Accept: text/html (no Fetch Metadata) bootstraps', async () => {
    // Given the exchange-capable stub
    const upstream = await startBootstrapStub();
    const runtime = makeRuntime(upstream.port, {
      endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/?token=stub-token-2` },
    });
    const bridge = await startBridge(runtime);
    try {
      // When an old client navigates to root without Fetch Metadata but with an explicit Accept
      const response = await callBridge(bridge.port, {
        headers: { host: 'dsh.example.com', accept: 'text/html' },
      });
      // Then eligibility holds and the bootstrap response is returned
      assert.equal(response.status, 200);
      assert.equal(response.body.toString('utf8'), BOOTSTRAP_HTML);
      assert.deepEqual(headerValues(response.rawHeaders, 'set-cookie'), [SECURED_COOKIE]);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('non-eligible 401 passes through untouched and triggers no exchange', async () => {
    // Given the exchange-capable stub
    const upstream = await startBootstrapStub();
    let factoryCalls = 0;
    const runtime = makeRuntime(upstream.port, {
      endpoint: {
        port: upstream.port,
        authenticatedUrl: () => {
          factoryCalls += 1;
          return `http://127.0.0.1:${upstream.port}/?token=stub-token-3`;
        },
      },
    });
    const bridge = await startBridge(runtime);
    try {
      // When a root GET without navigation markers is rejected by the upstream
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then the original 401 is relayed byte-identical and no exchange happens
      assert.equal(response.status, 401);
      assert.equal(response.body.toString('utf8'), 'dsh web authentication required; reopen the URL printed by dsh web.\n');
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
      assert.equal(headerValues(response.rawHeaders, 'set-cookie').length, 0);
      assert.equal(upstream.requests.length, 1);
      assert.equal(factoryCalls, 0);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('concurrent eligible 401s each complete their own agent:false exchange without queue deadlock', async () => {
    // Given an exchange stub that answers after a short delay
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        setTimeout(() => {
          response.writeHead(303, [
            'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer', 'set-cookie', NATIVE_COOKIE,
          ]);
          response.end();
        }, 50);
        return;
      }
      response.writeHead(401, { 'cache-control': 'no-store' });
      response.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    });
    const runtime = makeRuntime(upstream.port, {
      endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/?token=stub-token-4` },
    });
    const bridge = await startBridge(runtime);
    try {
      // When two eligible navigations race while their original 401s stay paused
      const [first, second] = await Promise.all([
        callBridge(bridge.port, { headers: { host: 'dsh.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }),
        callBridge(bridge.port, { headers: { host: 'dsh.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }),
      ]);
      // Then both bootstrap independently (two originals, two exchanges, no shared queue)
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(upstream.requests.filter(captured => captured.path.startsWith('/?token=')).length, 2);
      assert.equal(upstream.requests.length, 4);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
