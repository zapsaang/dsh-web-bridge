import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { CredentialSeam } from './dependencies.js';
import { cookiePair, isolated, send } from './harness.js';

// §2.3/2.4: browser-auth.ts 20, 161-178, 210-215, 287-299.
test('T-DSH10 preserves the loaded secret and process token when Connection reloads before rotation', async () => {
  // Given
  await using app = await isolated();
  const cookie = cookiePair(await app.exchange());
  const token = app.token();
  // When
  await app.reload();
  const response = await send(app.port, { headers: { cookie } });
  // Then
  assert.equal(response.status, 200);
  assert.ok(app.token() === token, 'same root reload preserves process token');
});

for (const reactivate of [false, true]) {
  test(`T-DSH6/T-DSH10 ${reactivate ? 'rejects' : 'accepts'} old cookie when secret rotates ${reactivate ? 'with' : 'without'} reactivation`, async () => {
    // Given
    await using app = await isolated();
    const cookie = cookiePair(await app.exchange());
    await app.ctx.credentials.modifyRecord(CredentialSeam.credentialKey('client-connection', 'browser-session'), async () => ({
      kind: 'grant', payload: { version: 1, secret: randomBytes(32).toString('base64url') },
    }));
    if (reactivate) await app.reload();
    // When
    const response = await send(app.port, { headers: { cookie } });
    // Then
    assert.equal(response.status, reactivate ? 401 : 200);
  });
}

test('T-DSH6 restores authentication when a new exchange follows rotation and reactivation', async () => {
  // Given
  await using app = await isolated();
  await app.exchange();
  await app.ctx.credentials.modifyRecord(CredentialSeam.credentialKey('client-connection', 'browser-session'), async () => ({
    kind: 'grant', payload: { version: 1, secret: randomBytes(32).toString('base64url') },
  }));
  await app.reload();
  // When
  const exchanged = await app.exchange();
  const response = await send(app.port, { headers: { cookie: cookiePair(exchanged) } });
  // Then
  assert.equal(exchanged.status, 303);
  assert.equal(response.status, 200);
});
