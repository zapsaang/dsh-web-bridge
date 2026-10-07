import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasRetryMarker, shouldExchange, stripRetryMarker } from '../../src/lib/bridge.js';

for (const [target, expected] of [
  ['/?__dsh_bridge_retry', '/'], ['/?__dsh_bridge_retry=0', '/'],
  ['/?__dsh_bridge_retry=1&__dsh_bridge_retry=2', '/'],
  ['/?%5f_dsh_bridge_retry=x', '/'],
  ['/api?x=%2f&__dsh_bridge_retry=1&x=+&x=%20&bare', '/api?x=%2f&x=+&x=%20&bare'],
  ['/?__dsh_bridge_retry=&a=1', '/?a=1'], ['/?a=1&__dsh_bridge_retry', '/?a=1'],
  ['/?a=1&&__dsh_bridge_retry&b=2&', '/?a=1&&b=2&'],
] as const) {
  test(`T-U7 removes all marker bytes only when ${target}`, () => {
    // Given / When / Then
    assert.equal(hasRetryMarker(target), true);
    assert.equal(stripRetryMarker(target), expected);
  });
}
for (const target of ['/', '/?', '/?x=__dsh_bridge_retry', '/?__DSH_bridge_retry=1', '/?x=%2f&x=+&&', '/??__dsh_bridge_retry=1']) {
  test(`T-U7 preserves unmarked raw query ${target}`, () => {
    // Given / When / Then
    assert.equal(hasRetryMarker(target), false);
    assert.equal(stripRetryMarker(target), target);
  });
}
for (const method of ['GET', 'POST', 'HEAD']) {
  for (const target of ['/?__dsh_bridge_retry=anything', '/api?__dsh_bridge_retry', '/asset?__dsh_bridge_retry=1']) {
    test(`T-U7 suppresses exchange on marked ${method} ${target}`, () => {
      // Given / When / Then
      assert.equal(shouldExchange({ method, target, rawHeaders: ['Accept', 'text/html'] }, 401), false);
    });
  }
}
test('T-U7 allows unmarked eligible root to exchange', () => {
  // Given / When / Then
  assert.equal(shouldExchange({ method: 'GET', target: '/?x=%2f', rawHeaders: ['Accept', 'text/html'] }, 401), true);
});
