import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateExchangeSetCookie } from '../../src/lib/cookie.js';

const valid = 'dsh-auth-a=x; Path=/; HttpOnly; SameSite=Strict; Max-Age=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT';
for (const headers of [[], ['Set-Cookie', valid, 'set-cookie', valid], ['Set-Cookie', valid, 'Set-Cookie', 'foreign=y'],
  ...['dsh-auth-a', '=x', 'dsh-auth-a="x"', 'dsh-auth-a=x\u007f',
    valid + '; httponly', valid + '; Foo=x; foo=y', valid + '\n', valid + ', foreign=y']
    .map(value => ['Set-Cookie', value])]) {
  test(`T-U11 rejects malformed or multi-cookie exchange ${JSON.stringify(headers)}`, () => {
    // Given / When / Then
    assert.equal(validateExchangeSetCookie(headers), undefined);
  });
}
