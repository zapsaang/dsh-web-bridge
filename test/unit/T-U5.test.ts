import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureSecure } from '../../src/lib/cookie.js';

for (const value of ['dsh-auth-native=x; Path=/', 'dsh-auth-native=; Max-Age=0',
  'dsh-auth-native=x; NotSecure', 'dsh-auth-native=x; x-Secure', 'dsh-auth-native=x; extension=secure']) {
  test(`T-U5 appends exactly Secure when native cookie ${value}`, () => {
    // Given / When
    const result = ensureSecure(value);
    // Then: name and every original byte stay intact, no extra policy fields.
    assert.equal(result, value + '; Secure');
    assert.equal(ensureSecure(result), result);
  });
}
for (const value of ['dsh-auth-native=x; Secure', 'dsh-auth-native=x; sEcUrE',
  'dsh-auth-native=x; Secure=yes', 'foreign=x; Path=/', '__Host-dsh-auth-native=x', 'CF_Authorization=x']) {
  test(`T-U5 preserves cookie when Secure exists or name is foreign: ${value}`, () => {
    // Given / When / Then
    assert.equal(ensureSecure(value), value);
  });
}
