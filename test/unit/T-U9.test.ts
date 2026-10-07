import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactLogContext } from '../../src/lib/bridge.js';

const secrets = ['SYNTHETIC_TOKEN_7c4381', 'SYNTHETIC_COOKIE_805ec9', 'SYNTHETIC_JWT_42caa7'];
const uniqueFragments = ['TOKEN_7c4381', 'COOKIE_805ec9', 'JWT_42caa7'];
const contexts: readonly unknown[] = [
  ...secrets, `https://example.com/?token=${secrets[0]}`,
  { token: secrets[0], cookie: secrets[1], JWT: secrets[2] },
  ['Cookie', `dsh-auth-x=${secrets[1]}`, 'Cf-Access-Jwt-Assertion', secrets[2]],
  new Error(`failed https://example.com/?token=${secrets[0]}`),
  { stack: `Error: ${secrets[0]}\n at secret-bearing URL ${secrets[1]}` },
];
for (const [index, context] of contexts.entries()) {
  test(`T-U9 discards untrusted diagnostic context ${index}`, () => {
    // Given / When
    const output = redactLogContext(context);
    // Then: meaningful sentinels, not arbitrary single-byte overlap.
    for (const secret of [...secrets, ...uniqueFragments]) assert.equal(output.includes(secret), false);
    for (const field of ['token', 'cookie', 'JWT', 'https://', 'stack', 'Cf-Access']) assert.equal(output.includes(field), false);
    assert.ok(output.length > 0);
  });
}
