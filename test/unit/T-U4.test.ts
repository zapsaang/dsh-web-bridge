import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateExchangeSetCookie } from '../../src/lib/cookie.js';

const cookie = 'dsh-auth-native=opaque_-.~!#$%&\'()*+:<>?@[]^`{|}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT';
const valid = [cookie, cookie.replace('Strict', 'sTrIcT'), cookie.replace('HttpOnly', 'hTtPoNlY'),
  cookie + '; Secure', cookie + '; sEcUrE', cookie + '; NotSecure; x-Secure; Extension=secure',
  cookie.replace('Max-Age=1', 'Max-Age=999999999999999999999999'),
  cookie.replace('dsh-auth-native', 'dsh-auth-!#$%&\'*+-.^_`|~')];
for (const [index, value] of valid.entries()) {
  test(`T-U4 accepts valid opaque cookie ${index} preserving bytes`, () => {
    // Given / When / Then
    assert.equal(validateExchangeSetCookie(['set-cookie', value]), value);
  });
}
const invalid = [
  cookie.replace('dsh-auth-native', 'foreign'), cookie.replace('dsh-auth-native', 'dsh-auth-bad:name'),
  ...['', '"opaque"', 'has space', 'a,b', 'a\\b', 'é'].map(value => cookie.replace(/=opaque[^;]*/, `=${value}`)),
  ...['1foo', '+1', '-1', '1.5', '0', '01', ''].map(value => cookie.replace('Max-Age=1', `Max-Age=${value}`)),
  cookie.replace('; HttpOnly', ''), cookie.replace('HttpOnly', 'HttpOnly=yes'), cookie + '; Secure=yes',
  cookie.replace('Path=/', 'Path=/other'), cookie.replace('; Path=/', ''),
  cookie.replace('SameSite=Strict', 'SameSite=Lax'), cookie.replace('; SameSite=Strict', ''),
  cookie.replace('; Max-Age=1', ''), cookie.replace(/; Expires=.*/, ''),
  ...['Thu, 21 Oct 2015 07:28:00 GMT', 'Wed, 32 Oct 2015 07:28:00 GMT',
    'Wed, 21 Oct 2015 25:28:00 GMT', 'Wed, 21 Oct 2015 07:28:00 UTC',
    'Sun, 31 Feb 2016 07:28:00 GMT', 'Wednesday, 21-Oct-15 07:28:00 GMT']
    .map(value => cookie.replace(/Expires=.*/, `Expires=${value}`)),
  cookie + '; Domain', cookie + '; Domain=example.com',
  ...['Path=/', 'httponly', 'samesite=Strict', 'MAX-AGE=1', 'Expires=Wed, 21 Oct 2015 07:28:00 GMT',
    'Secure; secure', 'Unknown=1; unknown=2'].map(value => cookie + `; ${value}`),
  cookie + ', dsh-auth-other=x', cookie + '\r\n folded', cookie + '; Extension=\u0000',
];
for (const [index, value] of invalid.entries()) {
  test(`T-U4 rejects invalid exchange cookie ${index}`, () => {
    // Given / When / Then
    assert.equal(validateExchangeSetCookie(['Set-Cookie', value]), undefined);
  });
}
