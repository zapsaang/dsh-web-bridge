import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookiePair, isolated, send } from './harness.js';

// §2.5/2.6: browser-auth.ts 121-123, 238-263; no bridge in this path.
test('T-DSH1 issues the native cookie when one root process token matches', async () => {
  // Given
  await using app = await isolated();
  // When
  const response = await app.exchange();
  // Then
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, './');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'set-cookie').length, 1);
  const pair = cookiePair(response);
  assert.ok(/^dsh-auth-[A-Za-z0-9_-]+=[^;]+$/.test(pair), 'native cookie prefix and nonempty value');
  const cookie = response.headers['set-cookie']?.[0];
  assert.ok(cookie);
  const attributes = cookie.slice(cookie.indexOf(';') + 1).split(';').map(value => value.trim());
  assert.equal(attributes.length, 5);
  assert.ok(attributes.includes('Max-Age=2592000'));
  assert.ok(attributes.includes('Path=/'));
  assert.ok(attributes.includes('HttpOnly'));
  assert.ok(attributes.includes('SameSite=Strict'));
  const expires = attributes.find(value => value.startsWith('Expires='))?.slice(8);
  assert.ok(expires && Number.isFinite(Date.parse(expires)));
  assert.ok(!attributes.some(value => /^secure(?:=|$)/i.test(value)));
});

// §2.6: cookieValue consumes the first current-name pair, lines 110-118.
for (const [scenario, expected] of [
  ['valid', 200], ['missing', 401], ['tampered', 401], ['expired', 401],
  ['foreign-only', 401], ['valid+foreign+CF_Authorization', 200], ['foreign+CF_Authorization+valid', 200],
  ['bad-first/good-second', 401], ['good-first/bad-second', 200],
] as const) {
  test(`T-DSH5 returns ${expected} when cookie is ${scenario}`, async t => {
    // Given: expired is genuinely DSH-issued and signed, not a broken signature.
    await using app = await isolated();
    if (scenario === 'expired') {
      const past = Date.now() - 31 * 86400000;
      t.mock.method(Date, 'now', () => past);
    }
    const good = cookiePair(await app.exchange());
    t.mock.restoreAll();
    const signatureAt = good.lastIndexOf('.') + 1;
    const bad = good.slice(0, signatureAt) + (good[signatureAt] === 'A' ? 'B' : 'A') + good.slice(signatureAt + 1);
    const foreign = cookiePair(await app.exchange('foreign.example.test'));
    const cookies = {
      valid: good, missing: '', tampered: bad, expired: good,
      'foreign-only': foreign,
      'valid+foreign+CF_Authorization': `${good}; ${foreign}; CF_Authorization=synthetic-access-cookie`,
      'foreign+CF_Authorization+valid': `${foreign}; CF_Authorization=synthetic-access-cookie; ${good}`,
      'bad-first/good-second': `${bad}; ${good}`,
      'good-first/bad-second': `${good}; ${bad}`,
    };
    // When: node:http preserves the exact string order on the native wire.
    const response = await send(app.port, { headers: { cookie: cookies[scenario] } });
    // Then
    assert.equal(response.status, expected);
  });
}
