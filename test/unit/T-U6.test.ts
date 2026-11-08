import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRequest, createRejectionResponse, isCanonicalAuthority, isOriginFormTarget, validateAuthorities } from '../../src/lib/bridge.js';

// The authority rule is DSH's `assertTrustedAuthority` rule: an entry must
// survive WHATWG parsing unchanged, case aside. Nothing stricter is added here,
// so uppercase, a trailing dot, wildcard characters, underscores, and `:0` are
// legal entries; rewrites and refusals are not.

for (const authority of ['example.com', 'xn--bcher-kva.example', 'a-b.example',
  'a'.repeat(63) + '.com', ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.'),
  'DSH.Example.COM', 'example.com.', '*.example.com', 'a_b.example.com', '-lead.example.com',
  'localhost', 'localhost:8080', '127.0.0.1', '127.0.0.1:8080', '192.168.1.10:8443',
  'example.com:0', 'example.com:80', 'example.com:443', 'example.com:8443', '[::1]', '[::1]:8443']) {
  test(`T-U6 accepts canonical authority ${authority}`, () => {
    // Given / When / Then
    assert.equal(isCanonicalAuthority(authority), true);
  });
}
for (const authority of ['', 'example.com:080', 'example.com:', 'example.com:65536',
  'user@example.com', 'example.com/path', 'bücher.example', '%65xample.com',
  '127.1', '0x7f.0.0.1', '[0:0:0:0:0:0:0:1]', '::1', ' exa mple.com', 'example.com\\x']) {
  test(`T-U6 rejects noncanonical authority ${JSON.stringify(authority)}`, () => {
    // Given / When / Then
    assert.equal(isCanonicalAuthority(authority), false);
  });
}
for (const [authorities, expected] of [
  [[], false], [['example.com'], true], [['Example.com'], true],
  [['*.example.com'], true], [['bücher.example'], false],
] as const) {
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
// Host admission parses the wire value exactly like DSH: WHATWG normalization
// decides the hostname, a bare authority covers any port, and an explicit-port
// authority is exact. Malformed values (what URL parsing refuses) are 400.
for (const [rawHeaders, target, authorities, expected] of [
  [['Host', 'ExAmPlE.com'], '/', ['example.com'], undefined],
  [['Host', 'other.com'], '/', ['example.com'], 403],
  [[], '/', ['example.com'], 400],
  // Node keeps the first duplicate Host and DSH parses that same value.
  [['Host', 'example.com', 'host', 'example.com'], '/', ['example.com'], undefined],
  [['Host', 'example.com', 'host', 'other.com'], '/', ['example.com'], undefined],
  [['Host', 'other.com', 'host', 'example.com'], '/', ['example.com'], 403],
  [['Host', 'example.com:443'], '/', ['example.com'], undefined],
  [['Host', 'example.com:8443'], '/', ['example.com'], undefined],
  [['Host', 'example.com:0'], '/', ['example.com'], undefined],
  [['Host', 'example.com'], '/', ['example.com:8443'], 403],
  [['Host', 'example.com:8443'], '/', ['example.com:8443'], undefined],
  [['Host', 'example.com.'], '/', ['example.com'], 403],
  [['Host', 'example.com.'], '/', ['example.com.'], undefined],
  [['Host', 'bücher.example'], '/', ['xn--bcher-kva.example'], undefined],
  [['Host', '[0:0:0:0:0:0:0:1]'], '/', ['[::1]'], undefined],
  [['Host', 'user@example.com'], '/', ['example.com'], undefined],
  [['Host', 'example.com/path'], '/', ['example.com'], undefined],
  [['Host', 'localhost:8080'], '/', ['localhost:8080'], undefined],
  [['Host', '192.168.1.10:8443'], '/', ['192.168.1.10:8443'], undefined],
  [['Host', '[::1]:8443'], '/', ['[::1]:8443'], undefined],
  [['Host', 'example.com:80'], '/', ['example.com'], undefined],
  [['Host', 'exa mple.com'], '/', ['example.com'], 400],
  [['Host', 'example.com:65536'], '/', ['example.com'], 400],
  [['Host', 'other.com'], '//x', ['example.com'], 400],
  [['Host', 'other.com'], '/?token=x', ['example.com'], 400],
] as const) {
  test(`T-U6 classifies raw host/target ${JSON.stringify([rawHeaders, target, authorities])}`, () => {
    // Given / When / Then
    assert.equal(classifyRequest({ method: 'GET', target, rawHeaders }, authorities), expected);
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
