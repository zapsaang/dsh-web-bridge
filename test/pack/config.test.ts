import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../../src/dsh/index.js';

test('configuration rejects extra keys when the required fields are otherwise valid', () => {
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

// Entries follow DSH's trustedHosts rule, so anything DSH would accept is
// accepted here, normalized to DSH's canonical form.
for (const [input, expected] of [
  [['dsh.example.com'], ['dsh.example.com']],
  [['DSH.Example.COM'], ['dsh.example.com']],
  [['dsh.example.com.'], ['dsh.example.com.']],
  [['*.example.com'], ['*.example.com']],
  [['a_b.example.com'], ['a_b.example.com']],
  [['dsh.example.com:0'], ['dsh.example.com:0']],
  [['dsh.example.com:443'], ['dsh.example.com:443']],
  [['dsh.example.com:8443'], ['dsh.example.com:8443']],
  [['localhost'], ['localhost']],
  [['localhost:8080'], ['localhost:8080']],
  [['127.0.0.1'], ['127.0.0.1']],
  [['127.0.0.1:8080'], ['127.0.0.1:8080']],
  [['192.168.1.10:8443'], ['192.168.1.10:8443']],
  [['[::1]'], ['[::1]']],
  [['[::1]:8443'], ['[::1]:8443']],
  [['dsh.example.com', 'dsh.example.com'], ['dsh.example.com', 'dsh.example.com']],
] as const) {
  test(`configuration accepts ${JSON.stringify(input)} as ${JSON.stringify(expected)}`, () => {
    // Given / When
    const output = Config({ authorities: [...input] });
    // Then
    assert.deepEqual(output.authorities, [...expected]);
  });
}

const invalidAuthorities: Array<string[] | undefined> = [
  undefined,
  [],
  [''],
  ['dsh.example.com:080'],
  ['dsh.example.com:'],
  ['dsh.example.com:65536'],
  ['user@dsh.example.com'],
  ['dsh.example.com/path'],
  ['bücher.example'],
  ['%65xample.com'],
  ['127.1'],
  ['[0:0:0:0:0:0:0:1]'],
  ['::1'],
  [' dsh.example.com'],
];
for (const authorities of invalidAuthorities) {
  test(`configuration rejects invalid authorities when supplied as ${JSON.stringify(authorities)}`, () => {
    // Given
    const input = authorities === undefined ? {} : { authorities };
    // When / Then
    assert.throws(() => Config(input), TypeError);
  });
}

test('configuration explains how to supply the now-required authorities', () => {
  // Given / When / Then
  assert.throws(
    () => Config({ socketPath: '/run/dsh-web/test.sock' }),
    (error: unknown) => error instanceof Error && /add a bridge overlay with authorities/.test(error.message),
  );
});
