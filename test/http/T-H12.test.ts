import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { headerValues, makeRuntime, startBridge, startUpstream, callBridge } from './helpers.js';

describe('T-H12 normal-path Set-Cookie opacity', () => {
  test('multiple Set-Cookie fields stay independent; only dsh-auth-* gains Secure', async () => {
    // Given an upstream issuing a native and a foreign cookie
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, [
        ['set-cookie', 'dsh-auth-abc=value; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict; Expires=Wed, 21 Oct 2026 07:28:00 GMT'],
        ['set-cookie', 'foreign=value2; Path=/'],
      ]);
      response.end('ok');
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the response passes the bridge
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then both fields stay separate, native gains Secure, foreign is untouched
      const cookies = headerValues(response.rawHeaders, 'set-cookie');
      assert.equal(cookies.length, 2);
      assert.equal(cookies[0], 'dsh-auth-abc=value; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure');
      assert.equal(cookies[1], 'foreign=value2; Path=/');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('deletion/expiry cookies keep attributes; exchange strictness not applied on normal path', async () => {
    // Given deletion and already-secure native cookies plus a minimal native cookie
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, [
        ['set-cookie', 'dsh-auth-gone=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
        ['set-cookie', 'dsh-auth-has=v; Secure; Path=/'],
        ['set-cookie', 'dsh-auth-min=v'],
      ]);
      response.end('ok');
    });
    const bridge = await startBridge(makeRuntime(upstream.port));
    try {
      // When the response passes the bridge
      const response = await callBridge(bridge.port, { headers: { host: 'dsh.example.com' } });
      // Then expiry attributes survive, Secure stays idempotent, minimal cookie only gains Secure
      const cookies = headerValues(response.rawHeaders, 'set-cookie');
      assert.deepEqual(cookies, [
        'dsh-auth-gone=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure',
        'dsh-auth-has=v; Secure; Path=/',
        'dsh-auth-min=v; Secure',
      ]);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
