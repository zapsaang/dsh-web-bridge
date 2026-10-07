import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rejectConnectionNominations } from '../../src/lib/headers.js';

for (const name of ['Host', 'Origin', 'Cookie', 'Authorization', 'Cf-Access-Jwt-Assertion',
  'Sec-Fetch-Mode', 'Sec-Fetch-Unknown', 'Sec-WebSocket-Key', 'Sec-WebSocket-Unknown']) {
  test(`T-U2 rejects protected ${name} before a caller can forward`, () => {
    // Given
    const headers = ['Connection', 'keep-alive', 'connection', ` X-Harmless, ${name.toUpperCase()} `];
    let upstreamCalls = 0;
    // When / Then: rejection interrupts the caller before upstream.
    assert.throws(() => {
      rejectConnectionNominations(headers);
      upstreamCalls++;
    }, { name: 'ConnectionNominationError' });
    assert.equal(upstreamCalls, 0);
  });
}
for (const headers of [[], ['Connection', 'X-Harmless, keep-alive'], ['Origin', 'https://example.com']]) {
  test(`T-U2 permits harmless nominations when headers are ${JSON.stringify(headers)}`, () => {
    // Given / When / Then
    assert.doesNotThrow(() => rejectConnectionNominations(headers));
  });
}
