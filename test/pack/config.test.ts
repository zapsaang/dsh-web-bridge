import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../../src/dsh/index.js';

test('configuration rejects extra keys when the two required fields are otherwise valid', () => {
  // Given
  const input = { socketPath: '/run/dsh-web/test.sock', authorities: ['dsh.example.com'], identity: 'unexpected' };
  // When / Then
  assert.throws(() => Config(input), TypeError);
});

test('configuration supplies the socket default when authorities are provided', () => {
  // Given
  const input = { authorities: ['dsh.example.com'] };
  // When
  const output = Config(input);
  // Then
  assert.deepEqual(output, {
    socketPath: '/run/dsh-web/session-bridge.sock',
    authorities: input.authorities,
    socketAccess: 'strict',
  });
});

for (const authorities of [undefined, [], [''], ['Dsh.example.com'], ['127.0.0.1'], ['dsh.example.com:443'], ['*.example.com']]) {
  test(`configuration rejects invalid authorities when supplied as ${JSON.stringify(authorities)}`, () => {
    // Given
    const input = authorities === undefined ? {} : { authorities };
    // When / Then
    assert.throws(() => Config(input), TypeError);
  });
}
