import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterHopByHopHeaders } from '../../src/lib/headers.js';

for (const direction of ['request', 'response']) {
  test(`T-U1 filters static and nominated fields when processing ${direction}`, () => {
    // Given: duplicates and wire casing must survive unless filtered.
    const headers = ['Host', 'Mixed.Example.com', 'Connection', 'X-Hop, keep-alive',
      'cOnNeCtIoN', 'X-Other', 'X-Hop', 'gone', 'x-other', 'gone',
      'Keep-Alive', 'x', 'Proxy-Authenticate', 'x', 'Proxy-Authorization', 'x',
      'TE', 'x', 'Trailer', 'x', 'Transfer-Encoding', 'x', 'Upgrade', 'x',
      'Cf-Access-Jwt-Assertion', 'jwt', 'Cookie', 'CF_Authorization=opaque; a=1',
      'Set-Cookie', 'a=1', 'set-cookie', 'b=2', 'X-End', ' A '];
    const before = [...headers];
    // When
    const result = filterHopByHopHeaders(headers);
    // Then
    assert.deepEqual(result, ['Host', 'Mixed.Example.com', 'Cookie', 'CF_Authorization=opaque; a=1',
      'Set-Cookie', 'a=1', 'set-cookie', 'b=2', 'X-End', ' A ']);
    assert.deepEqual(headers, before);
  });
}
