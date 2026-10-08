import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../../src/dsh/index.js';

test('1a: configuration accepts group when authorities are valid', () => {
  // Given
  const raw = { socketPath: '/run/dsh-web/test.sock', authorities: ['dsh.example.com'], socketAccess: 'group' };
  // When
  const normalized = Config(raw);
  // Then
  assert.deepEqual(normalized, raw);
});

test('1b: omitted socketAccess normalizes to the strict default', () => {
  // Given
  const raw = { socketPath: '/run/dsh-web/test.sock', authorities: ['dsh.example.com'] };
  // When
  const normalized = Config(raw);
  // Then: the normalized shape carries exactly three keys with the default mode
  assert.deepEqual(normalized, { ...raw, socketAccess: 'strict' });
});

test('1c: explicit strict normalizes identically to omitted socketAccess', () => {
  // Given
  const raw = { socketPath: '/run/dsh-web/test.sock', authorities: ['dsh.example.com'] };
  // When
  const explicit = Config({ ...raw, socketAccess: 'strict' });
  const omitted = Config(raw);
  // Then
  assert.deepEqual(explicit, omitted);
  assert.deepEqual(explicit, { ...raw, socketAccess: 'strict' });
});

for (const [label, socketAccess] of [
  ['an unknown string', 'lax'],
  ['a non-string', 42],
  ['explicit null', null],
] as const) {
  test(`1c: socketAccess as ${label} is rejected, never a strict fallback`, () => {
    // Given
    const raw = { socketPath: '/run/dsh-web/test.sock', authorities: ['dsh.example.com'], socketAccess };
    // When / Then
    assert.throws(() => Config(raw), TypeError);
  });
}

test('1c: unknown keys are still rejected alongside a valid socketAccess', () => {
  // Given
  const raw = { socketPath: '/run/dsh-web/test.sock', authorities: ['dsh.example.com'], socketAccess: 'group', extra: 1 };
  // When / Then
  assert.throws(() => Config(raw), TypeError);
});
