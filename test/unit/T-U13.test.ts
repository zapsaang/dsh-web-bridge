import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendVia, hasKnownValidContentLength } from '../../src/lib/bridge.js';

test('T-U13: appendVia appends standard Via header when absent', () => {
  const headers = ['Host', 'example.com', 'Accept', '*/*'];
  const result = appendVia(headers);
  assert.deepEqual(result, ['Host', 'example.com', 'Accept', '*/*', 'Via', '1.1 dsh-web-bridge']);
});

test('T-U13: appendVia appends to single existing Via header', () => {
  const headers = ['Host', 'example.com', 'Via', '1.0 proxy-a'];
  const result = appendVia(headers);
  assert.deepEqual(result, ['Host', 'example.com', 'Via', '1.0 proxy-a, 1.1 dsh-web-bridge']);
});

test('T-U13: appendVia merges multiple existing Via headers in order', () => {
  const headers = ['Via', '1.0 proxy-a', 'Host', 'example.com', 'via', '1.1 proxy-b'];
  const result = appendVia(headers);
  assert.deepEqual(result, ['Host', 'example.com', 'Via', '1.0 proxy-a, 1.1 proxy-b, 1.1 dsh-web-bridge']);
});

test('T-U13: hasKnownValidContentLength admits valid Content-Length for non-204/1xx and non-chunked', () => {
  assert.equal(hasKnownValidContentLength(['Content-Length', '42'], 403), true);
  assert.equal(hasKnownValidContentLength(['content-length', '0'], 200), true);
  assert.equal(hasKnownValidContentLength(['Content-Length', '100'], 401), true);
  assert.equal(hasKnownValidContentLength(['Content-Length', '100'], 304), true);
});

test('T-U13: hasKnownValidContentLength rejects 204 No Content even with Content-Length', () => {
  assert.equal(hasKnownValidContentLength(['Content-Length', '0'], 204), false);
  assert.equal(hasKnownValidContentLength(['Content-Length', '42'], 204), false);
});

test('T-U13: hasKnownValidContentLength rejects 1xx Informational', () => {
  assert.equal(hasKnownValidContentLength(['Content-Length', '0'], 100), false);
});

test('T-U13: hasKnownValidContentLength rejects chunked / streamed Transfer-Encoding', () => {
  assert.equal(hasKnownValidContentLength(['Transfer-Encoding', 'chunked', 'Content-Length', '42'], 200), false);
  assert.equal(hasKnownValidContentLength(['transfer-encoding', 'gzip, chunked'], 502), false);
});

test('T-U13: hasKnownValidContentLength rejects absent, multiple, or non-numeric Content-Length', () => {
  assert.equal(hasKnownValidContentLength([], 403), false);
  assert.equal(hasKnownValidContentLength(['Content-Length', '-1'], 403), false);
  assert.equal(hasKnownValidContentLength(['Content-Length', 'abc'], 403), false);
  assert.equal(hasKnownValidContentLength(['Content-Length', '10', 'Content-Length', '20'], 403), false);
});
