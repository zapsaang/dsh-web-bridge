import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { BOOTSTRAP_CSP, BOOTSTRAP_HTML } from '../../src/lib/bootstrap.js';
import type { BridgeRuntime } from '../../src/lib/bridge.js';
import { callBridge, headerValue, headerValues, startBridge, startUpstream } from '../http/helpers.js';
import { authority, isolated, unauthorized } from './harness.js';

const NAV = { host: authority, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } as const;

// §5/§6 against the pinned DSH: stubs cannot prove the HMAC trust chain (§14.3).
test('T-DSH2 bootstraps through a real DSH instance: HTML, secured cookie, marked 303, clean 200', async () => {
  // Given a real DSH behind the bridge
  await using app = await isolated();
  const controller = new AbortController();
  const runtime: BridgeRuntime = {
    endpoint: { port: app.port, authenticatedUrl: (base) => app.ctx.connection.authenticatedUrl(base) },
    authorities: [authority],
    signal: controller.signal,
  };
  const bridge = await startBridge(runtime);
  try {
    // When a qualified navigation arrives without any cookie
    const bootstrap = await callBridge(bridge.port, { headers: { ...NAV } });
    // Then the bridge answers the fixed bootstrap HTML carrying the secured native cookie
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.toString('utf8'), BOOTSTRAP_HTML);
    assert.equal(headerValue(bootstrap.rawHeaders, 'content-security-policy'), BOOTSTRAP_CSP);
    assert.equal(headerValue(bootstrap.rawHeaders, 'cache-control'), 'no-store');
    assert.equal(headerValue(bootstrap.rawHeaders, 'referrer-policy'), 'no-referrer');
    const issued = headerValues(bootstrap.rawHeaders, 'set-cookie');
    assert.equal(issued.length, 1);
    const cookie = issued[0] ?? '';
    assert.match(cookie, /^dsh-auth-/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /; Secure$/, 'bridge appended Secure to the native cookie');
    // When the browser follows the script with the issued cookie on the marked retry
    const pair = cookie.split(';', 1)[0] ?? '';
    const retry = await callBridge(bridge.port, {
      path: '/?__dsh_bridge_retry=1',
      headers: { ...NAV, cookie: pair },
    });
    // Then the bridge converts the verified 200 into the fixed clean redirect
    assert.equal(retry.status, 303);
    assert.equal(headerValue(retry.rawHeaders, 'location'), '/');
    assert.equal(headerValue(retry.rawHeaders, 'cache-control'), 'no-store');
    assert.equal(retry.body.length, 0);
    // When the browser revisits the clean root with the cookie
    const clean = await callBridge(bridge.port, { headers: { host: authority, cookie: pair } });
    // Then the native index is served and no further bootstrap happens
    assert.equal(clean.status, 200);
    assert.notEqual(clean.body.toString('utf8'), BOOTSTRAP_HTML);
  } finally {
    await bridge.close();
  }
});

// §14.3 T-DSH2 failure fixture: even with a genuine process token from the real
// DSH factory, any contract drift on the exchange response must fail closed.
for (const [name, exchange] of [
  ['non-303 status', (response: ServerResponse, cookie: string) => {
    response.writeHead(200, { 'set-cookie': cookie });
    response.end();
  }],
  ['Location drift', (response: ServerResponse, cookie: string) => {
    response.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookie });
    response.end();
  }],
  ['missing Set-Cookie', (response: ServerResponse) => {
    response.writeHead(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    response.end();
  }],
  ['SameSite attribute drift', (response: ServerResponse, cookie: string) => {
    response.writeHead(303, {
      location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': cookie.replace('SameSite=Strict', 'SameSite=Lax'),
    });
    response.end();
  }],
] as const) {
  test(`T-DSH2 fails closed to the original 401 on contract drift: ${name}`, async () => {
    // Given the real DSH token factory but a stub exchange endpoint violating §6
    await using app = await isolated();
    const genuine =
      'dsh-auth-fixture=genuine-payload; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        exchange(response, genuine);
        return;
      }
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(unauthorized);
    });
    const runtime: BridgeRuntime = {
      endpoint: { port: upstream.port, authenticatedUrl: (base) => app.ctx.connection.authenticatedUrl(base) },
      authorities: [authority],
      signal: new AbortController().signal,
    };
    const bridge = await startBridge(runtime);
    try {
      // When a qualified navigation triggers an exchange against the drifting endpoint
      const response = await callBridge(bridge.port, { headers: { ...NAV } });
      // Then the bridge resumes the original 401 and forwards nothing from the exchange
      assert.equal(response.status, 401);
      assert.equal(response.body.toString('utf8'), unauthorized);
      assert.equal(headerValues(response.rawHeaders, 'set-cookie').length, 0);
      assert.equal(headerValue(response.rawHeaders, 'location'), undefined);
      assert.ok(upstream.requests.some(captured => captured.path.startsWith('/?token=')), 'exchange was attempted with the genuine token');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
}
