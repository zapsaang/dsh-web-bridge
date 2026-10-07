import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRequest, createRejectionResponse, isCanonicalAuthority, isOriginFormTarget, validateAuthorities } from '../../src/lib/bridge.js';

for (const authority of ['example.com', 'xn--bcher-kva.example', 'a-b.example', 'a'.repeat(63) + '.com',
  ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')]) {
  test(`T-U6 accepts canonical DNS ${authority}`, () => {
    // Given / When / Then
    assert.equal(isCanonicalAuthority(authority), true);
  });
}
for (const authority of ['', 'EXAMPLE.com', '*.example.com', 'example.com:443', '127.0.0.1', '[::1]',
  'example.com.', 'user@example.com', 'example.com/path', 'example.com\\x', 'exam\u0000ple.com',
  'bücher.example', '-a.example', 'a-.example', 'a..example', 'a_b.example', 'a'.repeat(64) + '.com',
  ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(62)].join('.')]) {
  test(`T-U6 rejects noncanonical DNS ${JSON.stringify(authority)}`, () => {
    // Given / When / Then
    assert.equal(isCanonicalAuthority(authority), false);
  });
}
for (const [authorities, expected] of [[[], false], [['example.com'], true], [['example.com', '*.example.com'], false]] as const) {
  test(`T-U6 validates finite authority list ${JSON.stringify(authorities)}`, () => {
    // Given / When / Then
    assert.equal(validateAuthorities(authorities), expected);
  });
}
for (const target of ['/', '/api?q=%2F', '/?x=1']) {
  test(`T-U6 accepts origin-form ${target}`, () => {
    // Given / When / Then
    assert.equal(isOriginFormTarget(target), true);
  });
}
for (const target of ['', '//example.com/', 'https://example.com/', '*', 'example.com:443',
  '/#fragment', '/back\\slash', '/\u0000', '/\r\n', '/\u007f']) {
  test(`T-U6 rejects target ${JSON.stringify(target)}`, () => {
    // Given / When / Then
    assert.equal(isOriginFormTarget(target), false);
  });
}
for (const [rawHeaders, target, expected] of [
  [['Host', 'ExAmPlE.com'], '/', undefined], [['Host', 'other.com'], '/', 403],
  [[], '/', 400], [['Host', 'example.com', 'host', 'example.com'], '/', 400],
  [['Host', 'example.com:443'], '/', 400], [['Host', 'other.com'], '//x', 400],
  [['Host', 'other.com'], '/?token=x', 400],
  [['Host', '\u212a.example'], '/', 400],
] as const) {
  test(`T-U6 classifies raw host/target ${JSON.stringify([rawHeaders, target])}`, () => {
    // Given / When / Then
    assert.equal(classifyRequest({ method: 'GET', target, rawHeaders }, ['example.com']), expected);
  });
}
test('T-U6 rejects unapproved Host with generic no-store response', () => {
  // Given / When
  const status = classifyRequest({ method: 'GET', target: '/', rawHeaders: ['Host', 'secret.example'] }, []);
  // Then
  assert.equal(status, 403);
  const response = createRejectionResponse(403);
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.includes('secret.example'), false);
});
