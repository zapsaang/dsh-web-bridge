import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createBootstrapResponse } from '../../src/lib/bootstrap.js';

test('T-U10 produces fixed bootstrap script with independently verified CSP', () => {
  // Given / When
  const response = createBootstrapResponse('dsh-auth-native=opaque; Secure');
  // Then
  const match = /<script>([\s\S]*?)<\/script>/.exec(response.body);
  assert.ok(match);
  const script = match[1];
  assert.equal(script, "location.replace('/?__dsh_bridge_retry=1');");
  assert.equal('sha256-' + createHash('sha256').update(script).digest('base64'),
    'sha256-fzR2DpUp+SGGmfdsTMFXcRfMU2s3ZuPDzG6rEFV1qWY=');
  assert.equal(response.headers['content-security-policy'], "default-src 'none'; script-src 'sha256-fzR2DpUp+SGGmfdsTMFXcRfMU2s3ZuPDzG6rEFV1qWY='; base-uri 'none'");
  const outside = response.body.replace(/<script>[\s\S]*?<\/script>/, '');
  assert.match(outside, /<p>[^<]+<a href="\/">/);
  assert.doesNotMatch(outside, /<noscript|nonce|http-equiv|refresh/i);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['set-cookie'], 'dsh-auth-native=opaque; Secure');
  assert.equal(response.body.includes('opaque'), false);
});
