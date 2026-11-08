import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterHopByHopHeaders, stripRequestAuthorization, stripSensitiveProxyHeaders } from '../../src/lib/headers.js';

for (const direction of ['request', 'response']) {
  test(`T-U1 filters static and nominated hop-by-hop fields when processing ${direction}`, () => {
    // Given: duplicates, wire casing, and end-to-end credentials must survive
    // unless a protocol rule or a nomination removes them.
    const headers = ['Host', 'Mixed.Example.com', 'Connection', 'X-Hop, keep-alive',
      'cOnNeCtIoN', 'X-Other', 'X-Hop', 'gone', 'x-other', 'gone',
      'Keep-Alive', 'x', 'Proxy-Authenticate', 'x', 'Proxy-Authorization', 'x',
      'TE', 'x', 'Trailer', 'x', 'Transfer-Encoding', 'x', 'Upgrade', 'x',
      'Cf-Access-Jwt-Assertion', 'jwt', 'Authorization', 'Basic dXNlcjpwYXNz',
      'Cookie', 'CF_Authorization=opaque; a=1', 'Set-Cookie', 'a=1', 'set-cookie', 'b=2', 'X-End', ' A '];
    const before = [...headers];
    // When
    const result = filterHopByHopHeaders(headers);
    // Then: hop-by-hop fields are gone, while credentials are left for their
    // own direction-specific step.
    assert.deepEqual(result, ['Host', 'Mixed.Example.com',
      'Cf-Access-Jwt-Assertion', 'jwt', 'Authorization', 'Basic dXNlcjpwYXNz',
      'Cookie', 'CF_Authorization=opaque; a=1',
      'Set-Cookie', 'a=1', 'set-cookie', 'b=2', 'X-End', ' A ']);
    assert.deepEqual(headers, before);
  });
}

test('T-U1 strips proxy identity credentials in both directions without touching Authorization', () => {
  // Given / When
  const result = stripSensitiveProxyHeaders(['Cf-Access-Jwt-Assertion', 'jwt', 'cf-access-jwt-assertion', 'jwt2',
    'Authorization', 'Basic x', 'Cookie', 'a=b']);
  // Then
  assert.deepEqual(result, ['Authorization', 'Basic x', 'Cookie', 'a=b']);
});

test('T-U1 strips Authorization only when the caller asks for the request direction', () => {
  // Given / When
  const result = stripRequestAuthorization(['Authorization', 'Basic x', 'authorization', 'Bearer y',
    'Cf-Access-Jwt-Assertion', 'jwt', 'Cookie', 'a=b']);
  // Then: the proxy credential is gone, the response-direction policy stays intact.
  assert.deepEqual(result, ['Cf-Access-Jwt-Assertion', 'jwt', 'Cookie', 'a=b']);
});
