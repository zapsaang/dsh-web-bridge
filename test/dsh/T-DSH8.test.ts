import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authority, cookiePair, isolated, send } from './harness.js';

// §2.1/2.2: rpc-host.ts 104-106; api-request-trust.ts 74-82, 100-118.
for (const scenario of [
  { name: 'cross-site with cookie', cookie: true, extra: { 'sec-fetch-site': 'cross-site' }, host: authority, status: 403 },
  { name: 'cross-site without cookie (403 before 401)', cookie: false, extra: { 'sec-fetch-site': 'cross-site' }, host: authority, status: 403 },
  { name: 'wrong Origin host with cookie', cookie: true, extra: { origin: 'https://wrong.example.test' }, host: authority, status: 403 },
  { name: 'wrong Origin without cookie (403 before 401)', cookie: false, extra: { origin: 'https://wrong.example.test' }, host: authority, status: 403 },
  { name: 'different scheme but matching URL.host', cookie: true, extra: { origin: `https://${authority}` }, host: authority, status: 200 },
  { name: 'trusted host port 8443', cookie: true, extra: { origin: `https://${authority}:8443` }, host: `${authority}:8443`, status: 200 },
  { name: 'trusted host port 9443', cookie: true, extra: { origin: `http://${authority}:9443` }, host: `${authority}:9443`, status: 200 },
  { name: 'trusted request missing cookie', cookie: false, extra: {}, host: authority, status: 401 },
  { name: 'untrusted Host', cookie: true, extra: {}, host: 'untrusted.example.test', status: 403 },
] as const) {
  test(`T-DSH8 returns ${scenario.status} when API receives ${scenario.name}`, async () => {
    // Given: only the business response is synthetic; native /api owns admission.
    await using app = await isolated();
    app.ctx.connection.fetch.register({
      path: '/api/native-probe', methods: ['GET'], requestBody: 'buffered',
      fetch: async () => new Response('native-admitted'),
    });
    const cookie = cookiePair(await app.exchange(scenario.host));
    // When
    const response = await send(app.port, {
      path: '/api/native-probe',
      headers: { host: scenario.host, ...scenario.extra, ...(scenario.cookie ? { cookie } : {}) },
    });
    // Then
    assert.equal(response.status, scenario.status);
    if (scenario.status === 200) assert.equal(response.body, 'native-admitted');
  });
}
