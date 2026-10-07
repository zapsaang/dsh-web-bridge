import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authority, cookiePair, isolated, send, unauthorized } from './harness.js';

class MethodResponse {
  status: number | undefined;
  headers: Readonly<Record<string, string>> = {};
  body: string | undefined;
  ended = false;
  writeHead(status: number, headers: Readonly<Record<string, string>> = {}): void {
    this.status = status;
    this.headers = headers;
  }
  end(body?: string): void { this.body = body; this.ended = true; }
}

// §2.6 entire method table, independently from frontend-static's HTTP fallback.
for (const row of [
  { name: 'valid cookie without token', method: 'GET', path: '/', cookie: true, status: 0, issued: false },
  { name: 'valid HEAD cookie without token', method: 'HEAD', path: '/', cookie: true, status: 0, issued: false },
  { name: 'matching single root token', method: 'GET', path: '/?token=MATCH', cookie: false, status: 303, issued: true },
  { name: 'matching token takes precedence over cookie', method: 'GET', path: '/?token=MATCH', cookie: true, status: 303, issued: true },
  { name: 'wrong token with valid cookie', method: 'GET', path: '/?token=wrong', cookie: true, status: 303, issued: false },
  { name: 'multiple tokens with valid cookie', method: 'GET', path: '/?token=MATCH&token=wrong', cookie: true, status: 303, issued: false },
  { name: 'empty token with valid cookie', method: 'GET', path: '/?token=', cookie: true, status: 303, issued: false },
  { name: 'POST token with valid cookie', method: 'POST', path: '/?token=MATCH', cookie: true, status: 401, issued: false },
  { name: 'POST token without cookie', method: 'POST', path: '/?token=MATCH', cookie: false, status: 401, issued: false },
  { name: 'HEAD token with valid cookie', method: 'HEAD', path: '/?token=MATCH', cookie: true, status: 401, issued: false },
  { name: 'nonroot token with valid cookie', method: 'GET', path: '/index.html?token=MATCH', cookie: true, status: 401, issued: false },
  { name: 'nonroot token without cookie', method: 'GET', path: '/index.html?token=MATCH', cookie: false, status: 401, issued: false },
  { name: 'missing cookie and token', method: 'GET', path: '/', cookie: false, status: 401, issued: false },
  { name: 'wrong token without cookie', method: 'GET', path: '/?token=wrong', cookie: false, status: 401, issued: false },
  { name: 'multiple tokens without cookie', method: 'GET', path: '/?token=MATCH&token=MATCH', cookie: false, status: 401, issued: false },
  { name: 'HEAD without authentication', method: 'HEAD', path: '/', cookie: false, status: 401, issued: false },
] as const) {
  test(`T-DSH9 method contract when ${row.name}`, async () => {
    // Given
    await using app = await isolated();
    const cookie = cookiePair(await app.exchange());
    const response = new MethodResponse();
    // When
    const authorized = app.ctx.connection.authorizeIndex({
      method: row.method, url: row.path.replaceAll('MATCH', encodeURIComponent(app.token())),
      headers: { host: authority, ...(row.cookie ? { cookie } : {}) },
    }, response);
    // Then
    assert.equal(authorized, row.status === 0);
    assert.equal(response.status, row.status === 0 ? undefined : row.status);
    assert.equal(response.ended, row.status !== 0);
    assert.equal(Object.hasOwn(response.headers, 'set-cookie'), row.issued);
    if (row.status === 303) {
      assert.equal(response.headers['location'], './');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
    }
    if (row.status === 401) {
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(response.body, row.method === 'HEAD' ? undefined : unauthorized);
    }
  });
}

test('T-DSH9 rejects the method exchange when authority cannot be parsed', async () => {
  // Given
  await using app = await isolated();
  const response = new MethodResponse();
  // When
  const authorized = app.ctx.connection.authorizeIndex({
    method: 'GET', url: `/?token=${app.token()}`, headers: { host: '[' },
  }, response);
  // Then
  assert.equal(authorized, false);
  assert.equal(response.status, 401);
  assert.equal(Object.hasOwn(response.headers, 'set-cookie'), false);
});

for (const [host, status] of [
  [authority.toUpperCase(), 200], [`${authority}:80`, 200], [`${authority}:443`, 401],
] as const) {
  test(`T-DSH9 authority normalization when Host is ${host}`, async () => {
    // Given
    await using app = await isolated();
    const cookie = cookiePair(await app.exchange());
    // When
    const response = await send(app.port, { headers: { host, cookie } });
    // Then
    assert.equal(response.status, status);
  });
}

for (const row of [
  { method: 'POST', cookie: true, token: true, status: 405 },
  { method: 'GET', cookie: false, token: false, status: 401 },
  { method: 'HEAD', cookie: false, token: false, status: 401 },
  { method: 'GET', cookie: true, token: false, status: 200 },
  { method: 'HEAD', cookie: true, token: false, status: 200 },
  { method: 'HEAD', cookie: true, token: true, status: 401 },
] as const) {
  test(`T-DSH9 shipped HTTP ${row.method} cookie=${row.cookie} token=${row.token} returns ${row.status}`, async () => {
    // Given
    await using app = await isolated();
    const cookie = cookiePair(await app.exchange());
    // When
    const response = await send(app.port, {
      method: row.method, path: row.token ? `/?token=${app.token()}` : '/',
      headers: row.cookie ? { cookie } : {},
    });
    // Then
    assert.equal(response.status, row.status);
    if (row.method === 'HEAD') assert.equal(response.body, '');
    if (row.method === 'GET' && row.status === 401) assert.equal(response.body, unauthorized);
  });
}
